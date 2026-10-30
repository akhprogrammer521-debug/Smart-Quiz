import { z } from "zod";

const gradingResponseSchema = z.object({
  success: z.literal(true),
  isCorrect: z.boolean(),
  scoreRatio: z.number().min(0).max(1),
  feedback: z.string().trim().min(1).max(2000),
  needsReview: z.boolean(),
}).strict();

export type AnswerGrade = z.infer<typeof gradingResponseSchema>;

export class GradingServiceError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorAr: string,
  ) { super(error); }
}

export async function gradeShortAnswer(input: {
  question: string;
  studentAnswer: string;
  difficulty: string;
  sourceText: string;
}) {
  const baseUrl = process.env.AI_SUMMARIZATION_SERVICE_URL;
  const internalKey = process.env.AI_SERVICE_INTERNAL_KEY;
  if (!baseUrl || !internalKey) {
    throw new GradingServiceError(503, "AI grading is not configured.", "خدمة تصحيح الإجابات غير مُعدّة حاليًا.");
  }

  let url: URL;
  try {
    url = new URL("/api/grade-short-answer", baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Invalid protocol");
  } catch {
    throw new GradingServiceError(503, "AI grading is not configured.", "خدمة تصحيح الإجابات غير مُعدّة حاليًا.");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Api-Key": internalKey },
      body: JSON.stringify({
        question: input.question,
        student_answer: input.studentAnswer,
        difficulty: input.difficulty,
        source_text: input.sourceText,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new GradingServiceError(503, "Gemini grading service is unavailable. Please try again.", "خدمة التصحيح غير متاحة حاليًا. يرجى المحاولة مجددًا.");
  }

  if (!response.ok) {
    throw new GradingServiceError(503, "Gemini grading service is unavailable. Please try again.", "خدمة التصحيح غير متاحة حاليًا. يرجى المحاولة مجددًا.");
  }

  const payload: unknown = await response.json().catch(() => null);
  const result = gradingResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new GradingServiceError(502, "The grading service returned an invalid response.", "أعادت خدمة التصحيح استجابة غير صالحة.");
  }
  return result.data;
}

export function difficultyBonus(difficulty: string | null) {
  switch (difficulty?.trim().toUpperCase()) {
    case "HARD": return 1;
    case "MEDIUM": return 0.5;
    default: return 0;
  }
}
