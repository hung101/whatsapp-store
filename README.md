> 🚨 **NOTICE**: `baileys` which is this project relied on, has been discontinued. Thus, this project will be archived and stopped receiving updates anymore. Thanks everyone who's been part of this❤️

---

# Baileys Store

Minimal Baileys data storage for your favorite DBMS built with Prisma. This library is a simple handler for Baileys event emitter that will listen and update your data in the database

## Requirements

- **Prisma** version **4.7.x** or higher
- **Baileys** version **5.x.x** or higher

## Supported Databases

- MySQL and PostgreSQL database should support the default schema out of the box
- For CockroachDB, you need to do this small change in the schema file

```diff prisma
model Session {
  pkId      BigInt    @id @default(autoincrement())
  sessionId String
  id        String
-  data      String @db.Text
+  data      String

  @@unique([sessionId, id], map: "unique_id_per_session_id_session")
  @@index([sessionId])
}
```

- For MongoDB, you need to follow [this convention](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference?query=getdmff&page=1#mongodb-10) and update the `pkId` field. Then follow the previous CockroachDB guide
- SQLite and SQL Server database are not supported since they didn't support Prisma's `JSON` scalar type

## Installation

```bash
# Using npm
npm i @ookamiiixd/baileys-store

# Using yarn
yarn add @ookamiiixd/baileys-store
```

## Setup

Before you can actually use this library, you have to setup your database first

1. Copy the `.env.example` file from this repository or from the `node_modules` directory (should be located at `node_modules/@ookamiiixd/baileys-store/.env.example`). Rename it into `.env` and then update your [connection url](https://www.prisma.io/docs/reference/database-reference/connection-urls) in the `DATABASE_URL` field
1. Copy the `prisma` directory from this repository or from the `node_modules` directory (should be located at `node_modules/@ookamiiixd/baileys-store/prisma/`). Additionaly, you may want to update your `provider` in the `schema.prisma` file if you're not using MySQL database
1. Run your [migration](https://www.prisma.io/docs/reference/api-reference/command-reference#prisma-migrate)

## Usage

```ts
import pino from 'pino';
import makeWASocket from 'baileys';
import { PrismaClient } from '@prisma/client';
import { initStore, Store } from '@ookamiiixd/baileys-store';

const logger = pino();
const socket = makeWASocket();

// Configure Prisma client with increased transaction timeout
const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 60000, // 60 seconds (increase from default 5 seconds)
    maxWait: 30000, // 30 seconds max wait time
    isolationLevel: 'ReadCommitted', // Optional: set isolation level
  },
});

// You only need to run this once
initStore({
  prisma, // Prisma client instance
  logger, // Pino logger (Optional)
});

// Create a store and start listening to the events
const store = new Store('unique-session-id-here', socket.ev);

// That's it, you can now query from the prisma client without having to worry about handling the events
const messages = prisma.message.findMany();
```

## Transaction Timeout Issue

If you encounter the `P2028` error (transaction timeout), it's because the default transaction timeout is 5 seconds. When processing large amounts of data (like message history), transactions may take longer. You can:

1. **Increase the timeout** (shown above) - Set `timeout` to 60000ms (60 seconds) or higher
2. **Optimize database performance** - Ensure proper indexing and database optimization
3. **Batch operations** - Process data in smaller chunks if dealing with very large datasets

For production environments, consider:
- Setting `timeout` to at least 30-60 seconds
- Monitoring database performance
- Using connection pooling if needed

## Contributing

PRs, issues, suggestions, etc are welcome. Please kindly open a new issue to discuss it
