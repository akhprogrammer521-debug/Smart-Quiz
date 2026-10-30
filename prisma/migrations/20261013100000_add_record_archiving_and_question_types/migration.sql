-- AlterEnum
ALTER TYPE "QuestionType" ADD VALUE 'MULTIPLE_CHOICE';
ALTER TYPE "QuestionType" ADD VALUE 'TRUE_FALSE';

-- AlterTable
ALTER TABLE "Document"
ADD COLUMN "displayName" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QuestionSet"
ADD COLUMN "name" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- ReplaceIndex
DROP INDEX "Document_userId_createdAt_idx";
CREATE INDEX "Document_userId_deletedAt_createdAt_idx" ON "Document"("userId", "deletedAt", "createdAt");

-- ReplaceIndex
DROP INDEX "QuestionSet_documentId_createdAt_idx";
DROP INDEX "QuestionSet_userId_createdAt_idx";
CREATE INDEX "QuestionSet_documentId_deletedAt_createdAt_idx" ON "QuestionSet"("documentId", "deletedAt", "createdAt");
CREATE INDEX "QuestionSet_userId_deletedAt_createdAt_idx" ON "QuestionSet"("userId", "deletedAt", "createdAt");
