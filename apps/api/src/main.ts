import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, initializeDatabase } from '../../../packages/database/src/client.js';
import { initializeStorage } from '../../../packages/storage/src/index.js';
import { createApp } from './app.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
const db = createDatabase(config.databaseUrl);
await initializeDatabase(db);
const app = createApp(db, config);
app.addHook('onClose', async () => { await db.$disconnect(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
await app.listen({ host: config.host, port: config.port });
console.log(JSON.stringify({ event: 'api_started', url: 'http://' + config.host + ':' + config.port, simulation: config.simulation }));
