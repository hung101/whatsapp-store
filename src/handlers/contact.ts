import type { BaileysEventEmitter } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma } from '../utils';

export default function contactHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const resolveContactId = (id: string | undefined, contact?: any): string => {
    // Prefer primary number when we get a LID id and contact carries pn/jid
    if (id?.endsWith('@lid')) {
      const candidate = (contact?.senderPn || contact?.pnJid || contact?.jid) as string | undefined;
      if (candidate) {
        return jidNormalizedUser(candidate);
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

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ contacts }) => {
    try {
      const normalizedContacts = contacts.map((c) => {
        const id = resolveContactId(c.id, c);
        const data = sanitizeContactData(transformPrisma(c));
        return { ...data, id };
      });
      const contactIds = normalizedContacts.map((c) => c.id);
      const deletedOldContactIds = (
        await prisma.contact.findMany({
          select: { id: true },
          where: { id: { notIn: contactIds }, sessionId },
        })
      ).map((c) => c.id);

      const upsertPromises = normalizedContacts
        .map((data) =>
          prisma.contact.upsert({
            select: { pkId: true },
            create: { ...data, sessionId },
            update: data,
            where: { sessionId_id: { id: data.id, sessionId } },
          })
        );

      await Promise.any([
        ...upsertPromises,
        prisma.contact.deleteMany({ where: { id: { in: deletedOldContactIds }, sessionId } }),
      ]);
      logger.info(
        { deletedContacts: deletedOldContactIds.length, newContacts: contacts.length },
        'Synced contacts'
      );
    } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const upsert: BaileysEventHandler<'contacts.upsert'> = async (contacts) => {
    try {
      const normalizedContacts = contacts.map((c) => {
        const id = resolveContactId(c.id, c);
        const data = sanitizeContactData(transformPrisma(c));
        return { ...data, id };
      });
      await Promise.any(
        normalizedContacts.map((data) =>
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
    for (const update of updates) {
      if (!update.id) {
        logger.warn({ update }, 'Skipping contact update with no ID');
        continue;
      }
      
      try {
        const contactId = resolveContactId(update.id, update);
        const transformedData = sanitizeContactData(transformPrisma(update));
        
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
