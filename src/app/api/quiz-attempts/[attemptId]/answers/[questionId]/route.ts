import { z } from "zod";
import { db } from "@/lib/db";
import { getQuizUser, quizError, quizJson } from "@/lib/quiz-api";
import { choiceQuestionData, InvalidQuizQuestionError } from "@/lib/quiz-questions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ attemptId: string; questionId: string }> };
const answerSchema = z.object({ text: z.string().max(5000) });

class SubmittedAttemptError extends Error {}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const user = await getQuizUser();
    if (!user) return quizError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const { attemptId, questionId } = await params;
    const attempt = await db.quizAttempt.findFirst({
      where: { id: attemptId, userId: user.id, questionSet: { userId: user.id, document: { userId: user.id } } },
      select: { id: true, status: true, questionSetId: true },
    });
    if (!attempt) return quizError("Quiz attempt not found.", "محاولة الاختبار غير موجودة.", 404);
    if (attempt.status === "SUBMITTED") return quizError("Submitted answers cannot be changed.", "لا يمكن تعديل الإجابات بعد التسليم.", 409);

    const question = await db.question.findFirst({
      where: { id: questionId, questionSetId: attempt.questionSetId },
      select: { id: true, type: true, options: true, correctAnswer: true },
    });
    if (!question) return quizError("Question not found in this quiz.", "السؤال غير موجود في هذا الاختبار.", 404);

    let body: unknown;
    try { body = await request.json(); } catch { return quizError("Enter a valid answer.", "أدخل إجابة صالحة.", 400); }
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) return quizError("Answer must be text of at most 5,000 characters.", "يجب ألا تتجاوز الإجابة ٥٠٠٠ حرف.", 400);

    const text = parsed.data.text.trim();
    const choice = choiceQuestionData(question);
    if (choice && !choice.options.includes(text)) {
      return quizError("Select one of the available answers.", "اختر إجابة واحدة من الخيارات المتاحة.", 400);
    }

    const answer = await db.$transaction(async (tx) => {
      const updated = await tx.quizAttempt.updateMany({
        where: { id: attemptId, userId: user.id, status: "IN_PROGRESS" },
        data: { updatedAt: new Date() },
      });
      if (updated.count === 0) throw new SubmittedAttemptError();
      return tx.quizAnswer.upsert({
        where: { attemptId_questionId: { attemptId, questionId } },
        create: { attemptId, questionId, text },
        update: { text },
        select: { questionId: true, text: true, updatedAt: true },
      });
    });
    return quizJson({ answer });
  } catch (error) {
    if (error instanceof InvalidQuizQuestionError) {
      return quizError("This choice question is missing usable options or a correct answer.", "لا يتضمن هذا السؤال خيارات صالحة أو إجابة صحيحة.", 422);
    }
    if (error instanceof SubmittedAttemptError) return quizError("Submitted answers cannot be changed.", "لا يمكن تعديل الإجابات بعد التسليم.", 409);
    return quizError("Could not save the answer. Please try again.", "تعذّر حفظ الإجابة. يرجى المحاولة مجددًا.", 503);
  }
}
