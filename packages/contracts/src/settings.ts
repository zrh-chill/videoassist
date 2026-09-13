import { z } from 'zod';
const text = z.string().trim().min(1).max(1000);
const url = text.refine(value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } });
const ref = text.regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/);
export const settingsSchema = z.object({
  FFMPEG_PATH: text, FFPROBE_PATH: text, YTDLP_PATH: text,
  S2T_BASE_URL: url, S2T_MODEL: text, S2T_API_KEY_REF: ref,
  LLM_BASE_URL: url, LLM_MODEL: text, LLM_API_KEY_REF: ref,
  BILIBILI_COOKIE_FILE_REF: z.string().max(1000).refine(v => !v || /^file:.+/.test(v)),
  UPLOAD_MAX_BYTES: z.number().int().positive().max(4 * 1024 ** 3),
  DOWNLOAD_MAX_BYTES: z.number().int().positive().max(4 * 1024 ** 3),
  AUDIO_CHUNK_MINUTES: z.number().min(0.1).max(20),
  S2T_MAX_BYTES: z.number().int().min(100000).max(50000000),
  SUMMARY_MAX_INPUT_TOKENS: z.number().int().min(4096).max(128000),
  MODEL_TIMEOUT_MS: z.number().int().min(1000).max(1800000),
  LLM_MAX_OUTPUT_TOKENS: z.number().int().min(512).max(32000),
}).partial().strict();
export type SettingsValues = z.infer<typeof settingsSchema>;
export type SettingKey = keyof SettingsValues;
export const testKindSchema = z.enum(['ffmpeg', 'ytdlp', 's2t', 'llm']);
export type TestKind = z.infer<typeof testKindSchema>;
export interface ConnectionResult { ok: boolean; message: string; checkedAt: string; configHash: string; stale?: boolean }
export interface SettingsDto {
  revision: number; fields: Array<{ key: SettingKey; value: string | number | null; source: 'environment' | 'database' | 'default'; secret: boolean; configured?: boolean; referenceType?: string }>;
  tests: Partial<Record<TestKind, ConnectionResult>>;
  storage: { dataDir: string; host: string; port: number };
}
export interface PromptDto { id: string; revision: number; name: string; body: string; createdAt: string; active: boolean }
