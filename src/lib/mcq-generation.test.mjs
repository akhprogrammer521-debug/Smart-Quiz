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
  const source = readFileSync(new URL("./mcq-generation.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const generatorModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: generatorModule,
    exports: generatorModule.exports,
    require: (name) => name === "@/lib/question-generation" ? { QuestionGenerationError } : require(name),
    URL, Response, AbortSignal, process,
    fetch: (...args) => globalThis.fetch(...args),
  }, { filename: "mcq-generation.ts" });
  return generatorModule.exports.generateMcqQuestions;
}

const generateMcqQuestions = loadGenerator();

async function withService(responseFactory, action) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.AI_MCQ_SERVICE_URL;
  process.env.AI_MCQ_SERVICE_URL = "http://mcq-service.test";
  globalThis.fetch = responseFactory;
  try { await action(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AI_MCQ_SERVICE_URL;
    else process.env.AI_MCQ_SERVICE_URL = originalUrl;
  }
}

test("sends the documented MCQ request and maps the answer label to its stored option", async () => {
  await withService(async (url, init) => {
    assert.equal(url.toString(), "http://mcq-service.test/generate");
    assert.deepEqual(JSON.parse(init.body), { context: "Normalized lesson", num_questions: 1 });
    return Response.json({
      context: "Normalized lesson",
      results: [{
        question: "Which organelle produces energy?",
        options: [
          { label: "A", text: "Mitochondrion" },
          { label: "B", text: "Nucleus" },
          { label: "C", text: "Ribosome" },
          { label: "D", text: "Golgi body" },
        ],
        correctAnswer: "B",
        raw: "ignored diagnostic output",
      }],
    });
  }, async () => {
    const questions = await generateMcqQuestions("Normalized lesson", 1);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].type, "multiple_choice");
    assert.deepEqual(Array.from(questions[0].options), ["Mitochondrion", "Nucleus", "Ribosome", "Golgi body"]);
    assert.equal(questions[0].correctAnswer, "Nucleus");
  });
});

test("rejects malformed or insufficient MCQ output", async () => {
  await withService(async () => Response.json({
    context: "Normalized lesson",
    results: [{ question: "Incomplete?", options: [{ label: "A", text: "Only one" }] }],
  }), async () => {
    await assert.rejects(
      () => generateMcqQuestions("Normalized lesson", 1),
      (error) => error instanceof QuestionGenerationError && error.status === 502,
    );
  });
});

test("rejects missing or invalid correct answers without guessing", async () => {
  await withService(async () => Response.json({
    context: "Normalized lesson",
    results: [{
      question: "Which organelle produces energy?",
      options: [
        { label: "A", text: "Mitochondrion" },
        { label: "B", text: "Nucleus" },
        { label: "C", text: "Ribosome" },
        { label: "D", text: "Golgi body" },
      ],
    }],
  }), async () => {
    await assert.rejects(
      () => generateMcqQuestions("Normalized lesson", 1),
      (error) => error instanceof QuestionGenerationError && error.status === 502,
    );
  });
});

test("returns 503 when the MCQ service is unavailable", async () => {
  await withService(async () => { throw new Error("offline"); }, async () => {
    await assert.rejects(
      () => generateMcqQuestions("Normalized lesson", 1),
      (error) => error instanceof QuestionGenerationError && error.status === 503,
    );
  });
});
