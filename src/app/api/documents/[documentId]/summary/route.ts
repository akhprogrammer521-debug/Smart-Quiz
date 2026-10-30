import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { DocumentTextServiceError, ensureDocumentText } from "@/lib/document-text";
import { summarizePreparedDocument, SummaryServiceError } from "@/lib/summarization";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ documentId: string }> };
const activeSummaryDocuments = new Set<string>();

function apiError(error: string, errorAr: string, status: number) {
  return NextResponse.json({ error, errorAr }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function summaryJson(summary: {
  id: string;
  originalText: string;
  normalizedText: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...summary,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

async function findOwnedDocument(email: string, documentId: string) {
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;

  return db.document.findFirst({
    where: { id: documentId, userId: user.id, deletedAt: null },
    select: {
      id: true,
      userId: true,
      fileName: true,
      mimeType: true,
      storagePath: true,
      status: true,
      originalText: true,
      normalizedText: true,
      summary: true,
    },
  });
}

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  try {
    const { documentId } = await params;
    const document = await findOwnedDocument(session.user.email, documentId);
    if (!document) return apiError("Document not found.", "الملف غير موجود.", 404);

    return NextResponse.json(
      { summary: document.summary ? summaryJson(document.summary) : null, documentStatus: document.status },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return apiError("Could not load the summary. Please try again.", "تعذر تحميل الملخص. يرجى المحاولة مجدداً.", 503);
  }
}

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  let document: Awaited<ReturnType<typeof findOwnedDocument>>;
  try {
    const { documentId } = await params;
    document = await findOwnedDocument(session.user.email, documentId);
  } catch {
    return apiError("Could not load the document. Please try again.", "تعذر تحميل الملف. يرجى المحاولة مجدداً.", 503);
  }
  if (!document) return apiError("Document not found.", "الملف غير موجود.", 404);
  if (document.summary) {
    return NextResponse.json(
      { summary: summaryJson(document.summary) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (activeSummaryDocuments.has(document.id)) {
    return apiError(
      "A summary is already being generated. Please try again shortly.",
      "يجري إنشاء ملخص لهذا الملف. يرجى المحاولة بعد قليل.",
      409,
    );
  }
  activeSummaryDocuments.add(document.id);

  try {
    const preparedText = await ensureDocumentText(document);
    const result = await summarizePreparedDocument(preparedText);
    try {
      const summary = await db.summary.create({
        data: {
          documentId: document.id,
          originalText: result.originalText,
          normalizedText: result.normalizedText,
          content: result.content,
        },
      });
      return NextResponse.json(
        { summary: summaryJson(summary) },
        { status: 201, headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      const saved = await db.summary.findUnique({ where: { documentId: document.id } });
      if (!saved) throw error;
      return NextResponse.json(
        { summary: summaryJson(saved) },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
  } catch (error) {
    if (error instanceof SummaryServiceError || error instanceof DocumentTextServiceError) {
      return apiError(error.error, error.errorAr, error.status);
    }

    return apiError(
      "Could not save the summary. Please try again.",
      "تعذر حفظ الملخص. يرجى المحاولة مجدداً.",
      503,
    );
  } finally {
    activeSummaryDocuments.delete(document.id);
  }
}
