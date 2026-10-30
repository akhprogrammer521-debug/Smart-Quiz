export type QuizQuestionType = "SHORT_ANSWER" | "MULTIPLE_CHOICE" | "TRUE_FALSE";

export type StoredQuizQuestion = {
  id: string;
  position: number;
  text: string;
  type: QuizQuestionType;
  difficulty: string | null;
  options: unknown;
  correctAnswer: string | null;
};

export class InvalidQuizQuestionError extends Error {
  constructor() {
    super("A choice question is missing usable options or a correct answer.");
  }
}

export function choiceQuestionData(question: Pick<StoredQuizQuestion, "type" | "options" | "correctAnswer">) {
  if (question.type === "SHORT_ANSWER") return null;
  if (!Array.isArray(question.options)) throw new InvalidQuizQuestionError();

  const options = question.options
    .filter((option): option is string => typeof option === "string")
    .map((option) => option.trim())
    .filter(Boolean);
  const uniqueOptions = [...new Map(options.map((option) => [option.toLocaleLowerCase(), option])).values()];
  const correctAnswer = question.correctAnswer?.trim();
  if (uniqueOptions.length < 2 || !correctAnswer) throw new InvalidQuizQuestionError();

  const matchingAnswer = uniqueOptions.find(
    (option) => option.toLocaleLowerCase() === correctAnswer.toLocaleLowerCase(),
  );
  if (!matchingAnswer) throw new InvalidQuizQuestionError();
  return { options: uniqueOptions, correctAnswer: matchingAnswer };
}

export function quizQuestionsForClient(questions: StoredQuizQuestion[], submitted: boolean) {
  return questions.map((question) => {
    const choice = choiceQuestionData(question);
    return {
      id: question.id,
      position: question.position,
      text: question.text,
      type: question.type,
      difficulty: question.difficulty,
      options: choice?.options ?? null,
      ...(submitted && choice ? { correctAnswer: choice.correctAnswer } : {}),
    };
  });
}

export function choiceAnswersMatch(studentAnswer: string, correctAnswer: string) {
  return studentAnswer.trim().toLocaleLowerCase() === correctAnswer.trim().toLocaleLowerCase();
}
