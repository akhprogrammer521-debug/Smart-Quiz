import { db } from "@/lib/db";
import { getQuizUser, quizError, quizJson } from "@/lib/quiz-api";
import { InvalidQuizQuestionError, quizQuestionsForClient } from "@/lib/quiz-questions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ questionSetId: string }> };

async function handle(context: RouteContext, create: boolean) {
  try {
    const user = await getQuizUser();
    if (!user) return quizError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const { questionSetId } = await context.params;
    const questionSet = await db.questionSet.findFirst({
      where: { id: questionSetId, userId: user.id, deletedAt: null, document: { userId: user.id, deletedAt: null } },
      select: {
        id: true,
        document: { select: { fileName: true } },
        questions: {
          orderBy: { position: "asc" },
          select: {
            id: true, position: true, text: true, type: true, difficulty: true,
            options: true, correctAnswer: true,
          },
        },
      },
    });
    if (!questionSet) return quizError("Question set not found.", "مجموعة الأسئلة غير موجودة.", 404);

    if (create) {
      const attempt = await db.quizAttempt.upsert({
        where: { userId_questionSetId: { userId: user.id, questionSetId } },
        create: { userId: user.id, questionSetId },
        update: {},
        select: { id: true, status: true },
      });
      return quizJson({
        attempt: {
          ...attempt,
          questionSet: {
            id: questionSet.id,
            document: questionSet.document,
            questions: quizQuestionsForClient(questionSet.questions, attempt.status === "SUBMITTED"),
          },
        },
      });
    }

    const attempt = await db.quizAttempt.findUnique({
      where: { userId_questionSetId: { userId: user.id, questionSetId } },
      select: { id: true, status: true },
    });
    return quizJson({
      attempt: attempt ? {
        ...attempt,
        questionSet: {
          id: questionSet.id,
          document: questionSet.document,
          questions: quizQuestionsForClient(questionSet.questions, attempt.status === "SUBMITTED"),
        },
      } : null,
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

export async function GET(_request: Request, context: RouteContext) {
  return handle(context, false);
}

export async function POST(_request: Request, context: RouteContext) {
  return handle(context, true);
}
