import assert from "node:assert/strict";
import test from "node:test";
import { choiceQuestionData, InvalidQuizQuestionError, quizQuestionsForClient } from "./quiz-questions.ts";

const mcq = {
  id: "question",
  position: 1,
  text: "Which answer is correct?",
  type: "MULTIPLE_CHOICE",
  difficulty: "EASY",
  options: ["First", "Second"],
  correctAnswer: "Second",
};

test("choice questions expose options but hide correct answers before submission", () => {
  const draftQuestion = quizQuestionsForClient([mcq], false)[0];
  const submittedQuestion = quizQuestionsForClient([mcq], true)[0];
  assert.deepEqual(draftQuestion.options, ["First", "Second"]);
  assert.equal("correctAnswer" in draftQuestion, false);
  assert.equal(submittedQuestion.correctAnswer, "Second");
});

test("invalid stored MCQ data is rejected safely", () => {
  assert.throws(
    () => choiceQuestionData({ ...mcq, options: [], correctAnswer: null }),
    InvalidQuizQuestionError,
  );
});
