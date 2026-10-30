import { z } from "zod";
import { QuestionGenerationError } from "@/lib/question-generation";

const mcqResultSchema = z.object({
  question: z.string().trim().min(1),
  options: z.array(z.object({
    label: z.enum(["A", "B", "C", "D"]),
    text: z.string().trim().min(1),
  })).length(4),
  correctAnswer: z.enum(["A", "B", "C", "D"]),
});

const mcqResponseSchema = z.object({ results: z.array(mcqResultSchema) });

export type GeneratedMcqQuestion = {
  question: string;
  type: "multiple_choice";
  options: string[];
  correctAnswer: string;
};

function serviceUrl() {
  const baseUrl = process.env.AI_MCQ_SERVICE_URL;
  if (!baseUrl) {
    throw new QuestionGenerationError(503, "MCQ generation is not configured.", "خدمة إنشاء أسئلة الاختيار من متعدد غير مُعدّة حاليًا.");
  }
  try {
    const url = new URL("/generate", baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
    return url;
  } catch {
    throw new QuestionGenerationError(503, "MCQ generation is not configured.", "خدمة إنشاء أسئلة الاختيار من متعدد غير مُعدّة حاليًا.");
  }
}

function questionKey(question: string) {
  return question.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function generateMcqQuestions(normalizedText: string, requestedCount: number): Promise<GeneratedMcqQuestion[]> {
  if (requestedCount > 5) {
    throw new QuestionGenerationError(422, "The MCQ service supports up to 5 questions per request.", "تدعم خدمة الاختيار من متعدد خمسة أسئلة كحد أقصى في كل طلب.");
  }

  let response: Response;
  try {
    response = await fetch(serviceUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: normalizedText, num_questions: requestedCount }),
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    if (error instanceof QuestionGenerationError) throw error;
    throw new QuestionGenerationError(503, "MCQ generation service is unavailable. Please try again.", "خدمة إنشاء أسئلة الاختيار من متعدد غير متاحة حاليًا. يرجى المحاولة مجددًا.");
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 422) {
      throw new QuestionGenerationError(422, "The source text could not produce usable MCQ questions.", "لم يتمكن النص من إنتاج أسئلة اختيار من متعدد صالحة.");
    }
    if (response.status >= 500) {
      throw new QuestionGenerationError(503, "MCQ generation service is unavailable. Please try again.", "خدمة إنشاء أسئلة الاختيار من متعدد غير متاحة حاليًا. يرجى المحاولة مجددًا.");
    }
    throw new QuestionGenerationError(502, "The MCQ service could not complete generation.", "تعذّر على خدمة الاختيار من متعدد إكمال عملية الإنشاء.");
  }

  const payload: unknown = await response.json().catch(() => null);
  const parsed = mcqResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new QuestionGenerationError(502, "MCQ generation returned an invalid response.", "أعادت خدمة الاختيار من متعدد استجابة غير صالحة.");
  }

  const unique = new Map<string, GeneratedMcqQuestion>();
  for (const result of parsed.data.results) {
    const key = questionKey(result.question);
    const optionsByLabel = new Map(result.options.map((option) => [option.label, option.text]));
    const options = result.options.map((option) => option.text);
    const distinctOptions = new Set(options.map((option) => option.toLocaleLowerCase()));
    const correctAnswer = optionsByLabel.get(result.correctAnswer);
    if (!key || optionsByLabel.size !== 4 || distinctOptions.size !== 4 || !correctAnswer || unique.has(key)) continue;
    unique.set(key, { question: result.question, type: "multiple_choice", options, correctAnswer });
  }
  if (unique.size !== requestedCount) {
    throw new QuestionGenerationError(422, "The MCQ model did not return the requested number of distinct usable questions.", "لم يُرجع نموذج الاختيار من متعدد العدد المطلوب من الأسئلة المختلفة والصالحة.");
  }
  return [...unique.values()];
}
