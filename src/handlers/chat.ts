import type { BaileysEventEmitter } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma } from '../utils';

export default function chatHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const resolveChatId = (id: string | undefined, chatOrUpdate?: any): string => {
    // Prefer primary number JID when id is a LID
    if (id?.endsWith('@lid')) {
      const candidate: string | undefined = chatOrUpdate?.pnJid || chatOrUpdate?.senderPn || chatOrUpdate?.jid;
      if (candidate) {
        return jidNormalizedUser(candidate);
      }
    }
    const jidByLid = typeof getJid === 'function' ? getJid(id || '') : undefined;
    return jidNormalizedUser(jidByLid ?? id!);
  };

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.chat.deleteMany({ where: { sessionId } });

        // Process chats in batches to avoid timeout
        const BATCH_SIZE = 100;
        const normalizedChats = chats.map((c) => {
          const id = resolveChatId(c.id, c);
          const data = transformPrisma(c);
          return { ...data, id };
        });
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
    } catch (e) {
      logger.error(e, 'An error occured during chats set');
    }
  };

  const upsert: BaileysEventHandler<'chats.upsert'> = async (chats) => {
    try {
      // Normalize and de-duplicate by resolved id (keep the last occurrence)
      const dedupedById = new Map<string, any>();
      for (const c of chats) {
        const id = resolveChatId(c.id, c);
        const data = transformPrisma(c);
        dedupedById.set(id, { ...data, id });
      }

      const normalizedChats = Array.from(dedupedById.values());

      // Robust per-item upsert with fallback to handle rare race conditions (P2002)
      await Promise.all(
        normalizedChats.map(async (data) => {
          try {
            await prisma.chat.upsert({
              select: { pkId: true },
              create: { ...data, sessionId },
              update: { ...data, id: undefined },
              where: { sessionId_id: { id: data.id, sessionId } },
            });
          } catch (e: any) {
            if (e?.code === 'P2002') {
              // Unique constraint hit due to concurrent create elsewhere: fall back to update
              try {
                await prisma.chat.update({
                  select: { pkId: true },
                  data: { ...data, id: undefined },
                  where: { sessionId_id: { id: data.id, sessionId } },
                });
              } catch (e2: any) {
                if (e2?.code === 'P2025') {
                  // Record missing when updating -> create instead
                  await prisma.chat.create({ select: { pkId: true }, data: { ...data, sessionId } });
                } else {
                  throw e2;
                }
              }
            } else {
              throw e;
            }
          }
        })
      );
    } catch (e) {
      logger.error(e, 'An error occured during chats upsert');
    }
  };

  const update: BaileysEventHandler<'chats.update'> = async (updates) => {
    for (const update of updates) {
      if (!update.id) {
        logger.warn({ update }, 'Skipping chat update with no ID');
        continue;
      }
      
      try {
        const chatId = resolveChatId(update.id, update);
        const data = transformPrisma(update);
        
        await prisma.chat.upsert({
          select: { pkId: true },
          create: { 
            ...data,
            id: chatId,
            sessionId 
          },
          update: {
            ...data,
            id: undefined,
            unreadCount:
              typeof data.unreadCount === 'number'
                ? data.unreadCount > 0
                  ? { increment: data.unreadCount }
                  : { set: data.unreadCount }
                : undefined,
          },
          where: { sessionId_id: { id: chatId, sessionId } },
        });
      } catch (e) {
        logger.error(e, 'An error occured during chat update');
      }
    }
  };

  const del: BaileysEventHandler<'chats.delete'> = async (ids) => {
    try {
      const normalizedIds = ids.map((id) => resolveChatId(id));
      await prisma.chat.deleteMany({
        where: { id: { in: normalizedIds } },
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats delete');
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('chats.upsert', upsert);
    event.on('chats.update', update);
    event.on('chats.delete', del);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('chats.upsert', upsert);
    event.off('chats.update', update);
    event.off('chats.delete', del);
    listening = false;
  };

  return { listen, unlisten };
}
