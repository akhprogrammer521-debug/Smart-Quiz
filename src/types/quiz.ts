export type QuizAttempt = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED";
  startedAt: string;
  submittedAt: string | null;
  gradingStatus: "UNGRADED" | "GRADING" | "GRADED";
  gradedAt: string | null;
  baseScore: number | null;
  bonusScore: number | null;
  totalScore: number | null;
  maximumScore: number | null;
  answers: {
    questionId: string;
    text: string;
    basePoints: number;
    bonusPoints: number;
    earnedPoints: number | null;
    isCorrect: boolean | null;
    scoreRatio: number | null;
    feedback: string | null;
    needsReview: boolean;
  }[];
  questionSet: {
    id: string;
    document: { fileName: string };
    questions: {
      id: string;
      position: number;
      text: string;
      type: "SHORT_ANSWER" | "MULTIPLE_CHOICE" | "TRUE_FALSE";
      difficulty: string | null;
      options: string[] | null;
      correctAnswer?: string;
    }[];
  };
};
