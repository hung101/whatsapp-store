import type { BaileysEventEmitter } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma, validateChatData } from '../utils';

/**
 * Extracts a phone number from messageStubParameters and converts it to a JID.
 * messageStubParameters often contains phone numbers like ["+62 851-8316-4359"]
 */
const extractPhoneFromStubParams = (stubParams: string[] | null | undefined): string | undefined => {
  if (!stubParams || !Array.isArray(stubParams) || stubParams.length === 0) {
    return undefined;
  }
  
  // Look for a phone number pattern in the parameters
  for (const param of stubParams) {
    if (typeof param !== 'string') continue;
    
    // Remove all non-digit characters except leading +
    const cleaned = param.replace(/[^\d+]/g, '');
    // Remove leading + if present
    const digits = cleaned.replace(/^\+/, '');
    
    // Check if it looks like a phone number (at least 8 digits)
    if (digits.length >= 8 && /^\d+$/.test(digits)) {
      return `${digits}@s.whatsapp.net`;
    }
  }
  
  return undefined;
};

export default function chatHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  /**
   * Validates that both sessionId and chat id are non-empty.
   * Note: @lid IDs are allowed - the getJid function should resolve them using
   * sock.signalRepository.lidMapping.getPNForLID() from Baileys.
   */
  const isValidChat = (id: string | undefined): boolean => {
    if (!sessionId || sessionId.trim() === '') {
      return false;
    }
    if (!id || id.trim() === '') {
      return false;
    }
    return true;
  };

  /**
   * Updates Contact records that have LID as their ID when we discover the phone number mapping.
   * This handles the case where Contact events arrive before Chat events.
   */
  const updateContactWithLidMapping = async (lidJid: string, phoneNumberId: string) => {
    try {
      // Check if there's a Contact with the LID as ID
      const contactWithLid = await prisma.contact.findFirst({
        select: { pkId: true },
        where: { sessionId, id: lidJid },
      });
      
      if (contactWithLid) {
        // Check if a contact with the phone number already exists
        const existingContact = await prisma.contact.findFirst({
          select: { pkId: true },
          where: { sessionId, id: phoneNumberId },
        });
        
        if (existingContact) {
          // Phone number contact exists, delete the LID contact (it's a duplicate)
          await prisma.contact.delete({
            where: { pkId: contactWithLid.pkId },
          });
          logger.info({ lidJid, phoneNumberId }, 'Removed duplicate LID contact (phone number contact exists)');
        } else {
          // Update the LID contact to use the phone number
          await prisma.contact.update({
            where: { pkId: contactWithLid.pkId },
            data: { id: phoneNumberId },
          });
          logger.info({ lidJid, phoneNumberId }, 'Updated Contact LID to phone number');
        }
      }
    } catch (e) {
      // Silently ignore errors - this is a best-effort cleanup
      logger.debug({ lidJid, phoneNumberId, error: e }, 'Failed to update Contact with LID mapping');
    }
  };

  /**
   * Resolves a chat ID, converting LID format to phone number format when possible.
   * Returns an object with both the resolved ID and the original LID (if conversion happened).
   */
  const resolveChatId = (id: string | null | undefined, chatOrUpdate?: any): { resolvedId: string; lidJid?: string } => {
    // Convert null to undefined for consistent typing
    const originalLid = id ?? undefined;
    // console.log("chatHandler:chatOrUpdate:", chatOrUpdate);
    
    // Prefer primary number JID when id is a LID
    if (id?.endsWith('@lid')) {
      // First, check chat-level fields
      const candidate: string | undefined = chatOrUpdate?.pnJid || chatOrUpdate?.senderPn || chatOrUpdate?.jid;
      if (candidate && candidate.includes('@s.whatsapp.net')) {
        return { resolvedId: jidNormalizedUser(candidate), lidJid: originalLid };
      }
      
      // Second, try to extract from messages array (remoteJidAlt in message key or messageStubParameters)
      const messages = chatOrUpdate?.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        for (const msg of messages) {
          const msgObj = msg?.message || msg;
          const key = msgObj?.key;
          
          // Try remoteJidAlt first
          if (key?.remoteJidAlt?.includes('@s.whatsapp.net')) {
            return { resolvedId: jidNormalizedUser(key.remoteJidAlt), lidJid: originalLid };
          }
          
          // Try messageStubParameters (contains phone numbers like ["+62 851-8316-4359"])
          const stubParams = msgObj?.messageStubParameters;
          const phoneJid = extractPhoneFromStubParams(stubParams);
          if (phoneJid) {
            return { resolvedId: jidNormalizedUser(phoneJid), lidJid: originalLid };
          }
        }
      }
      
      // Try getJid function as fallback
      const jidByLid = typeof getJid === 'function' ? getJid(id || '') : undefined;
      if (jidByLid && jidByLid.includes('@s.whatsapp.net')) {
        return { resolvedId: jidNormalizedUser(jidByLid), lidJid: originalLid };
      }
    }
    
    const jidByLid = typeof getJid === 'function' ? getJid(id || '') : undefined;
    return { resolvedId: jidNormalizedUser(jidByLid ?? id!) };
  };

  const persistChatRecord = async ({
    id,
    createData,
    updateData,
  }: {
    id: string;
    createData: Record<string, any>;
    updateData: Record<string, any>;
  }) => {
    const where = { sessionId, id };
    const createPayload = { ...createData, id, sessionId };
    const updatePayload = { ...updateData };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updateResult = await prisma.chat.updateMany({
          data: updatePayload,
          where,
        });
        if (updateResult.count > 0) {
          return;
        }

        await prisma.chat.create({
          select: { pkId: true },
          data: createPayload,
        });
        return;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          continue;
        }
        throw err;
      }
    }

    logger.error(
      { id, sessionId },
      'Failed to persist chat record after repeated retries'
    );
  };

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats }) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping chats set - empty sessionId');
      return;
    }
    
    const lidMappings: Array<{ lidJid: string; phoneNumberId: string }> = [];
    
    try {
      // Filter out chats with empty id before processing
      const validChats = chats.filter((c) => c.id && c.id.trim() !== '');
      const skippedCount = chats.length - validChats.length;
      
      if (skippedCount > 0) {
        logger.info({ skippedCount }, 'Skipped chats with empty id');
      }
      
      await prisma.$transaction(async (tx) => {
        // Process chats in batches to avoid timeout
        const BATCH_SIZE = 100;
        const normalizedChats = validChats.map((c) => {
          const { resolvedId, lidJid } = resolveChatId(c.id, c);
          const transformedData = transformPrisma(c);
          const validatedData = validateChatData(transformedData);
          // Set lidJid if we resolved from LID to phone number
          if (lidJid) {
            validatedData.lidJid = lidJid;
            lidMappings.push({ lidJid, phoneNumberId: resolvedId });
          }
          return { ...validatedData, id: resolvedId };
        }).filter((c) => isValidChat(c.id));
        const existingIds = (
          await tx.chat.findMany({
            select: { id: true },
            where: { id: { in: normalizedChats.map((c) => c.id) }, sessionId },
          })
        ).map((i) => i.id);
        
        const newChats = normalizedChats.filter((c) => !existingIds.includes(c.id));
        let totalAdded = 0;
        
        for (let i = 0; i < newChats.length; i += BATCH_SIZE) {
          const batch = newChats.slice(i, i + BATCH_SIZE);
          const result = await tx.chat.createMany({
            data: batch.map((c) => ({ ...c, sessionId })),
          });
          totalAdded += result.count;
        }

        logger.info({ chatsAdded: totalAdded }, 'Synced chats');
      }, {
        timeout: 30000, // 30 seconds for this specific transaction
      });
      
      // Update any Contact records that have LID as their ID (outside transaction)
      for (const { lidJid, phoneNumberId } of lidMappings) {
        await updateContactWithLidMapping(lidJid, phoneNumberId);
      }
    } catch (e) {
      logger.error(e, 'An error occured during chats set');
    }
  };

  const upsert: BaileysEventHandler<'chats.upsert'> = async (chats) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping chats upsert - empty sessionId');
      return;
    }
    
    try {
      // Filter out chats with empty id before processing
      const validChats = chats.filter((c) => c.id && c.id.trim() !== '');
      
      // Normalize and de-duplicate by resolved id (keep the last occurrence)
      const dedupedById = new Map<string, any>();
      const lidMappings: Array<{ lidJid: string; phoneNumberId: string }> = [];
      
      for (const c of validChats) {
        const { resolvedId, lidJid } = resolveChatId(c.id, c);
        
        // Skip if resolved id is empty
        if (!isValidChat(resolvedId)) {
          continue;
        }
        
        const transformedData = transformPrisma(c);
        const validatedData = validateChatData(transformedData);
        // Set lidJid if we resolved from LID to phone number
        if (lidJid) {
          validatedData.lidJid = lidJid;
          lidMappings.push({ lidJid, phoneNumberId: resolvedId });
        }
        dedupedById.set(resolvedId, { ...validatedData, id: resolvedId });
      }

      const normalizedChats = Array.from(dedupedById.values());

      await Promise.all(
        normalizedChats.map((data) =>
          persistChatRecord({
            id: data.id,
            createData: { ...data },
            updateData: { ...data, id: undefined },
          })
        )
      );
      
      // Update any Contact records that have LID as their ID
      for (const { lidJid, phoneNumberId } of lidMappings) {
        await updateContactWithLidMapping(lidJid, phoneNumberId);
      }
    } catch (e) {
      logger.error(e, 'An error occured during chats upsert');
    }
  };

  const update: BaileysEventHandler<'chats.update'> = async (updates) => {
    // Skip if sessionId is empty
    if (!sessionId || sessionId.trim() === '') {
      logger.warn('Skipping chats update - empty sessionId');
      return;
    }
    
    for (const update of updates) {
      if (!update.id || update.id.trim() === '') {
        logger.warn({ update }, 'Skipping chat update with empty ID');
        continue;
      }
      
      try {
        const { resolvedId: chatId, lidJid } = resolveChatId(update.id, update);
        
        // Skip if resolved id is empty
        if (!isValidChat(chatId)) {
          logger.warn({ originalId: update.id }, 'Skipping chat update - resolved ID is empty');
          continue;
        }
        
        const transformedData = transformPrisma(update);
        const validatedData = validateChatData(transformedData);
        // Set lidJid if we resolved from LID to phone number
        if (lidJid) {
          validatedData.lidJid = lidJid;
        }
        
        await persistChatRecord({
          id: chatId,
          createData: { ...validatedData, id: chatId },
          updateData: {
            ...validatedData,
            id: undefined,
            unreadCount:
              typeof validatedData.unreadCount === 'number'
                ? validatedData.unreadCount > 0
                  ? { increment: validatedData.unreadCount }
                  : { set: validatedData.unreadCount }
                : undefined,
          },
        });
        
        // Update any Contact records that have LID as their ID
        if (lidJid) {
          await updateContactWithLidMapping(lidJid, chatId);
        }
      } catch (e) {
        logger.error(e, 'An error occured during chat update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('chats.upsert', upsert);
    event.on('chats.update', update);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('chats.upsert', upsert);
    event.off('chats.update', update);
    listening = false;
  };

  return { listen, unlisten };
}
