import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function loadConfig(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...dotenv.parse(readEnv()), ...process.env, ...overrides };
  const schema = z.object({
    APP_HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATA_DIR: z.string().default(path.join(projectRoot, 'data')),
    ENABLE_SIMULATION: z.enum(['true', 'false']).default('false'),
    MOCK_STAGE_MS: z.coerce.number().int().min(0).max(60000).default(1500),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error('CONFIG_INVALID: 请检查 APP_HOST、APP_PORT、DATA_DIR 和模拟运行参数');
  const config = parsed.data;
  const dataDir = path.resolve(projectRoot, config.DATA_DIR);
  return {
    host: config.APP_HOST, port: config.APP_PORT, dataDir,
    databaseUrl: env.DATABASE_URL || 'file:' + path.join(dataDir, 'db', 'videoassist.sqlite').replaceAll('\\', '/'),
    simulation: config.ENABLE_SIMULATION === 'true', mockStageMs: config.MOCK_STAGE_MS,
    s2t: { url: env.S2T_BASE_URL || env.S2T_API_URL, model: env.S2T_MODEL, keyRef: env.S2T_API_KEY_REF || 'env:S2T_API_KEY' },
    llm: { url: env.LLM_BASE_URL || env.write_API_URL, model: env.LLM_MODEL || env.write_MODEL, keyRef: env.LLM_API_KEY_REF || 'env:write_API_KEY' },
  };
}
function readEnv() {
  try { return readFileSync(path.join(projectRoot, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
