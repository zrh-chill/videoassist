ALTER TABLE "Artifact" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Artifact" SET "isCurrent" = false WHERE "deletedAt" IS NOT NULL OR EXISTS (
  SELECT 1 FROM "Artifact" AS newer WHERE newer."videoId" = "Artifact"."videoId"
  AND newer."kind" = "Artifact"."kind" AND newer."deletedAt" IS NULL
  AND (newer."createdAt" > "Artifact"."createdAt" OR (newer."createdAt" = "Artifact"."createdAt" AND newer."id" > "Artifact"."id"))
);
