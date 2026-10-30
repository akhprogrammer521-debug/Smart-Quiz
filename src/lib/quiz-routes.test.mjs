import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

function loadRoute(path, { user = null, db = {}, grading = {} } = {}) {
  const source = readFileSync(new URL(path, `file:///${root.replaceAll("\\", "/")}`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const routeModule = { exports: {} };
  const quizApi = {
    getQuizUser: async () => user,
    quizError: (error, errorAr, status) => ({ status, body: { error, errorAr } }),
    quizJson: (body, status = 200) => ({ status, body }),
  };
  class InvalidQuizQuestionError extends Error {}
  const choiceQuestionData = (question) => {
    if (question.type === "SHORT_ANSWER") return null;
    if (!Array.isArray(question.options) || question.options.length < 2 || !question.correctAnswer) {
      throw new InvalidQuizQuestionError();
    }
    const correctAnswer = question.options.find((option) => option.toLowerCase() === question.correctAnswer.toLowerCase());
    if (!correctAnswer) throw new InvalidQuizQuestionError();
    return { options: question.options, correctAnswer };
  };
  vm.runInNewContext(compiled, {
    module: routeModule, exports: routeModule.exports,
    require: (name) => {
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/quiz-api") return quizApi;
      if (name === "@/lib/quiz-questions") return {
        InvalidQuizQuestionError,
        choiceQuestionData,
        choiceAnswersMatch: (answer, correct) => answer.trim().toLowerCase() === correct.trim().toLowerCase(),
        quizQuestionsForClient: (questions, submitted) => questions.map((question) => {
          const choice = choiceQuestionData(question);
          return {
            id: question.id, position: question.position, text: question.text, type: question.type,
            difficulty: question.difficulty, options: choice?.options ?? null,
            ...(submitted && choice ? { correctAnswer: choice.correctAnswer } : {}),
          };
        }),
      };
      if (name === "@/lib/grading") return {
        difficultyBonus: () => 0,
        gradeShortAnswer: grading.gradeShortAnswer ?? (async () => { throw new Error("Unexpected grading call"); }),
        GradingServiceError: class extends Error {},
      };
      return require(name);
    },
    Date, Set,
  }, { filename: path });
  return routeModule.exports;
}

const context = (ids) => ({ params: Promise.resolve(ids) });

test("quiz routes reject unauthenticated requests", async () => {
  const start = loadRoute("src/app/api/question-sets/[questionSetId]/attempt/route.ts");
  const detail = loadRoute("src/app/api/quiz-attempts/[attemptId]/route.ts");
  const answer = loadRoute("src/app/api/quiz-attempts/[attemptId]/answers/[questionId]/route.ts");
  const submit = loadRoute("src/app/api/quiz-attempts/[attemptId]/submit/route.ts");
  const grade = loadRoute("src/app/api/quiz-attempts/[attemptId]/grade/route.ts");
  assert.equal((await start.GET({}, context({ questionSetId: "set" }))).status, 401);
  assert.equal((await start.POST({}, context({ questionSetId: "set" }))).status, 401);
  assert.equal((await detail.GET({}, context({ attemptId: "attempt" }))).status, 401);
  assert.equal((await answer.PUT({}, context({ attemptId: "attempt", questionId: "question" }))).status, 401);
  assert.equal((await submit.POST({}, context({ attemptId: "attempt" }))).status, 401);
  assert.equal((await grade.POST({}, context({ attemptId: "attempt" }))).status, 401);
});

test("foreign question sets and attempts are hidden", async () => {
  const user = { id: "student" };
  const start = loadRoute("src/app/api/question-sets/[questionSetId]/attempt/route.ts", {
    user, db: { questionSet: { findFirst: async ({ where }) => {
      assert.equal(where.userId, user.id);
      assert.equal(where.document.userId, user.id);
      return null;
    } } },
  });
  const db = { quizAttempt: { findFirst: async ({ where }) => {
    assert.equal(where.userId, user.id);
    assert.equal(where.questionSet.userId, user.id);
    assert.equal(where.questionSet.document.userId, user.id);
    return null;
  } } };
  const detail = loadRoute("src/app/api/quiz-attempts/[attemptId]/route.ts", { user, db });
  const answer = loadRoute("src/app/api/quiz-attempts/[attemptId]/answers/[questionId]/route.ts", { user, db });
  const submit = loadRoute("src/app/api/quiz-attempts/[attemptId]/submit/route.ts", { user, db });
  const grade = loadRoute("src/app/api/quiz-attempts/[attemptId]/grade/route.ts", { user, db });
  assert.equal((await start.POST({}, context({ questionSetId: "foreign-set" }))).status, 404);
  assert.equal((await detail.GET({}, context({ attemptId: "foreign-attempt" }))).status, 404);
  assert.equal((await answer.PUT({}, context({ attemptId: "foreign-attempt", questionId: "question" }))).status, 404);
  assert.equal((await submit.POST({}, context({ attemptId: "foreign-attempt" }))).status, 404);
  assert.equal((await grade.POST({}, context({ attemptId: "foreign-attempt" }))).status, 404);
});

test("draft attempts cannot be graded", async () => {
  let claimed = false;
  const grade = loadRoute("src/app/api/quiz-attempts/[attemptId]/grade/route.ts", {
    user: { id: "student" },
    db: {
      quizAttempt: {
        findFirst: async () => ({
          id: "attempt", status: "IN_PROGRESS", gradingStatus: "UNGRADED",
          gradingStartedAt: null, questionSet: { document: { normalizedText: "Source" } }, answers: [],
        }),
        updateMany: async () => { claimed = true; return { count: 1 }; },
      },
    },
  });
  const response = await grade.POST({}, context({ attemptId: "attempt" }));
  assert.equal(response.status, 409);
  assert.equal(claimed, false);
});

test("grading an already graded attempt is idempotent", async () => {
  let claimed = false;
  let calledModel = false;
  const grade = loadRoute("src/app/api/quiz-attempts/[attemptId]/grade/route.ts", {
    user: { id: "student" },
    grading: { gradeShortAnswer: async () => { calledModel = true; } },
    db: {
      quizAttempt: {
        findFirst: async () => ({
          id: "attempt", status: "SUBMITTED", gradingStatus: "GRADED",
          gradingStartedAt: null, questionSet: { document: { normalizedText: "Source" } }, answers: [],
        }),
        updateMany: async () => { claimed = true; return { count: 1 }; },
      },
    },
  });
  const response = await grade.POST({}, context({ attemptId: "attempt" }));
  assert.equal(response.status, 200);
  assert.equal(response.body.gradingStatus, "GRADED");
  assert.equal(claimed, false);
  assert.equal(calledModel, false);
});

test("submitted attempts cannot be edited", async () => {
  let wrote = false;
  const answer = loadRoute("src/app/api/quiz-attempts/[attemptId]/answers/[questionId]/route.ts", {
    user: { id: "student" },
    db: {
      quizAttempt: { findFirst: async () => ({ id: "attempt", status: "SUBMITTED", questionSetId: "set" }) },
      $transaction: async () => { wrote = true; },
    },
  });
  const response = await answer.PUT({}, context({ attemptId: "attempt", questionId: "question" }));
  assert.equal(response.status, 409);
  assert.equal(wrote, false);
});

test("attempt retrieval includes MCQ options without exposing the correct answer before submission", async () => {
  let questionSelection;
  const detail = loadRoute("src/app/api/quiz-attempts/[attemptId]/route.ts", {
    user: { id: "student" },
    db: { quizAttempt: { findFirst: async ({ select }) => {
      questionSelection = select.questionSet.select.questions;
      return {
        id: "attempt", status: "IN_PROGRESS", startedAt: new Date(), submittedAt: null,
        gradingStatus: "UNGRADED", gradedAt: null, baseScore: null, bonusScore: null,
        totalScore: null, maximumScore: null, answers: [],
        questionSet: { id: "set", document: { fileName: "lesson.pdf" }, questions: [{
          id: "mcq", position: 1, text: "Which is correct?", type: "MULTIPLE_CHOICE",
          difficulty: "EASY", options: ["A", "B", "C"], correctAnswer: "B",
        }] },
      };
    } } },
  });
  const response = await detail.GET({}, context({ attemptId: "attempt" }));
  assert.equal(response.status, 200);
  assert.equal(questionSelection.where, undefined);
  assert.equal(response.body.attempt.questionSet.questions[0].type, "MULTIPLE_CHOICE");
  assert.deepEqual(Array.from(response.body.attempt.questionSet.questions[0].options), ["A", "B", "C"]);
  assert.equal("correctAnswer" in response.body.attempt.questionSet.questions[0], false);
});

test("MCQ answers are saved through the existing answer route", async () => {
  let savedText;
  const db = {
    quizAttempt: {
      findFirst: async () => ({ id: "attempt", status: "IN_PROGRESS", questionSetId: "set" }),
    },
    question: { findFirst: async () => ({
      id: "mcq", type: "MULTIPLE_CHOICE", options: ["A", "B"], correctAnswer: "B",
    }) },
    $transaction: async (operation) => operation({
      quizAttempt: { updateMany: async () => ({ count: 1 }) },
      quizAnswer: { upsert: async ({ create }) => {
        savedText = create.text;
        return { questionId: "mcq", text: create.text, updatedAt: new Date() };
      } },
    }),
  };
  const answer = loadRoute("src/app/api/quiz-attempts/[attemptId]/answers/[questionId]/route.ts", {
    user: { id: "student" }, db,
  });
  const request = new Request("http://local", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "B" }),
  });
  const response = await answer.PUT(request, context({ attemptId: "attempt", questionId: "mcq" }));
  assert.equal(response.status, 200);
  assert.equal(savedText, "B");
});

