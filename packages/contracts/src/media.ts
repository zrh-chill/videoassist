import { z } from 'zod';

export const summarySchema = z.object({
  one_sentence: z.string(), key_points: z.array(z.string()),
  detailed_summary: z.string(), keywords: z.array(z.string()),
}).strict();
export type StructuredSummary = z.infer<typeof summarySchema>;
export interface MediaArtifact {
  kind: 'SOURCE_VIDEO' | 'AUDIO'; storageKey: string; sizeBytes: number; sha256: string; mimeType: string;
}
export interface Segment { startMs: number; endMs: number; text: string }
export interface TranscriptOutput {
  fullText: string; language: string; provider: string; model: string;
  durationMs: number; timestampPrecision: 'SEGMENT' | 'CHUNK';
  segments: Segment[];
}
export interface SummaryOutput {
  transcriptId: string; promptVersionId: string; provider: string; model: string;
  content: StructuredSummary; durationMs: number; chunkCount: number;
}
export interface MediaOutput {
  artifact?: MediaArtifact;
  metadata?: { title: string; durationMs: number; creatorName?: string; creatorUid?: string; publishedAt?: string; coverUrl?: string };
  transcript?: TranscriptOutput;
  summary?: SummaryOutput;
}
export interface TranscriptDto extends TranscriptOutput { id: string; revision: number; createdAt: string; isCurrent: boolean }
export interface SummaryDto {
  id: string; revision: number; structuredJson: string; renderedText: string;
  provider: string; model: string; promptVersionId: string; transcriptId: string; createdAt: string; isCurrent: boolean;
}
