import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig, projectRoot } from '../packages/config/src/index.js';
import { initializeStorage } from '../packages/storage/src/index.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy',
  '--schema', path.join(projectRoot, 'packages/database/prisma/schema.prisma')], {
  cwd: projectRoot, stdio: 'inherit', shell: false,
  // Prisma 6 SQLite bootstrap can return an empty schema-engine error without this.
  // https://github.com/prisma/prisma/issues/29355
  env: { ...process.env, DATABASE_URL: config.databaseUrl, RUST_LOG: process.env.RUST_LOG || 'info' },
});
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
