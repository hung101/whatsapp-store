import type { BaileysEventEmitter } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma } from '../utils';

export default function chatHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.chat.deleteMany({ where: { sessionId } });

        // Process chats in batches to avoid timeout
        const BATCH_SIZE = 100;
        const existingIds = (
          await tx.chat.findMany({
            select: { id: true },
            where: { id: { in: chats.map((c) => c.id) }, sessionId },
          })
        ).map((i) => i.id);
        
        const newChats = chats.filter((c) => !existingIds.includes(c.id));
        let totalAdded = 0;
        
        for (let i = 0; i < newChats.length; i += BATCH_SIZE) {
          const batch = newChats.slice(i, i + BATCH_SIZE);
          const result = await tx.chat.createMany({
            data: batch.map((c) => ({ ...transformPrisma(c), sessionId })),
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
      await Promise.any(
        chats
          .map((c) => transformPrisma(c))
          .map((data) =>
            prisma.chat.upsert({
              select: { pkId: true },
              create: { ...data, sessionId },
              update: data,
              where: { sessionId_id: { id: data.id, sessionId } },
            })
          )
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
        const chatId = update.id;
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
      await prisma.chat.deleteMany({
        where: { id: { in: ids } },
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
