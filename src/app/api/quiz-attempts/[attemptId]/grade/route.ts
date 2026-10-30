import { db } from "@/lib/db";
import { difficultyBonus, gradeShortAnswer, GradingServiceError } from "@/lib/grading";
import { getQuizUser, quizError, quizJson } from "@/lib/quiz-api";
import { choiceAnswersMatch, choiceQuestionData, InvalidQuizQuestionError } from "@/lib/quiz-questions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ attemptId: string }> };

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const roundScore = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

type StoredGrade = {
  answerId: string;
  basePoints: number;
  bonusPoints: number;
  earnedPoints: number;
  isCorrect: boolean;
  scoreRatio: number;
  feedback: string;
  needsReview: boolean;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getQuizUser();
  if (!user) return quizError("Please log in.", "يرجى تسجيل الدخول.", 401);

  const { attemptId } = await params;
  let attempt;
  try {
    attempt = await db.quizAttempt.findFirst({
      where: { id: attemptId, userId: user.id, questionSet: { userId: user.id, document: { userId: user.id } } },
      select: {
        id: true, status: true, gradingStatus: true, gradingStartedAt: true,
        questionSet: { select: { document: { select: { normalizedText: true } } } },
        answers: {
          orderBy: { question: { position: "asc" } },
          select: {
            id: true,
            text: true,
            question: {
              select: { text: true, type: true, difficulty: true, options: true, correctAnswer: true },
            },
          },
        },
      },
    });
  } catch {
    return quizError("Could not load the quiz attempt.", "تعذّر تحميل محاولة الاختبار.", 503);
  }

  if (!attempt) return quizError("Quiz attempt not found.", "محاولة الاختبار غير موجودة.", 404);
  if (attempt.status !== "SUBMITTED") return quizError("Submit the quiz before grading it.", "سلّم الاختبار قبل تصحيحه.", 409);
  if (attempt.gradingStatus === "GRADED") return quizJson({ attemptId, gradingStatus: "GRADED" });
  const sourceText = attempt.questionSet.document.normalizedText?.trim()
    || (attempt.answers.every((answer) => answer.question.type !== "SHORT_ANSWER") ? "Choice questions are graded locally." : "");
  if (!sourceText) return quizError("The document has no normalized source text for grading.", "لا يحتوي المستند على نص مصدر صالح للتصحيح.", 422);
  if (attempt.answers.length === 0) return quizError("This attempt has no answers to grade.", "لا تحتوي هذه المحاولة على إجابات للتصحيح.", 422);

  try {
    for (const answer of attempt.answers) choiceQuestionData(answer.question);
  } catch (error) {
    if (error instanceof InvalidQuizQuestionError) {
      return quizError("This quiz contains a choice question without usable options or a correct answer.", "يحتوي هذا الاختبار على سؤال اختياري لا يتضمن خيارات صالحة أو إجابة صحيحة.", 422);
    }
    throw error;
  }

  const claimedAt = new Date();
  try {
    const claim = await db.quizAttempt.updateMany({
      where: {
        id: attemptId, userId: user.id, status: "SUBMITTED",
        OR: [
          { gradingStatus: "UNGRADED" },
          { gradingStatus: "GRADING", gradingStartedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
        ],
      },
      data: { gradingStatus: "GRADING", gradingStartedAt: claimedAt },
    });
    if (claim.count === 0) {
      const current = await db.quizAttempt.findFirst({ where: { id: attemptId, userId: user.id }, select: { gradingStatus: true } });
      if (current?.gradingStatus === "GRADED") return quizJson({ attemptId, gradingStatus: "GRADED" });
      return quizError("This attempt is already being graded.", "يجري تصحيح هذه المحاولة حاليًا.", 409);
    }
  } catch {
    return quizError("Could not start grading. Please try again.", "تعذّر بدء التصحيح. يرجى المحاولة مجددًا.", 503);
  }

  try {
    const grades: StoredGrade[] = [];
    for (const answer of attempt.answers) {
      const bonusPoints = difficultyBonus(answer.question.difficulty);
      const choice = choiceQuestionData(answer.question);
      if (choice) {
        const isCorrect = choiceAnswersMatch(answer.text, choice.correctAnswer);
        grades.push({
          answerId: answer.id,
          basePoints: 1,
          bonusPoints,
          earnedPoints: isCorrect ? 1 + bonusPoints : 0,
          isCorrect,
          scoreRatio: isCorrect ? 1 : 0,
          feedback: isCorrect ? "Correct answer." : `The correct answer is ${choice.correctAnswer}.`,
          needsReview: false,
        });
        continue;
      }
      const grade = await gradeShortAnswer({
        question: answer.question.text,
        studentAnswer: answer.text,
        difficulty: answer.question.difficulty?.toUpperCase() ?? "EASY",
        sourceText,
      });
      const scoreRatio = grade.needsReview ? 0 : grade.scoreRatio;
      grades.push({
        answerId: answer.id,
        basePoints: 1,
        bonusPoints,
        earnedPoints: grade.needsReview ? 0 : roundScore(scoreRatio * (1 + bonusPoints)),
        isCorrect: grade.needsReview ? false : grade.isCorrect,
        scoreRatio: grade.scoreRatio,
        feedback: grade.feedback,
        needsReview: grade.needsReview,
      });
    }

    const baseScore = roundScore(grades.reduce((total, grade) => total + (grade.needsReview ? 0 : grade.scoreRatio), 0));
    const bonusScore = roundScore(grades.reduce((total, grade) => total + (grade.needsReview ? 0 : grade.scoreRatio * grade.bonusPoints), 0));
    const totalScore = roundScore(baseScore + bonusScore);
    const maximumScore = roundScore(grades.reduce((total, grade) => total + grade.basePoints + grade.bonusPoints, 0));
    const gradedAt = new Date();

    await db.$transaction(
      async (tx) => {
      const activeClaim = await tx.quizAttempt.updateMany({
        where: { id: attemptId, userId: user.id, status: "SUBMITTED", gradingStatus: "GRADING", gradingStartedAt: claimedAt },
        data: { gradingStatus: "GRADED", gradingStartedAt: null, gradedAt, baseScore, bonusScore, totalScore, maximumScore },
      });
      if (activeClaim.count !== 1) throw new Error("Grading claim expired");
      for (const grade of grades) {
        await tx.quizAnswer.update({
          where: { id: grade.answerId },
          data: {
            basePoints: grade.basePoints, bonusPoints: grade.bonusPoints,
            earnedPoints: grade.earnedPoints, isCorrect: grade.isCorrect,
            scoreRatio: grade.scoreRatio, feedback: grade.feedback, needsReview: grade.needsReview,
          },
        });
      }
    },
   {
    maxWait: 15_000,
    timeout: 30_000,
  },);
    return quizJson({ attemptId, gradingStatus: "GRADED" });
  }
  catch (error) {
    console.error("Saving grading results failed:", error);

    try {
      await db.quizAttempt.updateMany({
        where: {
          id: attemptId,
          userId: user.id,
          gradingStatus: "GRADING",
          gradingStartedAt: claimedAt,
        },
        data: {
          gradingStatus: "UNGRADED",
          gradingStartedAt: null,
        },
      });
    } catch (resetError) {
      console.error("Could not reset grading status:", resetError);
    }

    if (error instanceof GradingServiceError) {
      return quizError(error.error, error.errorAr, error.status);
    }

    return quizError(
      "Could not save grading results. Please try again.",
      "تعذّر حفظ نتائج التصحيح. يرجى المحاولة مجددًا.",
      503,
    );
  }
}
