import { z } from "zod";
import { db } from "@/lib/db";
import { MAX_DOCUMENT_SIZE } from "@/lib/document-file";
import { getPrivateStorage } from "@/lib/supabase-storage";

const activeDocumentExtractions = new Set<string>();

const extractedTextSchema = z.object({
  success: z.literal(true),
  original_text: z.string().min(1),
  normalized_text: z.string().min(1),
  structure: z.record(z.string(), z.unknown()).optional(),
});

export class DocumentTextServiceError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorAr: string,
  ) {
    super(error);
  }
}

export async function extractStoredDocumentText(document: {
  storagePath: string;
  fileName: string;
  mimeType: string;
}) {
  const serviceBaseUrl = process.env.AI_SUMMARIZATION_SERVICE_URL;
  const internalKey = process.env.AI_SERVICE_INTERNAL_KEY;
  let serviceUrl: URL;
  try {
    if (!serviceBaseUrl || !internalKey) throw new Error("Missing service configuration");
    serviceUrl = new URL("/api/extract-text", serviceBaseUrl);
    if (!["http:", "https:"].includes(serviceUrl.protocol)) throw new Error("Invalid protocol");
  } catch {
    throw new DocumentTextServiceError(
      503,
      "Document text extraction is not configured.",
      "خدمة استخراج نص المستند غير مُعدّة حالياً.",
    );
  }

  let file: Blob;
  try {
    const storage = getPrivateStorage();
    if (!storage) throw new Error("Storage unavailable");

    const { data: bucket, error: bucketError } = await storage.client.storage.getBucket(storage.bucket);
    if (bucketError || !bucket || bucket.public) throw new Error("Private bucket unavailable");

    const { data, error } = await storage.client.storage.from(storage.bucket).download(document.storagePath);
    if (error || !data) {
      throw new DocumentTextServiceError(
        502,
        "Could not retrieve this document.",
        "تعذر جلب هذا الملف.",
      );
    }
    file = data;
  } catch (error) {
    if (error instanceof DocumentTextServiceError) throw error;
    throw new DocumentTextServiceError(
      503,
      "Private document storage is unavailable.",
      "تخزين الملفات الخاص غير متاح حالياً.",
    );
  }

  if (file.size > MAX_DOCUMENT_SIZE) {
    throw new DocumentTextServiceError(
      413,
      "This document is too large to process.",
      "هذا الملف كبير جداً للمعالجة.",
    );
  }

  const form = new FormData();
  form.append("file", new File([file], document.fileName, { type: document.mimeType }));

  let response: Response;
  try {
    response = await fetch(serviceUrl, {
      method: "POST",
      headers: { "X-Internal-Api-Key": internalKey },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new DocumentTextServiceError(
      503,
      "Document text extraction is unavailable. Please try again.",
      "خدمة استخراج نص المستند غير متاحة حالياً. يرجى المحاولة مجدداً.",
    );
  }

  if (!response.ok) {
    if (response.status === 422) {
      throw new DocumentTextServiceError(
        422,
        "No readable text was found in this document.",
        "لم يُعثر على نص قابل للقراءة في هذا الملف.",
      );
    }
    if (response.status === 400 || response.status === 415) {
      throw new DocumentTextServiceError(
        415,
        "This file type cannot be processed.",
        "لا يمكن معالجة هذا النوع من الملفات.",
      );
    }
    if (response.status === 401 || response.status === 503) {
      const details: unknown = await response.json().catch(() => null);
      if (details && typeof details === "object" && "code" in details && details.code === "LIBREOFFICE_REQUIRED") {
        throw new DocumentTextServiceError(
          503,
          "LibreOffice must be installed to read .doc files.",
          "يجب تثبيت LibreOffice لقراءة ملفات DOC.",
        );
      }
      throw new DocumentTextServiceError(
        503,
        "Document text extraction is unavailable. Please try again.",
        "خدمة استخراج نص المستند غير متاحة حالياً. يرجى المحاولة مجدداً.",
      );
    }
    throw new DocumentTextServiceError(
      502,
      "Could not extract text from this document.",
      "تعذر استخراج النص من هذا الملف.",
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  const parsed = extractedTextSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.original_text.trim() || !parsed.data.normalized_text.trim()) {
    throw new DocumentTextServiceError(
      502,
      "Document text extraction returned an invalid response.",
      "أعادت خدمة استخراج النص استجابة غير صالحة.",
    );
  }

  return {
    originalText: parsed.data.original_text,
    normalizedText: parsed.data.normalized_text,
    structure: parsed.data.structure,
  };
}

type StoredDocument = {
  id: string;
  userId: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  status: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  originalText: string | null;
  normalizedText: string | null;
};

function savedText(document: Pick<StoredDocument, "originalText" | "normalizedText">) {
  if (!document.normalizedText?.trim()) return null;
  return {
    originalText: document.originalText?.trim() ? document.originalText : document.normalizedText,
    normalizedText: document.normalizedText,
  };
}

/** Ensure source text is persisted. PROCESSING is held only while extraction runs. */
export async function ensureDocumentText(document: StoredDocument) {
  const existing = savedText(document);
  if (existing) {
    if (document.status === "PROCESSING") {
      await db.document.updateMany({
        where: { id: document.id, userId: document.userId, status: "PROCESSING", normalizedText: { not: null } },
        data: { status: "READY" },
      });
    }
    return existing;
  }

  if (activeDocumentExtractions.has(document.id)) {
    const prepared = await db.document.findFirst({
      where: { id: document.id, userId: document.userId, deletedAt: null },
      select: { originalText: true, normalizedText: true },
    });
    const preparedText = prepared ? savedText(prepared) : null;
    if (preparedText) return preparedText;
    throw new DocumentTextServiceError(
      409,
      "Document text extraction is already running. Please try again shortly.",
      "يجري استخراج نص هذا الملف حالياً. يرجى المحاولة بعد قليل.",
    );
  }
  activeDocumentExtractions.add(document.id);

  let completed = false;
  try {
    const current = await db.document.findFirst({
      where: { id: document.id, userId: document.userId, deletedAt: null },
      select: { originalText: true, normalizedText: true },
    });
    if (!current) {
      throw new DocumentTextServiceError(404, "Document not found.", "الملف غير موجود.");
    }
    const currentText = savedText(current);
    if (currentText) {
      await db.document.updateMany({
        where: { id: document.id, userId: document.userId, status: "PROCESSING" },
        data: { status: "READY" },
      });
      completed = true;
      return currentText;
    }

    const claimedAt = new Date();
    const claim = await db.document.updateMany({
      where: { id: document.id, userId: document.userId, deletedAt: null },
      data: { status: "PROCESSING", updatedAt: claimedAt },
    });
    if (claim.count !== 1) {
      throw new DocumentTextServiceError(404, "Document not found.", "الملف غير موجود.");
    }

    const extracted = await extractStoredDocumentText(document);
    const saved = await db.document.updateMany({
      where: { id: document.id, userId: document.userId, status: "PROCESSING" },
      data: {
        status: "READY",
        originalText: extracted.originalText,
        normalizedText: extracted.normalizedText,
      },
    });
    if (saved.count !== 1) {
      throw new DocumentTextServiceError(
        409,
        "Document text extraction was restarted. Please retry.",
        "أُعيد بدء استخراج نص الملف. يرجى المحاولة مجدداً.",
      );
    }
    completed = true;
    return extracted;
  } finally {
    if (!completed) {
      try {
        await db.document.updateMany({
          where: { id: document.id, userId: document.userId, status: "PROCESSING" },
          data: { status: "FAILED" },
        });
      } catch {
        // A later request can retry because status is not used as the active-operation lock.
      }
    }
    activeDocumentExtractions.delete(document.id);
  }
}
