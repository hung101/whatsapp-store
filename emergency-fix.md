# Emergency Fix for P2028 Transaction Timeout

## Immediate Actions (Do This Now!)

### 1. Update Your PrismaClient Configuration

Find where you create your PrismaClient instance and replace it with:

```typescript
const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 120000, // 2 minutes
    maxWait: 60000,  // 1 minute 
    isolationLevel: 'ReadCommitted',
  },
});
```

### 2. Rebuild the Project

```bash
npm run build
# or
yarn build
```

### 3. If Still Failing - Emergency Batch Sizes

If you're still getting timeouts, temporarily reduce batch sizes even further:

Edit `src/handlers/message.ts` and find the `getBatchConfig` function, then change:

```typescript
if (messageCount > 10000) {
  // Emergency mode for very large datasets
  return {
    BATCH_SIZE: 5,  // Changed from 10 to 5
    MAX_CONCURRENT_BATCHES: 1, // Changed from 2 to 1
    TIMEOUT: 60000, // 1 minute
  };
}
```

### 4. Database Optimization Check

Run these checks on your database:

```sql
-- Check if indexes exist
SHOW INDEX FROM Message WHERE Key_name = 'sessionId';
SHOW INDEX FROM Message WHERE Key_name = 'unique_message_key_per_session_id';

-- Check table size
SELECT 
  table_name,
  ROUND(((data_length + index_length) / 1024 / 1024), 2) AS 'DB Size in MB' 
FROM information_schema.tables 
WHERE table_name = 'Message';
```

### 5. Monitor Progress

The new implementation includes progress logging. Watch for:

```
{"messageCount": 15000, "msg": "Starting message sync"}
{"totalBatches": 1500, "batchSize": 10, "msg": "Processing in batches"}
{"completedBatches": 10, "totalBatches": 1500, "progress": "1%", "msg": "Batch progress"}
```

## Environment Variables Override

Add these to your `.env` file for emergency mode:

```env
WHATSAPP_STORE_EMERGENCY_MODE=true
WHATSAPP_STORE_BATCH_SIZE=5
WHATSAPP_STORE_MAX_CONCURRENT=1
WHATSAPP_STORE_TIMEOUT=60000
```

## If All Else Fails

### Option A: Skip Message History

Temporarily disable message history processing:

```typescript
// In your WhatsApp client setup
socket.ev.removeAllListeners('messaging-history.set');
```

### Option B: Process in Chunks

Stop the process, then manually sync in smaller time periods using date filters.

### Option C: Direct Database Import

Export your messages to CSV and use database-specific bulk import tools instead of going through Prisma.

## Expected Behavior After Fix

- Transactions should complete within 30-60 seconds
- You'll see progress logs every 10 batches
- Batch sizes will auto-adjust based on dataset size
- Much better memory usage 