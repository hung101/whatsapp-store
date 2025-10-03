import type {
  BaileysEventEmitter,
  MessageUserReceipt,
  proto,
  WAMessageKey,
} from 'baileys';
import { jidNormalizedUser, toNumber } from 'baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../types';
import { transformPrisma, validateMessageData, retryDatabaseOperation } from '../utils';

const getKeyAuthor = (key: WAMessageKey | undefined | null) =>
  (key?.fromMe ? 'me' : key?.participant || key?.remoteJid) || '';

export default function messageHandler(sessionId: string, event: BaileysEventEmitter, getJid: Function | undefined = undefined) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const resolveRemoteJid = (key: WAMessageKey): string => {
    const jidByLid = typeof getJid === 'function' ? getJid(key.id || '') : undefined;
    return jidNormalizedUser(jidByLid ?? key.remoteJid!);
  };

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
                  const jid = resolveRemoteJid(message.key);
                  const transformedMessage = {
                    ...transformPrisma(message),
                    remoteJid: jid,
                    id: message.key.id!,
                    sessionId,
                  };

                  // Check if message exists
                  const existing = await tx.message.findUnique({
                    where: {
                      sessionId_remoteJid_id: {
                        sessionId,
                        remoteJid: jid,
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
                          remoteJid: jid,
                          id: message.key.id!,
                        },
                      },
                      data: validateMessageData(transformPrisma(message)),
                    });
                  } else {
                    messagesToCreate.push(transformedMessage);
                  }
                }

                // Bulk create new messages
                if (messagesToCreate.length > 0) {
                  // Validate and transform messages before bulk insertion
                  const validatedMessages = messagesToCreate.map((msg) => validateMessageData(msg));
                  
                  // Log validation summary for bulk operations
                  const totalOriginalFields = messagesToCreate.reduce((sum, msg) => sum + Object.keys(msg).length, 0);
                  const totalValidatedFields = validatedMessages.reduce((sum, msg) => sum + Object.keys(msg).length, 0);
                  
                  if (totalOriginalFields !== totalValidatedFields) {
                    logger.info({ 
                      batchSize: messagesToCreate.length,
                      totalOriginalFields,
                      totalValidatedFields,
                      fieldsFiltered: totalOriginalFields - totalValidatedFields
                    }, 'Bulk message validation filtered out unknown fields');
                  }

                  await tx.message.createMany({
                    data: validatedMessages as any,
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
            const jid = resolveRemoteJid(message.key);
            const data = transformPrisma(message);
            
            // Validate data before upsert
            const validatedData = validateMessageData(data);
            
            // Log if any fields were filtered out during validation
            if (Object.keys(validatedData).length !== Object.keys(data).length) {
              logger.info({ 
                messageId: message.key.id,
                originalFieldCount: Object.keys(data).length,
                validatedFieldCount: Object.keys(validatedData).length
              }, 'Message data was filtered during validation');
            }
            
            await retryDatabaseOperation(
              () => prisma.message.upsert({
                select: { pkId: true },
                create: { ...validatedData, remoteJid: jid, id: message.key.id!, sessionId },
                update: { ...validatedData },
                where: { sessionId_remoteJid_id: { remoteJid: jid, id: message.key.id!, sessionId } },
              }),
              'message.upsert',
              logger
            );

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
        const jid = resolveRemoteJid(key);
        await retryDatabaseOperation(
          () => prisma.$transaction(async (tx) => {
          const prevData = await tx.message.findFirst({
            where: { id: key.id!, remoteJid: jid, sessionId },
          });
          if (!prevData) {
            return logger.info({ update }, 'Got update for non existent message');
          }

          const data = { ...prevData, ...update } as proto.IWebMessageInfo;
          const transformedData = transformPrisma(data);
          
          // Validate and filter data before upsert
          const validatedData = validateMessageData(transformedData);
          
          // Additional debug logging for Buffer issues
          if (JSON.stringify(validatedData).includes('"type":"Buffer"')) {
            logger.error({ 
              messageId: key.id,
              issue: 'Buffer objects still present after validation',
              data: validatedData
            }, 'Buffer serialization issue detected');
          }
          
          // Log if any fields were filtered out during validation
          if (Object.keys(validatedData).length !== Object.keys(transformedData).length) {
            logger.info({ 
              messageId: key.id,
              originalFieldCount: Object.keys(transformedData).length,
              validatedFieldCount: Object.keys(validatedData).length
            }, 'Message data was filtered during validation in update');
          }
          
          await tx.message.upsert({
            select: { pkId: true },
            where: {
              sessionId_remoteJid_id: {
                id: key.id!,
                remoteJid: jid,
                sessionId,
              },
            },
            create: {
              ...validatedData,
              id: data.key.id!,
              remoteJid: jid,
              sessionId,
            },
            update: {
              ...validatedData,
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        }),
        'message.update.transaction',
        logger
      );
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
        const jid = resolveRemoteJid(key);
        await retryDatabaseOperation(
          () => prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { userReceipt: true },
            where: { id: key.id!, remoteJid: jid, sessionId },
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
            data: validateMessageData(transformPrisma({ userReceipt: userReceipt })),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: jid, sessionId },
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        }),
        'message.receipt.update.transaction',
        logger
      );
      } catch (e) {
        logger.error(e, 'An error occured during message receipt update');
      }
    }
  };

  const updateReaction: BaileysEventHandler<'messages.reaction'> = async (reactions) => {
    for (const { key, reaction } of reactions) {
      try {
        const jid = resolveRemoteJid(key);
        await retryDatabaseOperation(
          () => prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { reactions: true },
            where: { id: key.id!, remoteJid: jid, sessionId },
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
            data: validateMessageData(transformPrisma({ reactions: updatedReactions })),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: jid, sessionId },
            },
          });
        }, {
          timeout: 10000, // 10 seconds
        }),
        'message.reaction.update.transaction',
        logger
      );
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
