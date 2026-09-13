import { z } from 'zod';
import { runTool } from './process.js';
import type { AppConfig } from '../../config/src/index.js';
import { DomainError } from '../../domain/src/index.js';

export async function probeMedia(file: string, config: AppConfig, signal?: AbortSignal, requireVideo = true) {
  const output = await runTool(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { signal, code: 'FFPROBE_FAILED', timeoutMs: 30000 });
  const parsed = z.object({ format: z.object({ duration: z.coerce.number().positive() }), streams: z.array(z.object({ codec_type: z.string() })) }).safeParse(JSON.parse(output));
  if (!parsed.success || !parsed.data.streams.some(s => s.codec_type === 'audio') || (requireVideo && !parsed.data.streams.some(s => s.codec_type === 'video'))) {
    throw new DomainError('INVALID_VIDEO_FILE', requireVideo ? '文件必须是包含音轨的有效视频' : '音频文件不可读取');
  }
  return { durationMs: Math.round(parsed.data.format.duration * 1000) };
}
export async function extractAudio(input: string, output: string, config: AppConfig, signal: AbortSignal, slice?: { start: number; duration: number }) {
  await runTool(config.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...(slice ? ['-ss', String(slice.start)] : []), '-i', input,
    ...(slice ? ['-t', String(slice.duration)] : []),
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', output],
    { signal, timeoutMs: 3600000, code: 'FFMPEG_FAILED' });
}
export async function checkTools(config: AppConfig) {
  for (const [tool, args] of [[config.ffmpeg, ['-version']], [config.ffprobe, ['-version']], [config.ytdlp, ['--version']]] as const) {
    await runTool(tool, [...args], { timeoutMs: 15000 });
  }
}
