import { z } from "zod";
import { MAX_DOCUMENT_SIZE } from "@/lib/document-file";
import { getPrivateStorage } from "@/lib/supabase-storage";

const summaryResultSchema = z.object({
  success: z.literal(true),
  original_text: z.string(),
  normalized_text: z.string().min(1),
  summary: z.string().min(1),
});

export class SummaryServiceError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorAr: string,
  ) {
    super(error);
  }
}

export async function summarizePreparedDocument(document: {
  originalText: string;
  normalizedText: string;
  structure?: Record<string, unknown>;
}) {
  const serviceBaseUrl = process.env.AI_SUMMARIZATION_SERVICE_URL;
  const internalKey = process.env.AI_SERVICE_INTERNAL_KEY;
  let serviceUrl: URL;
  try {
    if (!serviceBaseUrl || !internalKey) throw new Error("Missing service configuration");
    serviceUrl = new URL("/api/summarize-text", serviceBaseUrl);
    if (!["http:", "https:"].includes(serviceUrl.protocol)) throw new Error("Invalid protocol");
  } catch {
    throw new SummaryServiceError(503, "Summarization is not configured.", "خدمة التلخيص غير مُعدّة حالياً.");
  }

  let response: Response;
  try {
    response = await fetch(serviceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Api-Key": internalKey,
      },
      body: JSON.stringify({
        original_text: document.originalText,
        normalized_text: document.normalizedText,
        structure: document.structure,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new SummaryServiceError(503, "Summarization service is unavailable. Please try again.", "خدمة التلخيص غير متاحة حالياً. يرجى المحاولة مجدداً.");
  }

  if (!response.ok) {
    if (response.status === 422) {
      throw new SummaryServiceError(422, "No readable text was found in this document.", "لم يُعثر على نص قابل للقراءة في هذا الملف.");
    }
    if (response.status === 503) {
      throw new SummaryServiceError(503, "Summarization service is unavailable. Please try again.", "خدمة التلخيص غير متاحة حالياً. يرجى المحاولة مجدداً.");
    }
    throw new SummaryServiceError(502, "Could not summarize this document. Please try again.", "تعذر تلخيص هذا الملف. يرجى المحاولة مجدداً.");
  }

  const payload: unknown = await response.json().catch(() => null);
  const result = summaryResultSchema.safeParse(payload);
  if (!result.success || !result.data.original_text.trim() || !result.data.normalized_text.trim() || !result.data.summary.trim()) {
    throw new SummaryServiceError(502, "Summarization returned an invalid response.", "أعادت خدمة التلخيص استجابة غير صالحة.");
  }

  return {
    originalText: result.data.original_text,
    normalizedText: result.data.normalized_text,
    content: result.data.summary,
  };
}

export async function summarizeStoredDocument(document: {
  storagePath: string;
  fileName: string;
  mimeType: string;
}) {
  const serviceBaseUrl = process.env.AI_SUMMARIZATION_SERVICE_URL;
  if (!serviceBaseUrl) {
    throw new SummaryServiceError(503, "Summarization is not configured.", "خدمة التلخيص غير مُعدّة حالياً.");
  }

  let serviceUrl: URL;
  try {
    serviceUrl = new URL("/api/summarize", serviceBaseUrl);
    if (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") throw new Error("Invalid protocol");
  } catch {
    throw new SummaryServiceError(503, "Summarization is not configured.", "خدمة التلخيص غير مُعدّة حالياً.");
  }

  let file: Blob;
  try {
    const storage = getPrivateStorage();
    if (!storage) {
      throw new SummaryServiceError(503, "Private document storage is unavailable.", "تخزين الملفات الخاص غير متاح حالياً.");
    }

    const { data: bucket, error: bucketError } = await storage.client.storage.getBucket(storage.bucket);
    if (bucketError || !bucket || bucket.public) {
      throw new SummaryServiceError(503, "Private document storage is unavailable.", "تخزين الملفات الخاص غير متاح حالياً.");
    }

    const { data: downloaded, error: downloadError } = await storage.client.storage
      .from(storage.bucket)
      .download(document.storagePath);
    if (downloadError || !downloaded) {
      throw new SummaryServiceError(502, "Could not retrieve this document.", "تعذر جلب هذا الملف.");
    }
    file = downloaded;
  } catch (error) {
    if (error instanceof SummaryServiceError) throw error;
    throw new SummaryServiceError(503, "Private document storage is unavailable.", "تخزين الملفات الخاص غير متاح حالياً.");
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    throw new SummaryServiceError(413, "This document is too large to summarize.", "هذا الملف كبير جداً للتلخيص.");
  }

  const form = new FormData();
  form.append("file", new File([file], document.fileName, { type: document.mimeType }));

  let response: Response;
  try {
    response = await fetch(serviceUrl, {
      method: "POST",
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new SummaryServiceError(503, "Summarization service is unavailable. Please try again.", "خدمة التلخيص غير متاحة حالياً. يرجى المحاولة مجدداً.");
  }

  if (!response.ok) {
    if (response.status === 422) {
      throw new SummaryServiceError(422, "No readable text was found in this document.", "لم يُعثر على نص قابل للقراءة في هذا الملف.");
    }
    if (response.status === 415 || response.status === 400) {
      throw new SummaryServiceError(415, "This file type cannot be summarized.", "لا يمكن تلخيص هذا النوع من الملفات.");
    }
    if (response.status === 503) {
      const details: unknown = await response.json().catch(() => null);
      if (details && typeof details === "object" && "code" in details && details.code === "LIBREOFFICE_REQUIRED") {
        throw new SummaryServiceError(503, "LibreOffice must be installed to summarize .doc files.", "يجب تثبيت LibreOffice لتلخيص ملفات DOC.");
      }
      throw new SummaryServiceError(503, "Summarization service is unavailable. Please try again.", "خدمة التلخيص غير متاحة حالياً. يرجى المحاولة مجدداً.");
    }
    throw new SummaryServiceError(502, "Could not summarize this document. Please try again.", "تعذر تلخيص هذا الملف. يرجى المحاولة مجدداً.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SummaryServiceError(502, "Summarization returned an invalid response.", "أعادت خدمة التلخيص استجابة غير صالحة.");
  }
  const result = summaryResultSchema.safeParse(payload);
  if (!result.success || !result.data.original_text.trim() || !result.data.normalized_text.trim() || !result.data.summary.trim()) {
    throw new SummaryServiceError(502, "Summarization returned an invalid response.", "أعادت خدمة التلخيص استجابة غير صالحة.");
  }

  return {
    originalText: result.data.original_text,
    normalizedText: result.data.normalized_text,
    content: result.data.summary,
  };
}
