-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'SIMULATION',
    "bvid" TEXT,
    "overallStatus" TEXT NOT NULL DEFAULT 'WAITING',
    "currentStage" TEXT,
    "latestErrorCode" TEXT,
    "latestErrorMessage" TEXT,
    "optionsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "inputFingerprint" TEXT NOT NULL,
    "cancelRequestedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StageRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "outputJson" TEXT,
    CONSTRAINT "StageRun_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StageRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StageResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StageResult_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "videoId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Command" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Video_overallStatus_createdAt_idx" ON "Video"("overallStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Video_createdAt_id_idx" ON "Video"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Video_sourceType_bvid_key" ON "Video"("sourceType", "bvid");

-- CreateIndex
CREATE INDEX "Job_status_availableAt_idx" ON "Job"("status", "availableAt");

-- CreateIndex
CREATE INDEX "Job_videoId_status_idx" ON "Job"("videoId", "status");

-- CreateIndex
CREATE INDEX "StageRun_videoId_startedAt_idx" ON "StageRun"("videoId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StageRun_jobId_attempt_key" ON "StageRun"("jobId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "StageResult_videoId_stage_inputFingerprint_key" ON "StageResult"("videoId", "stage", "inputFingerprint");
