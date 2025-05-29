import type {
  BaileysEventEmitter,
  MessageUserReceipt,
  proto,
  WAMessageKey,
} from 'baileys';
import { jidNormalizedUser, toNumber } from 'baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma } from '../utils';

const getKeyAuthor = (key: WAMessageKey | undefined | null) =>
  (key?.fromMe ? 'me' : key?.participant || key?.remoteJid) || '';

export default function messageHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  // Configurable batch sizes based on environment or dataset size
  const getBatchConfig = (messageCount: number) => {
    if (messageCount > 10000) {
      // Emergency mode for very large datasets
      return {
        BATCH_SIZE: 10,
        MAX_CONCURRENT_BATCHES: 2,
        TIMEOUT: 45000, // 45 seconds
      };
    } else if (messageCount > 5000) {
      // Large dataset mode
      return {
        BATCH_SIZE: 15,
        MAX_CONCURRENT_BATCHES: 2,
        TIMEOUT: 30000, // 30 seconds
      };
    } else if (messageCount > 1000) {
      // Medium dataset mode
      return {
        BATCH_SIZE: 25,
        MAX_CONCURRENT_BATCHES: 3,
        TIMEOUT: 25000, // 25 seconds
      };
    } else {
      // Small dataset mode
      return {
        BATCH_SIZE: 50,
        MAX_CONCURRENT_BATCHES: 4,
        TIMEOUT: 20000, // 20 seconds
      };
    }
  };

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ messages, isLatest }) => {
    try {
      logger.info({ messageCount: messages.length }, 'Starting message sync');
      
      const { BATCH_SIZE, MAX_CONCURRENT_BATCHES, TIMEOUT } = getBatchConfig(messages.length);
      
      const batches = [];
      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        batches.push(messages.slice(i, i + BATCH_SIZE));
      }

      logger.info({ totalBatches: batches.length, batchSize: BATCH_SIZE }, 'Processing in batches');

      // Process batches with limited concurrency
      for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
        const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
        
        await Promise.all(
          currentBatches.map(async (batch, batchIndex) => {
            const actualBatchIndex = i + batchIndex;
            try {
              await prisma.$transaction(async (tx) => {
                // Use createMany where possible for better performance
                const messagesToCreate = [];
                const messagesToUpdate = [];

                for (const message of batch) {
                  const transformedMessage = {
                    ...transformPrisma(message),
                    remoteJid: message.key.remoteJid!,
                    id: message.key.id!,
                    sessionId,
                  };

                  // Check if message exists
                  const existing = await tx.message.findUnique({
                    where: {
                      sessionId_remoteJid_id: {
                        sessionId,
                        remoteJid: message.key.remoteJid!,
                        id: message.key.id!,
                      },
                    },
                    select: { pkId: true },
                  });

                  if (existing) {
                    messagesToUpdate.push({
                      where: {
                        sessionId_remoteJid_id: {
                          sessionId,
                          remoteJid: message.key.remoteJid!,
                          id: message.key.id!,
                        },
                      },
                      data: transformPrisma(message),
                    });
                  } else {
                    messagesToCreate.push(transformedMessage);
                  }
                }

                // Bulk create new messages
                if (messagesToCreate.length > 0) {
                  await tx.message.createMany({
                    data: messagesToCreate,
                    skipDuplicates: true,
                  });
                }

                // Update existing messages individually (unfortunately updateMany doesn't support unique constraints)
                for (const updateOp of messagesToUpdate) {
                  await tx.message.update(updateOp);
                }

              }, {
                timeout: TIMEOUT,
                maxWait: 10000,  // 10 seconds max wait
              });

              if (actualBatchIndex % 10 === 0) {
                logger.info({ 
                  completedBatches: actualBatchIndex + 1, 
                  totalBatches: batches.length,
                  progress: `${Math.round(((actualBatchIndex + 1) / batches.length) * 100)}%`
                }, 'Batch progress');
              }
            } catch (e) {
              logger.error({ batchIndex: actualBatchIndex, error: e }, 'Error processing message batch');
              throw e; // Re-throw to stop processing
            }
          })
        );
      }
      
      logger.info({ 
        messages: messages.length, 
        batches: batches.length,
        batchSize: BATCH_SIZE 
      }, 'Successfully synced all messages');
    } catch (e) {
      logger.error(e, 'An error occured during messages set');
      throw e; // Re-throw for upstream handling
    }
  };

  const upsert: BaileysEventHandler<'messages.upsert'> = async ({ messages, type }) => {
    switch (type) {
      case 'append':
      case 'notify':
        for (const message of messages) {
          try {
            const jid = jidNormalizedUser(message.key.remoteJid!);
            const data = transformPrisma(message);
            await prisma.message.upsert({
              select: { pkId: true },
              create: { ...data, remoteJid: jid, id: message.key.id!, sessionId },
              update: { ...data },
              where: { sessionId_remoteJid_id: { remoteJid: jid, id: message.key.id!, sessionId } },
            });

            const chatExists = (await prisma.chat.count({ where: { id: jid, sessionId } })) > 0;
            if (type === 'notify' && !chatExists) {
              event.emit('chats.upsert', [
                {
                  id: jid,
                  conversationTimestamp: toNumber(message.messageTimestamp),
                  unreadCount: 1,
                },
              ]);
            }
          } catch (e) {
            logger.error(e, 'An error occured during message upsert');
          }
        }
        break;
    }
  };

  const update: BaileysEventHandler<'messages.update'> = async (updates) => {
    for (const { update, key } of updates) {
      try {
        await prisma.$transaction(async (tx) => {
          const prevData = await tx.message.findFirst({
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!prevData) {
            return logger.info({ update }, 'Got update for non existent message');
          }

          const data = { ...prevData, ...update } as proto.IWebMessageInfo;
          await tx.message.upsert({
            select: { pkId: true },
            where: {
              sessionId_remoteJid_id: {
                id: key.id!,
                remoteJid: key.remoteJid!,
                sessionId,
              },
            },
            create: {
              ...transformPrisma(data),
              id: data.key.id!,
              remoteJid: data.key.remoteJid!,
              sessionId,
            },
            update: {
              ...transformPrisma(data),
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        });
      } catch (e) {
        logger.error(e, 'An error occured during message update');
      }
    }
  };

  const del: BaileysEventHandler<'messages.delete'> = async (item) => {
    // try {
    //   if ('all' in item) {
    //     await prisma.message.deleteMany({ where: { remoteJid: item.jid, sessionId } });
    //     return;
    //   }

    //   const jid = item.keys[0].remoteJid!;
    //   await prisma.message.deleteMany({
    //     where: { id: { in: item.keys.map((k) => k.id!) }, remoteJid: jid, sessionId },
    //   });
    // } catch (e) {
    //   logger.error(e, 'An error occured during message delete');
    // }
  };

  const updateReceipt: BaileysEventHandler<'message-receipt.update'> = async (updates) => {
    for (const { key, receipt } of updates) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { userReceipt: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ update }, 'Got receipt update for non existent message');
          }

          let userReceipt = (message.userReceipt || []) as unknown as MessageUserReceipt[];
          const recepient = userReceipt.find((m) => m.userJid === receipt.userJid);

          if (recepient) {
            userReceipt = [...userReceipt.filter((m) => m.userJid !== receipt.userJid), receipt];
          } else {
            userReceipt.push(receipt);
          }

          await tx.message.update({
            select: { pkId: true },
            data: transformPrisma({ userReceipt: userReceipt }),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        });
      } catch (e) {
        logger.error(e, 'An error occured during message receipt update');
      }
    }
  };

  const updateReaction: BaileysEventHandler<'messages.reaction'> = async (reactions) => {
    for (const { key, reaction } of reactions) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { reactions: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ update }, 'Got reaction update for non existent message');
          }

          const authorID = getKeyAuthor(reaction.key);
          const existingReactions = (message.reactions || []) as proto.IReaction[];
          const filteredReactions = existingReactions.filter(
            (r) => r.key && getKeyAuthor(r.key) !== authorID
          );
          
          const updatedReactions = reaction.text ? [...filteredReactions, reaction] : filteredReactions;
          
          await tx.message.update({
            select: { pkId: true },
            data: transformPrisma({ reactions: updatedReactions }),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        });
      } catch (e) {
        logger.error(e, 'An error occured during message reaction update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('messages.upsert', upsert);
    event.on('messages.update', update);
    event.on('messages.delete', del);
    event.on('message-receipt.update', updateReceipt);
    event.on('messages.reaction', updateReaction);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('messages.upsert', upsert);
    event.off('messages.update', update);
    event.off('messages.delete', del);
    event.off('message-receipt.update', updateReceipt);
    event.off('messages.reaction', updateReaction);
    listening = false;
  };

  return { listen, unlisten };
}
