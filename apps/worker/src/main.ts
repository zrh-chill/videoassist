import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, initializeDatabase } from '../../../packages/database/src/client.js';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { initializeStorage } from '../../../packages/storage/src/index.js';
import { checkTools } from '../../../packages/integrations/src/ffmpeg.js';
import { Worker } from './runner.js';
import { mediaHandler } from './media-handler.js';
import { Settings } from '../../../packages/database/src/settings.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
const db = createDatabase(config.databaseUrl);
await initializeDatabase(db);
const settings = new Settings(db, config);
await checkTools(await settings.effective());
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
console.log(JSON.stringify({ event: 'worker_started', mode: 'media', concurrency: 1 }));
try { await new Worker(new Tasks(db), { execute: async (input, signal) => mediaHandler(db, await settings.effective()).execute(input, signal) }).run(shutdown.signal); }
finally { await db.$disconnect(); }
