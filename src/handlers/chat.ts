import type { BaileysEventEmitter } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma, validateChatData } from '../utils';

export default function chatHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const resolveChatId = (id: string | null | undefined, chatOrUpdate?: any): string => {
    // console.log("chatHandler:chatOrUpdate:", chatOrUpdate);
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

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.chat.deleteMany({ where: { sessionId } });

        // Process chats in batches to avoid timeout
        const BATCH_SIZE = 100;
        const normalizedChats = chats.map((c) => {
          const id = resolveChatId(c.id, c);
          const transformedData = transformPrisma(c);
          const validatedData = validateChatData(transformedData);
          return { ...validatedData, id };
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
        const transformedData = transformPrisma(c);
        const validatedData = validateChatData(transformedData);
        dedupedById.set(id, { ...validatedData, id });
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
        const transformedData = transformPrisma(update);
        const validatedData = validateChatData(transformedData);
        
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
