import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { DocumentTextServiceError, ensureDocumentText } from "@/lib/document-text";
import { generateMcqQuestions } from "@/lib/mcq-generation";
import { generateShortAnswerQuestions, QuestionGenerationError } from "@/lib/question-generation";
import { generateTrueFalseQuestions } from "@/lib/true-false-generation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ documentId: string }> };
const activeQuestionGenerationDocuments = new Set<string>();

const requestSchema = z.object({
  questionCounts: z.object({
    SHORT_ANSWER: z.number().int().min(0).max(10),
    MULTIPLE_CHOICE: z.number().int().min(0).max(10),
    TRUE_FALSE: z.number().int().min(0).max(10),
  }).strict(),
}).strict().superRefine(({ questionCounts }, context) => {
  const total = Object.values(questionCounts).reduce((sum, count) => sum + count, 0);
  if (total < 1 || total > 10) context.addIssue({ code: "custom", message: "Choose between 1 and 10 questions." });
});

function apiError(error: string, errorAr: string, status: number) {
  return NextResponse.json({ error, errorAr }, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function ownedDocument(email: string, documentId: string) {
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
    },
  });
}

export async function GET(request: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  try {
    const { documentId } = await params;
    const document = await ownedDocument(session.user.email, documentId);
    if (!document) return apiError("Document not found.", "الملف غير موجود.", 404);

    const archived = new URL(request.url).searchParams.get("archived") === "true";
    const questionSets = await db.questionSet.findMany({
      where: { documentId: document.id, userId: document.userId, deletedAt: archived ? { not: null } : null },
      orderBy: { createdAt: "desc" },
      select: { id: true, documentId: true, name: true, requestedCount: true, createdAt: true, deletedAt: true, questions: { select: { type: true } } },
    });
    return NextResponse.json(
      { questionSets: questionSets.map(({ questions, ...set }) => ({
        ...set,
        questionCount: questions.length,
        typeCounts: questions.reduce<Record<string, number>>((counts, question) => {
          counts[question.type] = (counts[question.type] ?? 0) + 1;
          return counts;
        }, {}),
      })) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return apiError("Could not load question sets. Please try again.", "تعذّر تحميل مجموعات الأسئلة. يرجى المحاولة مجدداً.", 503);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Send a valid JSON request.", "يرجى إرسال طلب JSON صالح.", 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return apiError("Choose 1 to 10 questions using available question types only.", "اختر من 1 إلى 10 أسئلة باستخدام الأنواع المتاحة فقط.", 400);
  let document: Awaited<ReturnType<typeof ownedDocument>>;
  try {
    const { documentId } = await params;
    document = await ownedDocument(session.user.email, documentId);
  } catch {
    return apiError("Could not load the document. Please try again.", "تعذّر تحميل الملف. يرجى المحاولة مجدداً.", 503);
  }
  if (!document) return apiError("Document not found.", "الملف غير موجود.", 404);

  let normalizedText: string;
  try {
    normalizedText = (await ensureDocumentText(document)).normalizedText;
  } catch (error) {
    if (error instanceof DocumentTextServiceError) {
      return apiError(error.error, error.errorAr, error.status);
    }
    return apiError(
      "Could not prepare this document for questions. Please try again.",
      "تعذر تجهيز هذا الملف لإنشاء الأسئلة. يرجى المحاولة مجدداً.",
      503,
    );
  }

  if (activeQuestionGenerationDocuments.has(document.id)) {
    return apiError(
      "Questions are already being generated for this document.",
      "يجري إنشاء أسئلة لهذا الملف حالياً.",
      409,
    );
  }
  activeQuestionGenerationDocuments.add(document.id);

  try {
    const requestedCount = Object.values(parsed.data.questionCounts).reduce((sum, count) => sum + count, 0);
  type PersistableQuestion = {
    question: string;
    type: "short_answer" | "multiple_choice" | "true_false";
    topic?: string | null;
    difficulty?: string | null;
    options?: string[] | null;
    correctAnswer?: string | null;
    expected_answer?: string | null;
  };
    const questions: PersistableQuestion[] = [];
    try {
    if (parsed.data.questionCounts.SHORT_ANSWER > 0) {
      questions.push(...await generateShortAnswerQuestions(
        normalizedText,
        parsed.data.questionCounts.SHORT_ANSWER,
      ));
    }
    if (parsed.data.questionCounts.MULTIPLE_CHOICE > 0) {
      questions.push(...await generateMcqQuestions(
        normalizedText,
        parsed.data.questionCounts.MULTIPLE_CHOICE,
      ));
    }
    if (parsed.data.questionCounts.TRUE_FALSE > 0) {
      questions.push(...await generateTrueFalseQuestions(
        normalizedText,
        parsed.data.questionCounts.TRUE_FALSE,
      ));
    }
    } catch (error) {
      if (error instanceof QuestionGenerationError) return apiError(error.error, error.errorAr, error.status);
      return apiError("The question service returned an unexpected error.", "أعادت خدمة الأسئلة خطأ غير متوقع.", 502);
    }
    if (questions.length !== requestedCount || questions.some((question) => !question.question.trim())) {
      return apiError("The model could not generate the requested number of usable questions.", "لم يتمكن النموذج من إنشاء العدد المطلوب من الأسئلة الصالحة.", 422);
    }

    try {
      const questionSet = await db.questionSet.create({
      data: {
        documentId: document.id,
        userId: document.userId,
        requestedCount,
        questions: {
          create: questions.map((question, index) => ({
            position: index + 1,
            text: question.question,
            type: question.type === "true_false"
              ? "TRUE_FALSE"
              : question.type === "multiple_choice" ? "MULTIPLE_CHOICE" : "SHORT_ANSWER",
            topic: question.topic || null,
            difficulty: question.difficulty || null,
            options: question.options ?? undefined,
            correctAnswer: question.correctAnswer || question.expected_answer || null,
          })),
        },
      },
      include: { questions: { orderBy: { position: "asc" } } },
    });
      return NextResponse.json({ questionSet }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return apiError("Could not save the questions. Please try again.", "تعذّر حفظ الأسئلة. يرجى المحاولة مجدداً.", 503);
    }
  } finally {
    activeQuestionGenerationDocuments.delete(document.id);
  }
}
