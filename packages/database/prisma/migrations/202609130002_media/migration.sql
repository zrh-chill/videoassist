-- AlterTable
ALTER TABLE "Video" ADD COLUMN "coverUrl" TEXT;
ALTER TABLE "Video" ADD COLUMN "creatorName" TEXT;
ALTER TABLE "Video" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "Video" ADD COLUMN "localOriginalName" TEXT;
ALTER TABLE "Video" ADD COLUMN "originalUrl" TEXT;
ALTER TABLE "Video" ADD COLUMN "publishedAt" DATETIME;
ALTER TABLE "Video" ADD COLUMN "sourceHash" TEXT;

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "Artifact_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "fullText" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "timestampPrecision" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transcript_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '视频总结',
    "body" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Summary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "structuredJson" TEXT NOT NULL,
    "renderedText" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Summary_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Summary_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Summary_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Checkpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Checkpoint_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "Artifact_videoId_kind_createdAt_idx" ON "Artifact"("videoId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_videoId_revision_key" ON "Transcript"("videoId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_transcriptId_sequence_key" ON "TranscriptSegment"("transcriptId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_hash_key" ON "PromptVersion"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Summary_videoId_revision_key" ON "Summary"("videoId", "revision");

-- CreateIndex
CREATE INDEX "Checkpoint_videoId_kind_idx" ON "Checkpoint"("videoId", "kind");
