ALTER TABLE "PromptVersion" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
UPDATE "PromptVersion" SET "revision" = (SELECT COUNT(*) FROM "PromptVersion" p WHERE p."createdAt" < "PromptVersion"."createdAt" OR (p."createdAt" = "PromptVersion"."createdAt" AND p."id" <= "PromptVersion"."id"));
CREATE UNIQUE INDEX "PromptVersion_revision_key" ON "PromptVersion"("revision");
CREATE TABLE "SystemSettings" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton', "revision" INTEGER NOT NULL DEFAULT 0, "valuesJson" TEXT NOT NULL DEFAULT '{}', "activePromptId" TEXT, "testsJson" TEXT NOT NULL DEFAULT '{}');
