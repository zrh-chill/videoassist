import { z } from 'zod';

export const stages = ['FETCH', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'SUMMARIZE'] as const;
export const stageSchema = z.enum(stages);
export type Stage = z.infer<typeof stageSchema>;
export const statuses = ['WAITING', 'FETCHING', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'SUMMARIZING', 'COMPLETED', 'FAILED', 'CANCELED'] as const;
export type VideoStatus = typeof statuses[number];
export const createSimulationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  failStage: stageSchema.optional(),
  retryableFailure: z.boolean().default(false),
}).strict();
export const listQuerySchema = z.object({
  q: z.string().max(200).default(''),
  status: z.enum(statuses).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export interface VideoDto {
  id: string; title: string; sourceType: string; overallStatus: VideoStatus;
  currentStage: Stage | null; latestErrorCode: string | null;
  latestErrorMessage: string | null; createdAt: string; updatedAt: string;
}
export interface RunDto {
  id: string; stage: Stage; attempt: number; status: string;
  startedAt: string; finishedAt: string | null; errorCode: string | null;
  errorMessage: string | null; outputJson: string | null;
}
export interface JobDto {
  id: string; stage: Stage; status: string; attempt: number; maxAttempts: number;
  availableAt: string; cancelRequestedAt: string | null;
}
export interface VideoDetail extends VideoDto { jobs: JobDto[] }
export interface VideoPage { items: VideoDto[]; nextCursor: string | null; total: number }
export interface TaskEvent { videoId: string; status: VideoStatus; stage: Stage | null }
export interface StageInput {
  videoId: string; title: string; stage: Stage; attempt: number;
  options: { failStage?: Stage; retryableFailure?: boolean };
}
export interface StageResult { simulated: boolean; text: string }
