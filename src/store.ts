import type { BaileysEventEmitter, SocketConfig, WASocket } from 'baileys';
import type { PrismaClient } from '@prisma/client';
import { setLogger, setPrisma } from './shared';
import * as handlers from './handlers';

type initStoreOptions = {
  /** Prisma client instance */
  prisma: PrismaClient;
  /** Baileys pino logger */
  logger?: SocketConfig['logger'];
};

/** Initialize shared instances that will be consumed by the Store instance */
export function initStore({ prisma, logger }: initStoreOptions) {
  setPrisma(prisma);
  setLogger(logger);
}

/**
 * Creates a getJid function that uses Baileys' built-in LID to phone number mapping.
 * This function resolves @lid format JIDs to @s.whatsapp.net format using
 * socket.signalRepository.lidMapping.getPNForLID()
 */
function createGetJidFromSocket(socket: WASocket): (lid: string) => string | undefined {
  return (lid: string): string | undefined => {
    if (!lid?.endsWith('@lid')) {
      return undefined;
    }
    try {
      // Use Baileys' signalRepository.lidMapping to resolve LID to phone number
      const pn = (socket.signalRepository as any)?.lidMapping?.getPNForLID(lid) as string | undefined;
      if (pn && typeof pn === 'string') {
        // getPNForLID returns the phone number part, we need to add @s.whatsapp.net
        return pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
      }
    } catch (e) {
      // Silently ignore errors - lidMapping may not be available yet
    }
    return undefined;
  };
}

export class Store {
  private readonly chatHandler;
  private readonly messageHandler;
  private readonly contactHandler;

  constructor(sessionId: string, socket: WASocket) {
    const event = socket.ev;
    const getJid = createGetJidFromSocket(socket);
    
    this.chatHandler = handlers.chatHandler(sessionId, event, getJid);
    this.messageHandler = handlers.messageHandler(sessionId, event, getJid);
    this.contactHandler = handlers.contactHandler(sessionId, event, getJid);
    this.listen();
  }

  /** Start listening to the events */
  public listen() {
    this.chatHandler.listen();
    this.messageHandler.listen();
    this.contactHandler.listen();
  }

  /** Stop listening to the events */
  public unlisten() {
    this.chatHandler.unlisten();
    this.messageHandler.unlisten();
    this.contactHandler.unlisten();
  }
}
