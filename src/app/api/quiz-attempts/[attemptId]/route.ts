import { db } from "@/lib/db";
import { getQuizUser, quizError, quizJson } from "@/lib/quiz-api";
import { InvalidQuizQuestionError, quizQuestionsForClient } from "@/lib/quiz-questions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ attemptId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const user = await getQuizUser();
    if (!user) return quizError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const { attemptId } = await params;
    const attempt = await db.quizAttempt.findFirst({
      where: { id: attemptId, userId: user.id, questionSet: { userId: user.id, document: { userId: user.id } } },
      select: {
        id: true, status: true, startedAt: true, submittedAt: true,
        gradingStatus: true, gradedAt: true,
        baseScore: true, bonusScore: true, totalScore: true, maximumScore: true,
        answers: { select: {
          questionId: true, text: true, basePoints: true, bonusPoints: true,
          earnedPoints: true, isCorrect: true, scoreRatio: true, feedback: true, needsReview: true,
        } },
        questionSet: {
          select: {
            id: true, document: { select: { fileName: true } },
            questions: {
              orderBy: { position: "asc" },
              select: {
                id: true, position: true, text: true, type: true, difficulty: true,
                options: true, correctAnswer: true,
              },
            },
          },
        },
      },
    });
    if (!attempt) return quizError("Quiz attempt not found.", "محاولة الاختبار غير موجودة.", 404);
    return quizJson({
      attempt: {
        ...attempt,
        questionSet: {
          ...attempt.questionSet,
          questions: quizQuestionsForClient(attempt.questionSet.questions, attempt.status === "SUBMITTED"),
        },
      },
    });
  } catch (error) {
    if (error instanceof InvalidQuizQuestionError) {
      return quizError(
        "This quiz contains a choice question without usable options or a correct answer.",
        "يحتوي هذا الاختبار على سؤال اختياري لا يتضمن خيارات صالحة أو إجابة صحيحة.",
        422,
      );
    }
    return quizError("Could not load the quiz. Please try again.", "تعذّر تحميل الاختبار. يرجى المحاولة مجددًا.", 503);
  }
}
