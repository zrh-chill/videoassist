import { createHash } from 'node:crypto';
import type { Stage, StageInput, StageResult, VideoStatus } from '../../contracts/src/index.js';

export class DomainError extends Error {
  constructor(public code: string, message: string, public retryable = false, public httpStatus = 400) {
    super(message); this.name = 'DomainError';
  }
}
export const stageStatus: Record<Stage, VideoStatus> = {
  FETCH: 'FETCHING', EXTRACT_AUDIO: 'EXTRACTING_AUDIO', TRANSCRIBE: 'TRANSCRIBING', SUMMARIZE: 'SUMMARIZING',
};
export function nextStage(stage: Stage): Stage | null {
  return ({ FETCH: 'EXTRACT_AUDIO', EXTRACT_AUDIO: 'TRANSCRIBE', TRANSCRIBE: 'SUMMARIZE', SUMMARIZE: null } as const)[stage];
}
export function fingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
export function retryDelay(attempt: number): number {
  return [60_000, 300_000, 1_200_000][Math.min(Math.max(attempt - 1, 0), 2)]!;
}
export function publicError(error: unknown): DomainError {
  // Unexpected provider/tool errors may contain URLs, credentials and local paths.
  return error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', '处理异常，请查看服务状态后重试', false, 500);
}
export interface StageHandler {
  execute(input: StageInput, signal: AbortSignal): Promise<StageResult>;
}
