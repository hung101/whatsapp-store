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
    if (typeof val === 'function') {
      // Remove function properties as they cannot be serialized to JSON
      delete obj[key];
    } else if (val instanceof Uint8Array) {
      obj[key] = Buffer.from(val);
    } else if (typeof val === 'number' || val instanceof Long) {
      obj[key] = toNumber(val);
    } else if (typeof val === 'object' && val !== null && !Buffer.isBuffer(val)) {
      // Handle serialized Buffer objects (e.g., {type: "Buffer", data: [...]})
      if ((val as any).type === 'Buffer' && Array.isArray((val as any).data)) {
        // Special handling for Bytes fields like messageSecret, mediaCiphertextSha256
        if (key === 'messageSecret' || key === 'mediaCiphertextSha256') {
          obj[key] = Buffer.from((val as any).data);
        } else {
          // For JSON fields containing Buffer data, convert to base64 string
          obj[key] = Buffer.from((val as any).data).toString('base64');
        }
      } else {
        // For Prisma's JSON fields, recursively clean the object to remove functions
        obj[key] = cleanObjectForPrisma(val, key);
      }
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

/**
 * Recursively clean an object to remove functions and other non-serializable values
 * This prevents Prisma serialization errors when storing complex objects as JSON
 */
function cleanObjectForPrisma(obj: any, parentKey?: string): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  // Debug: Log when we're cleaning an object that looks like a Buffer
  if (typeof obj === 'object' && obj !== null && obj.type === 'Buffer') {
    // Log via console for immediate visibility
    console.error('[cleanObjectForPrisma] Processing Buffer-like object:', { type: obj.type, hasData: Array.isArray(obj.data) });
  }
  
  if (typeof obj === 'function') {
    return undefined; // Functions cannot be serialized
  }
  
  if (typeof obj === 'symbol') {
    return undefined; // Symbols cannot be serialized
  }
  
  if (obj instanceof Date) {
    return obj.toISOString(); // Convert dates to ISO strings
  }
  
  if (obj instanceof Buffer) {
    return obj; // Keep buffers as-is
  }
  
  // Handle objects that look like a numeric-indexed byte dictionary: {"0":83, "1":118, ...}
  if (
    typeof obj === 'object' &&
    obj !== null &&
    !Array.isArray(obj) &&
    Object.keys(obj).length > 0 &&
    Object.keys(obj).every((k) => /^\d+$/.test(k)) &&
    Object.values(obj).every((v) => typeof v === 'number')
  ) {
    try {
      const entries = Object.entries(obj)
        .map(([k, v]) => [parseInt(k, 10), v as number] as const)
        .sort((a, b) => a[0] - b[0]);
      const bytes = Uint8Array.from(entries.map(([, v]) => v));
      const b64 = Buffer.from(bytes).toString('base64');
      console.error('[cleanObjectForPrisma] Converted numeric-keyed byte object to base64', { length: bytes.length, parentKey });
      return b64;
    } catch (e) {
      console.error('[cleanObjectForPrisma] Failed to convert numeric-keyed byte object', e);
      // fall through to regular handling
    }
  }

  // Handle serialized Buffer objects (e.g., {type: "Buffer", data: [...]})
  if (typeof obj === 'object' && obj !== null && obj.type === 'Buffer' && Array.isArray(obj.data)) {
    // Debug logging for Buffer conversion
    console.error('[cleanObjectForPrisma] Converting Buffer object:', { type: obj.type, dataLength: obj.data.length, parentKey });
    // For JSON storage in Prisma, convert to base64 string instead of Buffer instance
    try {
      const buffer = Buffer.from(obj.data);
      return buffer.toString('base64');
    } catch (e) {
      console.error('[cleanObjectForPrisma] Failed to convert Buffer data to base64:', e);
      return null; // Return null if conversion fails
    }
  }
  
  // Handle Long objects from Baileys (e.g., {low: x, high: y, unsigned: z})
  if (typeof obj === 'object' && 
      typeof obj.low === 'number' && 
      typeof obj.high === 'number' && 
      typeof obj.unsigned === 'boolean') {
    return toNumber(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj
      .map(item => cleanObjectForPrisma(item, parentKey))
      .filter(item => item !== undefined); // Remove undefined items
  }
  
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Debug: Log when we encounter nested objects
      if (typeof value === 'object' && value !== null && (value as any).type === 'Buffer') {
        console.error(`[cleanObjectForPrisma] Found nested Buffer in key: ${key}`);
      }
      
      const cleanedValue = cleanObjectForPrisma(value, key);
      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return cleaned;
  }
  
  // For primitive values (string, number, boolean), return as-is
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
 * Deeply convert any BigInt values to Number to ensure JSON.stringify safety
 * and compatibility with Prisma inputs/logging.
 */
function normalizeBigIntDeep(input: any): any {
  if (input === null || input === undefined) return input;
  if (typeof input === 'bigint') return Number(input);
  if (Array.isArray(input)) return input.map((v) => normalizeBigIntDeep(v));
  if (typeof input === 'object') {
    const out: any = Array.isArray(input) ? [] : {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = normalizeBigIntDeep(v);
    }
    return out;
  }
  return input;
}

/**
 * Validate message data before Prisma operations
 * This helps catch validation errors early and provides better error messages
 */
export function validateMessageData(data: any): any {
  // First, deeply clean the entire data object to handle all nested Buffers and Long objects
  const cleanedData = cleanObjectForPrisma(data);
  // Normalize BigInt early to avoid JSON.stringify errors in diagnostics below
  let validated = normalizeBigIntDeep({ ...cleanedData });
  
  // Check if we still have Buffer objects after cleaning and log to error if found
  const cleanedDataStr = JSON.stringify(validated, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  const hasBuffersAfter = cleanedDataStr.includes('"type":"Buffer"');
  
  if (hasBuffersAfter) {
    // Force convert any remaining Buffer objects using aggressive string replacement
    try {
      const fixedJsonStr = cleanedDataStr.replace(/\{"type":"Buffer","data":\[([^\]]+)\]\}/g, (match, dataArray) => {
        try {
          const dataNumbers = dataArray.split(',').map((n: string) => parseInt(n.trim()));
          const buffer = Buffer.from(dataNumbers);
          // Convert to base64 string for JSON storage
          return `"${buffer.toString('base64')}"`;
        } catch (e) {
          return 'null'; // Fallback to null if parsing fails
        }
      });
      
      const finalData = JSON.parse(fixedJsonStr);
      Object.assign(validated, finalData);
    } catch (parseError) {
      // If JSON parsing still fails, log the error and continue with the original data
      console.error('[validateMessageData] Failed to fix Buffer serialization, using original data');
    }
  }
  
  // List of fields that exist in the Prisma Message schema
  const validFields = [
    // Prisma internal fields
    'pkId',
    // Schema fields
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
    // console.log(`[validateMessageData] Filtered out unknown fields: ${filteredFields.join(', ')}`);
  }
  
  // Debug: Check if reportingTokenInfo is still present after filtering
  if (validated.reportingTokenInfo) {
    console.error('[validateMessageData] WARNING: reportingTokenInfo still present after filtering!');
  }
  
  // Ensure timestamp fields are numbers (avoid BigInt to prevent JSON/logging issues and match Prisma Int clients)
  if (validated.messageTimestamp !== undefined) {
    if (typeof validated.messageTimestamp === 'string') {
      const numVal = parseInt(validated.messageTimestamp, 10);
      validated.messageTimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.messageTimestamp === 'bigint') {
      validated.messageTimestamp = Number(validated.messageTimestamp);
    } else if (typeof validated.messageTimestamp !== 'number') {
      validated.messageTimestamp = 0;
    }
  }

  if (validated.messageC2STimestamp !== undefined) {
    if (typeof validated.messageC2STimestamp === 'string') {
      const numVal = parseInt(validated.messageC2STimestamp, 10);
      validated.messageC2STimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.messageC2STimestamp === 'bigint') {
      validated.messageC2STimestamp = Number(validated.messageC2STimestamp);
    } else if (typeof validated.messageC2STimestamp !== 'number') {
      validated.messageC2STimestamp = 0;
    }
  }
  
  // Ensure messageSecret is a Buffer (fallback for any missed cases)
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
 * Validate chat data before Prisma operations
 * This helps catch validation errors early and provides better error messages
 */
export function validateChatData(data: any): any {
  // First, deeply clean the entire data object to handle all nested Buffers and Long objects
  const cleanedData = cleanObjectForPrisma(data);
  const validated = { ...cleanedData };
  
  // List of fields that exist in the Prisma Chat schema
  const validFields = [
    // Prisma internal fields
    'pkId',
    // Schema fields
    'sessionId', 'archived', 'conversationTimestamp', 'createdAt', 'createdBy',
    'displayName', 'endOfHistoryTransfer', 'endOfHistoryTransferType', 'ephemeralExpiration',
    'ephemeralSettingTimestamp', 'id', 'isDefaultSubgroup', 'isParentGroup', 'lastMsgTimestamp',
    'lidJid', 'markedAsUnread', 'mediaVisibility', 'messages', 'muteEndTime', 'name',
    'newJid', 'notSpam', 'oldJid', 'pHash', 'parentGroupId', 'pinned', 'pnJid',
    'pnhDuplicateLidThread', 'readOnly', 'shareOwnPn', 'support', 'suspended',
    'tcTokenSenderTimestamp', 'tcTokenTimestamp', 'terminated', 'unreadCount',
    'unreadMentionCount', 'lastMessageRecvTimestamp'
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
    // console.log(`[validateChatData] Filtered out unknown fields: ${filteredFields.join(', ')}`);
  }
  
  // Ensure timestamp fields are numbers (avoid BigInt for compatibility)
  if (validated.conversationTimestamp !== undefined) {
    if (typeof validated.conversationTimestamp === 'string') {
      const numVal = parseInt(validated.conversationTimestamp, 10);
      validated.conversationTimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.conversationTimestamp === 'bigint') {
      validated.conversationTimestamp = Number(validated.conversationTimestamp);
    } else if (typeof validated.conversationTimestamp !== 'number') {
      validated.conversationTimestamp = 0;
    }
  }
  
  if (validated.lastMessageRecvTimestamp !== undefined) {
    if (typeof validated.lastMessageRecvTimestamp === 'string') {
      const numVal = parseInt(validated.lastMessageRecvTimestamp, 10);
      validated.lastMessageRecvTimestamp = isNaN(numVal) ? 0 : numVal;
    } else if (typeof validated.lastMessageRecvTimestamp !== 'number') {
      validated.lastMessageRecvTimestamp = 0;
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
    } else if (error?.code === 'P2034') {
      // Transaction conflict/deadlock - these should be retried by the caller
      const message = `Transaction conflict or deadlock in ${operationName}. Retry recommended.`;
      if (logger) logger.warn({ error, operationName }, message);
      // Re-throw the original error so retry logic can handle it
      throw error;
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

/**
 * Retry database operations with exponential backoff for deadlock recovery
 */
export async function retryDatabaseOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  logger?: any,
  maxRetries: number = 3,
  baseDelay: number = 100
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Only retry for specific retryable errors
      if (error?.code === 'P2034' || error?.message?.includes('deadlock') || error?.message?.includes('write conflict')) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 100; // Add jitter
          if (logger) {
            logger.warn({
              attempt,
              maxRetries,
              delay,
              error: error.code || error.name,
              operationName
            }, `Retrying ${operationName} after ${delay}ms due to ${error.code || 'database conflict'}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      // If it's not retryable or we've exhausted retries, throw the error
      throw error;
    }
  }
  
  // This should never be reached, but just in case
  throw lastError;
}
