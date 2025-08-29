import { toNumber } from 'baileys';
import Long from 'long';
import type { MakeTransformedPrisma, MakeSerializedPrisma } from './types';

/**
 * Transform object props value into Prisma-supported types
 * Handles complex WhatsApp message structures
 */
export function transformPrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeTransformedPrisma<T> {
  // Make a shallow clone to avoid modifying the original object
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Uint8Array) {
      obj[key] = Buffer.from(val);
    } else if (typeof val === 'number' || val instanceof Long) {
      obj[key] = toNumber(val);
    } else if (typeof val === 'object' && val !== null && !Buffer.isBuffer(val)) {
      // Handle serialized Buffer objects (e.g., {type: "Buffer", data: [...]})
      if ((val as any).type === 'Buffer' && Array.isArray((val as any).data)) {
        obj[key] = Buffer.from((val as any).data);
      } else {
        // For Prisma's JSON fields, we pass the object directly
        // Prisma will properly format it for MySQL's JSON type
        obj[key] = val;
      }
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

/** Transform prisma result into JSON serializable types */
export function serializePrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeSerializedPrisma<T> {
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Buffer) {
      obj[key] = val.toJSON();
    } else if (typeof val === 'bigint' || val instanceof BigInt) {
      obj[key] = val.toString();
    } else if (typeof val === 'string') {
      // Try to parse JSON strings
      try {
        obj[key] = JSON.parse(val);
      } catch (e) {
        // If parsing fails, keep the original string
        obj[key] = val;
      }
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

/**
 * Validate message data before Prisma operations
 * This helps catch validation errors early and provides better error messages
 */
export function validateMessageData(data: any): any {
  const validated = { ...data };
  
  // List of fields that exist in the Prisma Message schema
  const validFields = [
    'sessionId', 'remoteJid', 'id', 'agentId', 'bizPrivacyStatus', 'broadcast',
    'clearMedia', 'duration', 'ephemeralDuration', 'ephemeralOffToOn', 'ephemeralOutOfSync',
    'ephemeralStartTimestamp', 'finalLiveLocation', 'futureproofData', 'ignore',
    'keepInChat', 'key', 'labels', 'mediaCiphertextSha256', 'mediaData', 'message',
    'messageC2STimestamp', 'messageSecret', 'messageStubParameters', 'messageStubType',
    'messageTimestamp', 'multicast', 'originalSelfAuthorUserJidString', 'participant',
    'paymentInfo', 'photoChange', 'pollAdditionalMetadata', 'pollUpdates', 'pushName',
    'quotedPaymentInfo', 'quotedStickerData', 'reactions', 'revokeMessageTimestamp',
    'starred', 'status', 'statusAlreadyViewed', 'statusPsa', 'urlNumber', 'urlText',
    'userReceipt', 'verifiedBizName', 'eventResponses'
  ];
  
  // Filter out unknown fields that don't exist in the schema
  const filteredFields: string[] = [];
  Object.keys(validated).forEach(key => {
    if (!validFields.includes(key)) {
      filteredFields.push(key);
      delete validated[key];
    }
  });
  
  // Log filtered fields for debugging (only if there are any)
  if (filteredFields.length > 0) {
    console.log(`[validateMessageData] Filtered out unknown fields: ${filteredFields.join(', ')}`);
  }
  
  // Ensure timestamp fields are numbers
  if (validated.messageTimestamp !== undefined) {
    if (typeof validated.messageTimestamp === 'string') {
      const numVal = parseInt(validated.messageTimestamp, 10);
      validated.messageTimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.messageTimestamp !== 'number') {
      validated.messageTimestamp = 0;
    }
  }
  
  if (validated.messageC2STimestamp !== undefined) {
    if (typeof validated.messageC2STimestamp === 'string') {
      const numVal = parseInt(validated.messageC2STimestamp, 10);
      validated.messageC2STimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.messageC2STimestamp !== 'number') {
      validated.messageC2STimestamp = 0;
    }
  }
  
  // Ensure messageSecret is a Buffer
  if (validated.messageSecret && typeof validated.messageSecret === 'string') {
    try {
      validated.messageSecret = Buffer.from(validated.messageSecret, 'base64');
    } catch (e) {
      // If base64 conversion fails, remove the field to avoid validation errors
      delete validated.messageSecret;
    }
  }
  
  // Remove undefined values that could cause Prisma validation errors
  Object.keys(validated).forEach(key => {
    if (validated[key] === undefined) {
      delete validated[key];
    }
  });
  
  return validated;
}

/**
 * Wrapper for Prisma operations that provides better error handling
 * and validation error messages
 */
export async function safePrismaOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  logger?: any
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    if (error?.code === 'P2002') {
      // Unique constraint violation
      const message = `Duplicate entry detected in ${operationName}. This usually means the data already exists.`;
      if (logger) logger.warn(message);
      throw new Error(message);
    } else if (error?.code === 'P2003') {
      // Foreign key constraint violation
      const message = `Referenced record not found in ${operationName}. Check if related records exist.`;
      if (logger) logger.error(message);
      throw new Error(message);
    } else if (error?.code === 'P2025') {
      // Record not found
      const message = `Record not found in ${operationName}.`;
      if (logger) logger.warn(message);
      throw new Error(message);
    } else if (error?.name === 'PrismaClientValidationError') {
      // Validation error - provide detailed information
      const message = `Data validation failed in ${operationName}: ${error.message}`;
      if (logger) logger.error({ error, operationName }, message);
      throw new Error(message);
    } else {
      // Generic error
      const message = `Database operation failed in ${operationName}: ${error.message}`;
      if (logger) logger.error({ error, operationName }, message);
      throw new Error(message);
    }
  }
}
