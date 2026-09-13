ALTER TABLE "Video" ADD COLUMN "creatorUid" TEXT;
ALTER TABLE "Video" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Video" ADD COLUMN "deletedAt" DATETIME;
CREATE INDEX "Video_creatorUid_isDeleted_idx" ON "Video"("creatorUid", "isDeleted");
UPDATE "Video" SET "creatorUid" = (SELECT "uid" FROM "Creator" WHERE "Creator"."id" = "Video"."creatorId") WHERE "creatorId" IS NOT NULL;
