import { z } from "zod";
import { QuestionGenerationError } from "@/lib/question-generation";

const trueFalseResultSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.boolean(),
  valid: z.boolean(),
  non_degenerate: z.boolean(),
});

const trueFalseResponseSchema = z.object({
  results: z.array(trueFalseResultSchema),
});

export type GeneratedTrueFalseQuestion = {
  question: string;
  type: "true_false";
  options: ["True", "False"];
  correctAnswer: "True" | "False";
};

function serviceUrl() {
  const baseUrl = process.env.AI_TRUE_FALSE_SERVICE_URL;
  if (!baseUrl) {
    throw new QuestionGenerationError(
      503,
      "True/False question generation is not configured.",
      "خدمة إنشاء أسئلة الصح والخطأ غير مُعدّة حاليًا.",
    );
  }

  try {
    const url = new URL("/generate", baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
    return url;
  } catch {
    throw new QuestionGenerationError(
      503,
      "True/False question generation is not configured.",
      "خدمة إنشاء أسئلة الصح والخطأ غير مُعدّة حاليًا.",
    );
  }
}

function questionKey(question: string) {
  return question.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function generateTrueFalseQuestions(
  normalizedText: string,
  requestedCount: number,
): Promise<GeneratedTrueFalseQuestion[]> {
  let response: Response;
  try {
    response = await fetch(serviceUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: normalizedText,
        max_passages: Math.min(30, Math.max(requestedCount, requestedCount * 3)),
        passage_tokens: 200,
        only_valid: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    if (error instanceof QuestionGenerationError) throw error;
    throw new QuestionGenerationError(
      503,
      "True/False question service is unavailable. Please try again.",
      "خدمة أسئلة الصح والخطأ غير متاحة حاليًا. يرجى المحاولة مجددًا.",
    );
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 422) {
      throw new QuestionGenerationError(
        422,
        "The source text could not produce usable True/False questions.",
        "لم يتمكن النص من إنتاج أسئلة صح وخطأ صالحة. جرّب عددًا أقل أو محتوى أوضح.",
      );
    }
    if (response.status >= 500) {
      throw new QuestionGenerationError(
        503,
        "True/False question service is unavailable. Please try again.",
        "خدمة أسئلة الصح والخطأ غير متاحة حاليًا. يرجى المحاولة مجددًا.",
      );
    }
    throw new QuestionGenerationError(
      502,
      "The True/False question service could not complete generation.",
      "تعذّر على خدمة أسئلة الصح والخطأ إكمال عملية الإنشاء.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new QuestionGenerationError(
      502,
      "True/False question generation returned an invalid response.",
      "أعادت خدمة أسئلة الصح والخطأ استجابة غير صالحة.",
    );
  }

  const parsed = trueFalseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new QuestionGenerationError(
      502,
      "True/False question generation returned an invalid response.",
      "أعادت خدمة أسئلة الصح والخطأ استجابة غير صالحة.",
    );
  }

  const unique = new Map<string, GeneratedTrueFalseQuestion>();
  for (const result of parsed.data.results) {
    if (!result.valid || !result.non_degenerate) continue;
    const key = questionKey(result.question);
    if (!key || unique.has(key)) continue;
    unique.set(key, {
      question: result.question,
      type: "true_false",
      options: ["True", "False"],
      correctAnswer: result.answer ? "True" : "False",
    });
  }

  if (unique.size < requestedCount) {
    throw new QuestionGenerationError(
      422,
      "We could not create enough distinct True/False questions from this content. Try fewer questions or a clearer study document.",
      "لم نتمكن من إنشاء أسئلة صح وخطأ كافية ومختلفة من هذا المحتوى. جرّب عددًا أقل أو ملفًا تعليميًا أوضح.",
    );
  }

  return [...unique.values()].slice(0, requestedCount);
}
