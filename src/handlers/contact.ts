import type { BaileysEventEmitter } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma } from '../utils';

export default function contactHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  /**
   * Validates that both sessionId and contact id are non-empty.
   * Note: @lid IDs are allowed - the getJid function should resolve them using
   * sock.signalRepository.lidMapping.getPNForLID() from Baileys.
   */
  const isValidContact = (id: string | undefined): boolean => {
    if (!sessionId || sessionId.trim() === '') {
      return false;
    }
    if (!id || id.trim() === '') {
      return false;
    }
    return true;
  };

  /**
   * Resolves a contact ID, converting LID format to phone number format when possible.
   * Checks: contact fields, getJid function, and Chat table (lidJid mapping).
   * Note: Message-based resolution is handled by the message handler at write time.
   */
  const resolveContactId = async (id: string | undefined, contact?: any): Promise<string> => {
    // Prefer primary number when we get a LID id
    if (id?.endsWith('@lid')) {
      // First, check contact-level fields
      const candidate = (contact?.senderPn || contact?.pnJid || contact?.jid) as string | undefined;
      if (candidate && candidate.includes('@s.whatsapp.net')) {
        return jidNormalizedUser(candidate);
      }
      
      // Second, try getJid function
      const jidByLid = typeof getJid === 'function' ? getJid(id || '') : undefined;
      if (jidByLid && jidByLid.includes('@s.whatsapp.net')) {
        return jidNormalizedUser(jidByLid);
      }
      
      // Third, look up the Chat table for a mapping (lidJid -> id)
      try {
        const chatWithLid = await prisma.chat.findFirst({
          select: { id: true },
          where: { 
            sessionId, 
            lidJid: id,
            id: { endsWith: '@s.whatsapp.net' }
          },
        });
        if (chatWithLid?.id) {
          return jidNormalizedUser(chatWithLid.id);
        }
      } catch (e) {
        // Silently ignore lookup errors, fall through to default
      }
    }
    
    const jidByLid = typeof getJid === 'function' ? getJid(id || '') : undefined;
    return jidNormalizedUser(jidByLid ?? id!);
  };

  const sanitizeContactData = (raw: any) => {
    // Only keep fields that exist in the Contact model
    const allowed = ['id', 'name', 'notify', 'verifiedName', 'imgUrl', 'status'];
    const out: any = {};
    for (const k of allowed) {
      if (raw[k] !== undefined) out[k] = raw[k];
    }
    return out;
  };

  /**
   * Checks if a contact has at least one meaningful field beyond just the id.
   * Contacts with only a phone number and no name/notify/verifiedName/imgUrl/status
   * are not useful and should be skipped.
   */
  const hasContactInfo = (data: any): boolean => {
    return !!(data.name || data.notify || data.verifiedName || data.imgUrl || data.status);
  };

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ contacts }) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping contacts set - empty sessionId');
      return;
    }
    
    try {
      // Filter out contacts with empty id before processing
      const validContacts = contacts.filter((c) => c.id && c.id.trim() !== '');
      const skippedCount = contacts.length - validContacts.length;
      
      if (skippedCount > 0) {
        logger.info({ skippedCount }, 'Skipped contacts with empty id');
      }
      
      const normalizedContacts = await Promise.all(
        validContacts.map(async (c) => {
          const id = await resolveContactId(c.id, c);
          const data = sanitizeContactData(transformPrisma(c));
          return { ...data, id };
        })
      );

      // Filter out contacts with empty id or no meaningful info
      const finalContacts = normalizedContacts.filter((c) => isValidContact(c.id) && hasContactInfo(c));
      const skippedNoInfo = normalizedContacts.filter((c) => isValidContact(c.id) && !hasContactInfo(c)).length;

      if (skippedNoInfo > 0) {
        logger.info({ skippedNoInfo }, 'Skipped contacts with no useful info (no name/notify/verifiedName)');
      }

      await Promise.all(
        finalContacts.map((data) =>
          prisma.contact.upsert({
            select: { pkId: true },
            create: { ...data, sessionId },
            update: data,
            where: { sessionId_id: { id: data.id, sessionId } },
          })
        )
      );
      logger.info({ contactsProcessed: finalContacts.length }, 'Synced contacts');
    } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const upsert: BaileysEventHandler<'contacts.upsert'> = async (contacts) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping contacts upsert - empty sessionId');
      return;
    }
    
    try {
      // Filter out contacts with empty id before processing
      const validContacts = contacts.filter((c) => c.id && c.id.trim() !== '');
      
      const normalizedContacts = await Promise.all(
        validContacts.map(async (c) => {
          const id = await resolveContactId(c.id, c);
          const data = sanitizeContactData(transformPrisma(c));
          return { ...data, id };
        })
      );
      
      // Filter out contacts with empty id or no meaningful info
      const finalContacts = normalizedContacts.filter((c) => isValidContact(c.id) && hasContactInfo(c));
      
      await Promise.all(
        finalContacts.map((data) =>
          prisma.contact.upsert({
            select: { pkId: true },
            create: { ...data, sessionId },
            update: data,
            where: { sessionId_id: { id: data.id, sessionId } },
          })
        )
      );
    } catch (e) {
      logger.error(e, 'An error occured during contacts upsert');
    }
  };

  const update: BaileysEventHandler<'contacts.update'> = async (updates) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping contacts update - empty sessionId');
      return;
    }
    
    for (const update of updates) {
      if (!update.id || update.id.trim() === '') {
        logger.warn({ update }, 'Skipping contact update with empty ID');
        continue;
      }
      
      try {
        const contactId = await resolveContactId(update.id, update);
        
        // Skip if resolved id is empty
        if (!isValidContact(contactId)) {
          logger.warn({ originalId: update.id }, 'Skipping contact update - resolved ID is empty');
          continue;
        }
        
        const transformedData = sanitizeContactData(transformPrisma(update));
        
        // Skip if update has no meaningful contact info
        if (!hasContactInfo(transformedData)) {
          // Check if the contact already exists before skipping
          // If it exists, we might still want to update other fields
          const existing = await prisma.contact.findUnique({
            select: { pkId: true },
            where: { sessionId_id: { sessionId, id: contactId } },
          });
          if (!existing) {
            logger.debug({ contactId }, 'Skipping contact update with no useful info - contact does not exist');
            continue;
          }
        }
        
        await prisma.contact.upsert({
          select: { pkId: true },
          create: { 
            ...transformedData,
            id: contactId,
            sessionId 
          },
          update: transformedData,
          where: { sessionId_id: { id: contactId, sessionId } },
        });
      } catch (e) {
        logger.error(e, 'An error occured during contact update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('contacts.upsert', upsert);
    event.on('contacts.update', update);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('contacts.upsert', upsert);
    event.off('contacts.update', update);
    listening = false;
  };

  return { listen, unlisten };
}
