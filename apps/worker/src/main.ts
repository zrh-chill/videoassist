import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, initializeDatabase } from '../../../packages/database/src/client.js';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { initializeStorage } from '../../../packages/storage/src/index.js';
import { checkTools } from '../../../packages/integrations/src/ffmpeg.js';
import { Worker } from './runner.js';
import { mediaHandler } from './media-handler.js';
import { Settings } from '../../../packages/database/src/settings.js';
import { OperationWorker } from './operations.js';
import { createLogger } from '../../../packages/storage/src/logging.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
const db = createDatabase(config.databaseUrl);
await initializeDatabase(db);
const settings = new Settings(db, config);
try { await checkTools(await settings.effective()); }
catch { console.warn(JSON.stringify({ event: 'media_tools_unavailable', message: '媒体工具不可用，请在设置页修复并测试连接' })); }
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
console.log(JSON.stringify({ event: 'worker_started', mode: 'media', concurrency: 1 }));
const log = createLogger(config.dataDir, 'worker');
try { await new Worker(new Tasks(db), { execute: async (input, signal) => {
  const started = Date.now();
  await log({ event: 'stage_started', jobId: input.jobId, videoId: input.videoId, stage: input.stage, attempt: input.attempt });
  try { return await mediaHandler(db, await settings.effective()).execute(input, signal); }
  finally { await log({ event: 'stage_execution_ended', jobId: input.jobId, videoId: input.videoId, stage: input.stage, durationMs: Date.now() - started }); }
} }).run(shutdown.signal, new OperationWorker(db, config)); }
finally { await db.$disconnect(); }
