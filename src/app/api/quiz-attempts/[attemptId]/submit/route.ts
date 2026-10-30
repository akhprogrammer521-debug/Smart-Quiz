import { db } from "@/lib/db";
import { getQuizUser, quizError, quizJson } from "@/lib/quiz-api";
import { InvalidQuizQuestionError, quizQuestionsForClient } from "@/lib/quiz-questions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ attemptId: string }> };

class IncompleteAttemptError extends Error {
  constructor(readonly missingQuestionIds: string[]) { super("Incomplete attempt"); }
}

class SubmittedAttemptError extends Error {}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const user = await getQuizUser();
    if (!user) return quizError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const { attemptId } = await params;
    const attempt = await db.quizAttempt.findFirst({
      where: { id: attemptId, userId: user.id, questionSet: { userId: user.id, document: { userId: user.id } } },
      select: { id: true, status: true, questionSetId: true, submittedAt: true },
    });
    if (!attempt) return quizError("Quiz attempt not found.", "محاولة الاختبار غير موجودة.", 404);
    if (attempt.status === "SUBMITTED") return quizJson({ attempt });

    const submittedAt = new Date();
    await db.$transaction(async (tx) => {
      const updated = await tx.quizAttempt.updateMany({
        where: { id: attemptId, userId: user.id, status: "IN_PROGRESS" },
        data: { status: "SUBMITTED", submittedAt },
      });
      if (updated.count === 0) throw new SubmittedAttemptError();

      const questions = await tx.question.findMany({
        where: { questionSetId: attempt.questionSetId },
        orderBy: { position: "asc" },
        select: {
          id: true, position: true, text: true, type: true, difficulty: true,
          options: true, correctAnswer: true,
        },
      });
      quizQuestionsForClient(questions, false);
      const answers = await tx.quizAnswer.findMany({
        where: { attemptId },
        select: { questionId: true, text: true },
      });
      const answered = new Set(answers.filter((answer) => answer.text.trim()).map((answer) => answer.questionId));
      const missing = questions.filter((question) => !answered.has(question.id)).map((question) => question.id);
      if (questions.length === 0 || missing.length > 0) throw new IncompleteAttemptError(missing);
    });
    return quizJson({ attempt: { id: attemptId, status: "SUBMITTED", submittedAt } });
  } catch (error) {
    if (error instanceof InvalidQuizQuestionError) {
      return quizError("This quiz contains a choice question without usable options or a correct answer.", "يحتوي هذا الاختبار على سؤال اختياري لا يتضمن خيارات صالحة أو إجابة صحيحة.", 422);
    }
    if (error instanceof IncompleteAttemptError) {
      return quizJson({ error: "Answer every question before submitting.", errorAr: "أجب عن كل سؤال قبل التسليم.", missingQuestionIds: error.missingQuestionIds }, 422);
    }
    if (error instanceof SubmittedAttemptError) return quizError("This quiz was already submitted.", "تم تسليم هذا الاختبار بالفعل.", 409);
    return quizError("Could not submit the quiz. Please try again.", "تعذّر تسليم الاختبار. يرجى المحاولة مجددًا.", 503);
  }
}
