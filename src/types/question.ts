export type Question = {
  id: string;
  position: number;
  text: string;
  type: "SHORT_ANSWER" | "MULTIPLE_CHOICE" | "TRUE_FALSE";
  topic: string | null;
  difficulty: string | null;
  correctAnswer: string | null;
  createdAt: string;
};

export type QuestionSet = {
  id: string;
  documentId: string;
  requestedCount: number;
  name: string | null;
  createdAt: string;
  deletedAt: string | null;
  questions: Question[];
};

export type QuestionSetListItem = {
  id: string;
  documentId: string;
  requestedCount: number;
  name: string | null;
  questionCount: number;
  typeCounts: Partial<Record<Question["type"], number>>;
  createdAt: string;
  deletedAt: string | null;
};
