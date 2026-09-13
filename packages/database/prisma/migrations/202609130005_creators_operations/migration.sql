CREATE TABLE "Creator" ("id" TEXT NOT NULL PRIMARY KEY, "uid" TEXT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "latestLimit" INTEGER NOT NULL DEFAULT 5, "autoProcess" BOOLEAN NOT NULL DEFAULT true, "enabled" BOOLEAN NOT NULL DEFAULT true, "deletedAt" DATETIME, "lastCheckedAt" DATETIME, "latestError" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "Creator_uid_key" ON "Creator"("uid");
ALTER TABLE "Video" ADD COLUMN "creatorId" TEXT REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "Operation" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "creatorId" TEXT, "activeKey" TEXT, "status" TEXT NOT NULL DEFAULT 'QUEUED', "attempt" INTEGER NOT NULL DEFAULT 0, "leaseOwner" TEXT, "leaseExpiresAt" DATETIME, "cancelRequestedAt" DATETIME, "resultJson" TEXT, "errorMessage" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" DATETIME, "finishedAt" DATETIME);
CREATE UNIQUE INDEX "Operation_activeKey_key" ON "Operation"("activeKey");
CREATE INDEX "Operation_status_createdAt_idx" ON "Operation"("status","createdAt");
CREATE INDEX "Operation_creatorId_createdAt_idx" ON "Operation"("creatorId","createdAt");
