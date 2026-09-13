import type { AppConfig } from './index.js';
import type { SettingsValues } from '../../contracts/src/settings.js';
export function configValues(c: AppConfig): Required<SettingsValues> {
  return {
    FFMPEG_PATH: c.ffmpeg, FFPROBE_PATH: c.ffprobe, YTDLP_PATH: c.ytdlp,
    S2T_BASE_URL: c.s2t.url, S2T_MODEL: c.s2t.model, S2T_API_KEY_REF: c.s2t.keyRef,
    LLM_BASE_URL: c.llm.url, LLM_MODEL: c.llm.model, LLM_API_KEY_REF: c.llm.keyRef,
    BILIBILI_COOKIE_FILE_REF: c.cookieFile ? 'file:' + c.cookieFile : '',
    UPLOAD_MAX_BYTES: c.uploadMaxBytes, DOWNLOAD_MAX_BYTES: c.downloadMaxBytes,
    AUDIO_CHUNK_MINUTES: c.audioChunkSeconds / 60, S2T_MAX_BYTES: c.s2tMaxBytes,
    SUMMARY_MAX_INPUT_TOKENS: c.summaryInputTokens, MODEL_TIMEOUT_MS: c.modelTimeoutMs, LLM_MAX_OUTPUT_TOKENS: c.llmMaxOutputTokens,
  };
}
export function withSettings(base: AppConfig, saved: SettingsValues): AppConfig {
  const values = configValues(base);
  for (const key of Object.keys(saved) as Array<keyof SettingsValues>) {
    if (!base.lockedSettings.includes(key)) Object.assign(values, { [key]: saved[key] });
  }
  return { ...base, ffmpeg: values.FFMPEG_PATH, ffprobe: values.FFPROBE_PATH, ytdlp: values.YTDLP_PATH,
    s2t: { url: values.S2T_BASE_URL, model: values.S2T_MODEL, keyRef: values.S2T_API_KEY_REF },
    llm: { url: values.LLM_BASE_URL, model: values.LLM_MODEL, keyRef: values.LLM_API_KEY_REF },
    cookieFile: values.BILIBILI_COOKIE_FILE_REF.replace(/^file:/, '') || undefined,
    uploadMaxBytes: values.UPLOAD_MAX_BYTES, downloadMaxBytes: values.DOWNLOAD_MAX_BYTES,
    audioChunkSeconds: values.AUDIO_CHUNK_MINUTES * 60, s2tMaxBytes: values.S2T_MAX_BYTES,
    summaryInputTokens: values.SUMMARY_MAX_INPUT_TOKENS, modelTimeoutMs: values.MODEL_TIMEOUT_MS,
    llmMaxOutputTokens: values.LLM_MAX_OUTPUT_TOKENS,
  };
}
