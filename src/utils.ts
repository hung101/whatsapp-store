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
