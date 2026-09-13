import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../packages/database/src/client.js';
import { Settings } from '../../../packages/database/src/settings.js';
import { projectRoot, type AppConfig } from '../../../packages/config/src/index.js';
import { configValues } from '../../../packages/config/src/settings.js';
import { settingsSchema, testKindSchema } from '../../../packages/contracts/src/settings.js';
import { DomainError, fingerprint, publicError } from '../../../packages/domain/src/index.js';
import { runTool } from '../../../packages/integrations/src/process.js';
import { transcribeAudio, summarizeText } from '../../../packages/integrations/src/models.js';
import { probeMedia } from '../../../packages/integrations/src/ffmpeg.js';
export function settingsRoutes(app: FastifyInstance, db: Database, base: AppConfig) {
  const settings = new Settings(db, base);
  const busy = new Set<string>();
  app.get('/api/v1/settings', () => settings.view());
  app.put('/api/v1/settings', async request => {
    const body = z.object({ revision: z.number().int().nonnegative(), values: settingsSchema }).strict().parse(request.body);
    return settings.save(body.values, body.revision);
  });
  app.get('/api/v1/prompt-versions', () => settings.prompts());
  app.post('/api/v1/prompt-versions', { bodyLimit: 128 * 1024 }, async request => {
    const body = z.object({ name: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(30000) }).strict().parse(request.body);
    return settings.createPrompt(body, z.string().min(1).max(128).parse(request.headers['idempotency-key']));
  });
  app.post('/api/v1/settings/actions/:action', async request => {
    const { action } = z.object({ action: z.string().startsWith('test-') }).parse(request.params);
    const kind = testKindSchema.parse(action.slice(5));
    if (busy.has(kind)) throw new DomainError('TEST_ACTIVE', '该连接测试正在执行，请稍候', false, 409);
    busy.add(kind);
    try {
      const effective = await settings.effective();
      const config = { ...effective, modelTimeoutMs: Math.min(effective.modelTimeoutMs, 30000), llmMaxOutputTokens: Math.min(effective.llmMaxOutputTokens, 2048) };
      const signal = AbortSignal.timeout(45000);
      let ok = true; let message = '';
      try {
        if (kind === 'ffmpeg' || kind === 'ytdlp') {
          const output = await runTool(kind === 'ffmpeg' ? config.ffmpeg : config.ytdlp, [kind === 'ffmpeg' ? '-version' : '--version'], { signal, timeoutMs: 15000 });
          if (kind === 'ffmpeg') await runTool(config.ffprobe, ['-version'], { signal, timeoutMs: 15000 });
          const version = /\d+(?:[.\-]\d+){1,3}/.exec(output)?.[0] || '可用';
          message = (kind === 'ffmpeg' ? 'FFmpeg / FFprobe' : 'yt-dlp') + ' 验证通过 · ' + version;
        } else if (kind === 's2t') {
          const file = path.join(projectRoot, 'packages/integrations/assets/connection-test.flac');
          const media = await probeMedia(file, config, signal, false);
          await transcribeAudio(file, 0, media.durationMs, config, signal);
          message = '短语音转写成功，接口和模型可用';
        } else {
          await summarizeText({ text: '连接测试：先准备音频，再转写，最后保存总结。', prompt: '忠实总结输入，只返回要求的 JSON 对象。', title: '连接测试', source: 'TEST', creator: '系统', durationMs: 3000, language: '中文', cached: (_key, execute) => execute() }, config, signal);
          message = '模型连接和结构化总结校验通过';
        }
      } catch (error) { ok = false; const safe = publicError(error); message = safe.code + '：' + safe.message; }
      const result = { ok, message, checkedAt: new Date().toISOString(), configHash: fingerprint(configValues(effective)) };
      await settings.recordTest(kind, result);
      return result;
    } finally { busy.delete(kind); }
  });
}
