-- CreateTable
CREATE TABLE "Summary" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Summary_documentId_key" ON "Summary"("documentId");

-- AddForeignKey
ALTER TABLE "Summary" ADD CONSTRAINT "Summary_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
