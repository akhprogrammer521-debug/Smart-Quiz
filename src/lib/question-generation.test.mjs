import assert from "node:assert/strict";
import test from "node:test";
import { generateShortAnswerQuestions, QuestionGenerationError } from "./question-generation.ts";

const validQuestion = (text) => ({
  question: text,
  type: "short_answer",
  topic: "Biology",
  difficulty: "easy",
  source_chunk: 1,
});

async function withService(responseFactory, action) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.AI_QUESTION_SERVICE_URL;
  process.env.AI_QUESTION_SERVICE_URL = "http://question-service.test";
  globalThis.fetch = responseFactory;
  try { await action(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AI_QUESTION_SERVICE_URL;
    else process.env.AI_QUESTION_SERVICE_URL = originalUrl;
  }
}

test("passes the requested count and accepts a valid Python response", async () => {
  await withService(async (_url, init) => {
    assert.equal(JSON.parse(init.body).num_questions, 2);
    return Response.json({
      success: true,
      normalized_text: "Source text",
      questions: [validQuestion("What is photosynthesis?"), validQuestion("Where does photosynthesis occur?")],
    });
  }, async () => {
    const questions = await generateShortAnswerQuestions("Source text", 2);
    assert.equal(questions.length, 2);
  });
});

test("returns 422 semantics for partial or empty usable output", async () => {
  await withService(async () => Response.json({
    success: true,
    normalized_text: "Source text",
    questions: [validQuestion("What is photosynthesis?")],
  }), async () => {
    await assert.rejects(
      () => generateShortAnswerQuestions("Source text", 2),
      (error) => error instanceof QuestionGenerationError && error.status === 422,
    );
  });
});

test("uses 503 only when the AI service is unreachable", async () => {
  await withService(async () => { throw new Error("offline"); }, async () => {
    await assert.rejects(
      () => generateShortAnswerQuestions("Source text", 1),
      (error) => error instanceof QuestionGenerationError && error.status === 503,
    );
  });
});
