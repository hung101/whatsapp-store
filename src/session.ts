import type { AuthenticationCreds, SignalDataTypeMap } from 'baileys';
import { proto } from 'baileys';
import { BufferJSON, initAuthCreds } from 'baileys';
import { Prisma } from '.prisma/client';
import { useLogger, usePrisma } from './shared';

const fixId = (id: string) => id.replace(/\//g, '__').replace(/:/g, '-');

export async function useSession(sessionId: string) {
  const model = usePrisma().session;
  const logger = useLogger();

  const write = async (data: any, id: string) => {
    try {
      const jsonData = JSON.stringify(data, BufferJSON.replacer);
      
      try {
        JSON.parse(jsonData, BufferJSON.reviver);
      } catch (parseError) {
        logger.error(
          { id, parseError, dataLength: jsonData?.length },
          'Cannot serialize session data properly. Skipping write.'
        );
        return;
      }
      
      id = fixId(id);
      await model.upsert({
        select: { pkId: true },
        create: { data: jsonData, id, sessionId },
        update: { data: jsonData },
        where: { sessionId_id: { id, sessionId } },
      });
    } catch (e) {
      logger.error(e, 'An error occured during session write');
    }
  };

  const read = async (id: string) => {
    try {
      const result = await model.findUnique({
        select: { data: true },
        where: { sessionId_id: { id: fixId(id), sessionId } },
      });
      
      if (!result || typeof result.data === 'undefined') {
        logger.info({ id }, 'Session data not found or value is undefined');
        return null;
      }
      
      try {
        return JSON.parse(result.data, BufferJSON.reviver);
      } catch (parseError) {
        logger.error(
          { id, error: parseError, dataLength: result.data?.length }, 
          'Failed to parse session data JSON. The data might be corrupted.'
        );
        
        if (id === 'creds') {
          logger.info('Returning fresh credentials due to parsing error');
          return initAuthCreds();
        }
        
        return null;
      }
    } catch (e) {
      logger.error(e, 'An error occured during session read');
      return null;
    }
  };

  const del = async (id: string) => {
    try {
      await model.delete({
        select: { pkId: true },
        where: { sessionId_id: { id: fixId(id), sessionId } },
      });
    } catch (e) {
      // P2025: Record to delete does not exist - this is expected behavior
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        logger.debug({ id, sessionId }, 'Session record already deleted or does not exist');
        return;
      }
      logger.error(e, 'An error occured during session delete');
    }
  };

  const creds: AuthenticationCreds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const sId = `${category}-${id}`;
              tasks.push(value ? write(value, sId) : del(sId));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds'),
  };
}
