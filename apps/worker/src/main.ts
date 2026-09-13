import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, initializeDatabase } from '../../../packages/database/src/client.js';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { initializeStorage } from '../../../packages/storage/src/index.js';
import { simulationHandler } from '../../../packages/integrations/src/simulation.js';
import { Worker } from './runner.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
const db = createDatabase(config.databaseUrl);
await initializeDatabase(db);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
if (!config.simulation) {
  console.error('CONFIG_INVALID: 第一阶段仅提供模拟处理器，请设置 ENABLE_SIMULATION=true；真实媒体处理尚未接入。');
  await db.$disconnect();
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ event: 'worker_started', mode: 'simulation', concurrency: 1 }));
  try { await new Worker(new Tasks(db), simulationHandler(config.mockStageMs)).run(shutdown.signal); }
  finally { await db.$disconnect(); }
}
