import { z } from "zod";

export const generatedQuestionSchema = z.object({
  question: z.string().trim().min(1),
  type: z.literal("short_answer"),
  topic: z.string().trim().optional().nullable(),
  difficulty: z.string().trim().optional().nullable(),
  options: z.array(z.string()).optional().nullable(),
  correctAnswer: z.string().trim().optional().nullable(),
  expected_answer: z.string().trim().optional().nullable(),
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

const generationResponseSchema = z.object({
  success: z.literal(true),
  normalized_text: z.string().min(1),
  questions: z.array(generatedQuestionSchema),
});

export class QuestionGenerationError extends Error {
  readonly status: number;
  readonly error: string;
  readonly errorAr: string;

  constructor(status: number, error: string, errorAr: string) {
    super(error);
    this.status = status;
    this.error = error;
    this.errorAr = errorAr;
  }
}

export async function generateShortAnswerQuestions(normalizedText: string, numQuestions: number) {
  const baseUrl = process.env.AI_QUESTION_SERVICE_URL;
  if (!baseUrl) {
    throw new QuestionGenerationError(503, "Question generation is not configured.", "خدمة إنشاء الأسئلة غير مُعدّة حالياً.");
  }

  let url: URL;
  try {
    url = new URL("/api/questions/generate", baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
  } catch {
    throw new QuestionGenerationError(503, "Question generation is not configured.", "خدمة إنشاء الأسئلة غير مُعدّة حالياً.");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: normalizedText, num_questions: numQuestions }),
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new QuestionGenerationError(503, "Question generation service is unavailable. Please try again.", "خدمة إنشاء الأسئلة غير متاحة حالياً. يرجى المحاولة مجدداً.");
  }

  if (!response.ok) {
    if (response.status === 503) {
      throw new QuestionGenerationError(503, "Trained question model weights are required on the Python service.", "يلزم توفير أوزان نموذج الأسئلة المدرّب على خدمة بايثون.");
    }
    if (response.status === 422) {
      throw new QuestionGenerationError(422, "We could not create enough distinct questions from this content. Try fewer questions or a clearer study document.", "لم نتمكن من إنشاء أسئلة كافية ومختلفة من هذا المحتوى. جرّب عددًا أقل أو ملفًا تعليميًا أوضح.");
    }
    throw new QuestionGenerationError(502, "The question service could not complete generation.", "تعذّر على خدمة الأسئلة إكمال عملية الإنشاء.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new QuestionGenerationError(502, "Question generation returned an invalid response.", "أعادت خدمة الأسئلة استجابة غير صالحة.");
  }
  const parsed = generationResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new QuestionGenerationError(502, "Question generation returned an invalid response.", "أعادت خدمة الأسئلة استجابة غير صالحة.");
  }
  if (parsed.data.questions.length === 0) {
    throw new QuestionGenerationError(422, "The model did not generate any usable questions.", "لم ينشئ النموذج أي أسئلة صالحة.");
  }
  const unique = new Map<string, GeneratedQuestion>();
  for (const question of parsed.data.questions) {
    const key = question.question.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (key && !unique.has(key)) unique.set(key, question);
  }
  if (unique.size !== numQuestions) {
    throw new QuestionGenerationError(422, "We could not create enough distinct questions from this content. Try fewer questions or a clearer study document.", "لم نتمكن من إنشاء أسئلة كافية ومختلفة من هذا المحتوى. جرّب عددًا أقل أو ملفًا تعليميًا أوضح.");
  }
  return [...unique.values()];
}