test("MCQ grading compares the stored answer directly without calling Gemini", async () => {
  let calledGemini = false;
  let storedGrade;
  let claimCount = 0;
  const db = {
    quizAttempt: {
      findFirst: async () => ({
        id: "attempt", status: "SUBMITTED", gradingStatus: "UNGRADED", gradingStartedAt: null,
        questionSet: { document: { normalizedText: null } },
        answers: [{ id: "answer", text: "B", question: {
          text: "Which is correct?", type: "MULTIPLE_CHOICE", difficulty: "EASY",
          options: ["A", "B"], correctAnswer: "B",
        } }],
      }),
      updateMany: async () => { claimCount += 1; return { count: 1 }; },
    },
    $transaction: async (operation) => operation({
      quizAttempt: { updateMany: async () => ({ count: 1 }) },
      quizAnswer: { update: async ({ data }) => { storedGrade = data; } },
    }),
  };
  const grade = loadRoute("src/app/api/quiz-attempts/[attemptId]/grade/route.ts", {
    user: { id: "student" }, db,
    grading: { gradeShortAnswer: async () => { calledGemini = true; } },
  });
  const response = await grade.POST({}, context({ attemptId: "attempt" }));
  assert.equal(response.status, 200);
  assert.equal(claimCount, 1);
  assert.equal(calledGemini, false);
  assert.equal(storedGrade.isCorrect, true);
  assert.equal(storedGrade.earnedPoints, 1);
});
