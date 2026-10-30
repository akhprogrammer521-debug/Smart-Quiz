import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

class QuestionGenerationError extends Error {
  constructor(status, error, errorAr) {
    super(error);
    this.status = status;
    this.error = error;
    this.errorAr = errorAr;
  }
}

function loadGenerator() {
  const source = readFileSync(new URL("./true-false-generation.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const generatorModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: generatorModule,
    exports: generatorModule.exports,
    require: (name) => name === "@/lib/question-generation" ? { QuestionGenerationError } : require(name),
    URL,
    Response,
    AbortSignal,
    fetch: (...args) => globalThis.fetch(...args),
    process,
  }, { filename: "true-false-generation.ts" });
  return generatorModule.exports.generateTrueFalseQuestions;
}

const generateTrueFalseQuestions = loadGenerator();

async function withService(responseFactory, action) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.AI_TRUE_FALSE_SERVICE_URL;
  process.env.AI_TRUE_FALSE_SERVICE_URL = "http://true-false-service.test";
  globalThis.fetch = responseFactory;
  try { await action(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AI_TRUE_FALSE_SERVICE_URL;
    else process.env.AI_TRUE_FALSE_SERVICE_URL = originalUrl;
  }
}

const result = (question, answer = true) => ({
  question,
  answer,
  valid: true,
  non_degenerate: true,
});

test("requests a bounded candidate pool and maps exact unique True/False questions", async () => {
  await withService(async (url, init) => {
    assert.equal(url.toString(), "http://true-false-service.test/generate");
    const body = JSON.parse(init.body);
    assert.equal(body.max_passages, 6);
    assert.equal(body.only_valid, true);
    return Response.json({
      results: [
        result("Is Earth a planet?", true),
        result("Does Earth orbit the Sun?", true),
        result("Is Earth a planet?", true),
      ],
    });
  }, async () => {
    const questions = await generateTrueFalseQuestions("Source text", 2);
    assert.equal(questions.length, 2);
    assert.deepEqual(Array.from(questions, (question) => question.type), ["true_false", "true_false"]);
    assert.deepEqual(Array.from(questions, (question) => question.correctAnswer), ["True", "True"]);
    assert.deepEqual(Array.from(questions[0].options), ["True", "False"]);
  });
});

test("returns 422 when the service produces too few distinct valid questions", async () => {
  await withService(async () => Response.json({
    results: [
      result("Is Earth a planet?"),
      result("Is Earth a planet?"),
      { ...result("Malformed output"), valid: false, non_degenerate: false },
    ],
  }), async () => {
    await assert.rejects(
      () => generateTrueFalseQuestions("Source text", 2),
      (error) => error instanceof QuestionGenerationError && error.status === 422,
    );
  });
});

test("returns 503 when the True/False service is unreachable", async () => {
  await withService(async () => { throw new Error("offline"); }, async () => {
    await assert.rejects(
      () => generateTrueFalseQuestions("Source text", 1),
      (error) => error instanceof QuestionGenerationError && error.status === 503,
    );
  });
});
