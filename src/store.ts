import type { BaileysEventEmitter, SocketConfig } from 'baileys';
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

export class Store {
  private readonly chatHandler;
  private readonly messageHandler;
  private readonly contactHandler;

  constructor(sessionId: string, event: BaileysEventEmitter, private getJid: Function | undefined = undefined) {
    this.chatHandler = handlers.chatHandler(sessionId, event, this.getJid);
    this.messageHandler = handlers.messageHandler(sessionId, event, this.getJid);
    this.contactHandler = handlers.contactHandler(sessionId, event, this.getJid);
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
