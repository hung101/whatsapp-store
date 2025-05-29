# Fixing Prisma Transaction Timeout (P2028) Error

## Problem
You're encountering the error:
```
PrismaClientKnownRequestError: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 27669 ms passed since the start of the transaction.
```

This happens when database transactions take longer than the configured timeout (default 5 seconds).

## Solutions Implemented

### 1. Configure PrismaClient with Increased Timeout

When creating your PrismaClient instance, configure it with appropriate timeout settings:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 60000, // 60 seconds (increase from default 5 seconds)
    maxWait: 30000, // 30 seconds max wait time
    isolationLevel: 'ReadCommitted', // Optional: set isolation level
  },
});
```

### 2. Batch Processing for Large Operations

The code has been optimized to process large datasets in batches:

- **Message History**: Processes messages in batches of 100
- **Chat History**: Processes chats in batches of 100
- Each batch has its own transaction with timeout configuration

### 3. Per-Transaction Timeout Configuration

Individual transactions now have specific timeouts:
- Message batch processing: 20 seconds per batch
- Message updates: 10 seconds
- Receipt updates: 10 seconds  
- Reaction updates: 10 seconds
- Chat processing: 30 seconds

## Recommendations

### For Development
```typescript
const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 30000, // 30 seconds
    maxWait: 15000, // 15 seconds
  },
});
```

### For Production
```typescript
const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 60000, // 60 seconds
    maxWait: 30000, // 30 seconds
    isolationLevel: 'ReadCommitted',
  },
  // Optional: Configure connection pool
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
```

## Database Optimization Tips

1. **Ensure Proper Indexing**
   - The schema already includes proper indexes on `sessionId`
   - Composite unique indexes help with upsert operations

2. **Monitor Database Performance**
   - Use database monitoring tools
   - Check for slow queries
   - Ensure adequate database resources

3. **Connection Pooling**
   - Configure connection pool size based on your needs
   - Monitor connection usage

4. **Batch Size Tuning**
   - Adjust `BATCH_SIZE` constants based on your data volume
   - Smaller batches = faster individual transactions
   - Larger batches = fewer total transactions

## Troubleshooting

If you still encounter timeout issues:

1. **Check Database Load**: High database load can cause slower operations
2. **Increase Timeouts**: Gradually increase timeout values
3. **Reduce Batch Sizes**: Use smaller batch sizes (50 or 25 instead of 100)
4. **Database Resources**: Ensure your database has adequate CPU/memory
5. **Network Latency**: Check network connection to database

## Monitoring

Add logging to monitor transaction performance:

```typescript
const startTime = Date.now();
await prisma.$transaction(async (tx) => {
  // Your transaction logic
}, {
  timeout: 30000,
});
const duration = Date.now() - startTime;
console.log(`Transaction completed in ${duration}ms`);
``` 