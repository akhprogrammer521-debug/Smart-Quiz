import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

function loadRoute(path, { db = {}, extractText, generate, generateMcq, generateTrueFalse } = {}) {
  const source = readFileSync(new URL(path, `file:///${root.replaceAll("\\", "/")}`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const routeModule = { exports: {} };
  class QuestionGenerationError extends Error {
    constructor(status, error, errorAr) { super(error); this.status = status; this.error = error; this.errorAr = errorAr; }
  }
  class DocumentTextServiceError extends Error {
    constructor(status, error, errorAr) { super(error); this.status = status; this.error = error; this.errorAr = errorAr; }
  }
  vm.runInNewContext(compiled, {
    module: routeModule,
    exports: routeModule.exports,
    require: (name) => {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } };
      if (name === "@/lib/auth") return { auth: async () => ({ user: { email: "owner@example.com" } }) };
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/document-text") return {
        DocumentTextServiceError,
        ensureDocumentText: extractText ?? (async (document) => ({
          originalText: document.originalText ?? document.normalizedText,
          normalizedText: document.normalizedText,
        })),
      };
      if (name === "@/lib/mcq-generation") return { generateMcqQuestions: generateMcq };
      if (name === "@/lib/question-generation") return { generateShortAnswerQuestions: generate, QuestionGenerationError };
      if (name === "@/lib/true-false-generation") return { generateTrueFalseQuestions: generateTrueFalse };
      if (name === "@/lib/document-file") return { getDocumentExtension() {}, getDocumentMimeType() {}, MAX_DOCUMENT_SIZE: 1, validateDocumentFile() {} };
      if (name === "@/lib/supabase-storage") return { getPrivateStorage() { return null; } };
      return require(name);
    },
    Request, Response, URL, Date, Buffer, TextDecoder,
  }, { filename: path });
  return routeModule.exports;
}

const context = (ids) => ({ params: Promise.resolve(ids) });

test("a valid generated response is persisted with exactly the requested count", async () => {
  let createData;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: "Normalized source" }) },
    questionSet: { create: async ({ data }) => {
      createData = data;
      return { id: "set", ...data, name: null, deletedAt: null, createdAt: new Date(), questions: data.questions.create };
    } },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    generate: async () => [
      { question: "Question one?", type: "short_answer" },
      { question: "Question two?", type: "short_answer" },
    ],
  });
  const request = new Request("http://local/api/documents/doc/question-sets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 2, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });
  const response = await route.POST(request, context({ documentId: "doc" }));
  assert.equal(response.status, 201);
  assert.equal(createData.requestedCount, 2);
  assert.equal(createData.questions.create.length, 2);
  assert.ok(createData.questions.create.every((question) => question.type === "SHORT_ANSWER"));
});

test("a newly uploaded document is prepared before questions without creating a summary", async () => {
  let generatedFrom = "";
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: {
      findFirst: async () => ({
        id: "doc", userId: "owner", fileName: "lesson.txt", mimeType: "text/plain",
        storagePath: "documents/owner/lesson.txt", status: "UPLOADED",
        originalText: null, normalizedText: null,
      }),
    },
    questionSet: { create: async ({ data }) => ({ id: "set", ...data, questions: data.questions.create }) },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    extractText: async () => ({ originalText: "Original source", normalizedText: "Normalized source" }),
    generate: async (text) => {
      generatedFrom = text;
      return [{ question: "What is the lesson about?", type: "short_answer" }];
    },
  });
  const request = new Request("http://local/api/documents/doc/question-sets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });

  const response = await route.POST(request, context({ documentId: "doc" }));

  assert.equal(response.status, 201);
  assert.equal(generatedFrom, "Normalized source");
  assert.equal("summary" in db, false);
});

test("question generation uses text returned by the shared preparation helper", async () => {
  let preparationCalled = false;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: "Saved source" }) },
    questionSet: { create: async ({ data }) => ({ id: "set", ...data, questions: data.questions.create }) },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    extractText: async () => { preparationCalled = true; return { originalText: "Saved source", normalizedText: "Saved source" }; },
    generate: async (text) => [{ question: `Question from ${text}?`, type: "short_answer" }],
  });
  const request = new Request("http://local/api/documents/doc/question-sets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });

  const response = await route.POST(request, context({ documentId: "doc" }));
  assert.equal(response.status, 201);
  assert.equal(preparationCalled, true);
});

test("a failed text preparation does not lock a question retry", async () => {
  let preparationCalls = 0;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: null }) },
    questionSet: { create: async ({ data }) => ({ id: "set", ...data, questions: data.questions.create }) },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    extractText: async () => {
      preparationCalls += 1;
      if (preparationCalls === 1) throw new Error("extraction failed");
      return { originalText: "Original", normalizedText: "Normalized" };
    },
    generate: async () => [{ question: "Question?", type: "short_answer" }],
  });
  const makeRequest = () => new Request("http://local", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });

  const first = await route.POST(makeRequest(), context({ documentId: "doc" }));
  assert.equal(first.status, 503);
  const retry = await route.POST(makeRequest(), context({ documentId: "doc" }));
  assert.equal(retry.status, 201);
  assert.equal(preparationCalls, 2);
});

test("rapid question requests start only one generation operation", async () => {
  let generationCalls = 0;
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: "Normalized" }) },
    questionSet: { create: async ({ data }) => ({ id: "set", ...data, questions: data.questions.create }) },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    extractText: async () => ({ originalText: "Original", normalizedText: "Normalized" }),
    generate: async () => { generationCalls += 1; await generationGate; return [{ question: "Question?", type: "short_answer" }]; },
  });
  const makeRequest = () => new Request("http://local", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });

  const firstRequest = route.POST(makeRequest(), context({ documentId: "doc" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const duplicate = await route.POST(makeRequest(), context({ documentId: "doc" }));
  assert.equal(duplicate.status, 409);
  assert.equal(generationCalls, 1);
  releaseGeneration();
  assert.equal((await firstRequest).status, 201);
});

test("a mixed question set persists True/False answers with exact types", async () => {
  let createData;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: "Normalized source" }) },
    questionSet: { create: async ({ data }) => {
      createData = data;
      return { id: "set", ...data, name: null, deletedAt: null, createdAt: new Date(), questions: data.questions.create };
    } },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    generate: async () => [{ question: "Explain photosynthesis.", type: "short_answer" }],
    generateTrueFalse: async () => [{
      question: "Does photosynthesis require light?",
      type: "true_false",
      options: ["True", "False"],
      correctAnswer: "True",
    }],
  });
  const request = new Request("http://local/api/documents/doc/question-sets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 1 } }),
  });
  const response = await route.POST(request, context({ documentId: "doc" }));
  assert.equal(response.status, 201);
  assert.equal(createData.requestedCount, 2);
  assert.deepEqual(Array.from(createData.questions.create, (question) => question.type), ["SHORT_ANSWER", "TRUE_FALSE"]);
  assert.equal(createData.questions.create[1].correctAnswer, "True");
});

test("MCQ generation persists options and the real correct answer", async () => {
  let createData;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ id: "doc", userId: "owner", normalizedText: "Normalized source" }) },
    questionSet: { create: async ({ data }) => {
      createData = data;
      return { id: "set", ...data, name: null, deletedAt: null, createdAt: new Date(), questions: data.questions.create };
    } },
  };
  const route = loadRoute("src/app/api/documents/[documentId]/question-sets/route.ts", {
    db,
    generateMcq: async () => [{
      question: "Which organelle produces energy?",
      type: "multiple_choice",
      options: ["Mitochondrion", "Nucleus", "Ribosome"],
      correctAnswer: "Mitochondrion",
    }],
  });
  const request = new Request("http://local/api/documents/doc/question-sets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 0, MULTIPLE_CHOICE: 1, TRUE_FALSE: 0 } }),
  });
  const response = await route.POST(request, context({ documentId: "doc" }));
  assert.equal(response.status, 201);
  assert.equal(createData.questions.create[0].type, "MULTIPLE_CHOICE");
  assert.deepEqual(Array.from(createData.questions.create[0].options), ["Mitochondrion", "Nucleus", "Ribosome"]);
  assert.equal(createData.questions.create[0].correctAnswer, "Mitochondrion");
});

test("normal document lists hide soft-deleted rows while preserving storage", async () => {
  const stored = [
    { id: "active", userId: "owner", deletedAt: null, createdAt: new Date(), fileName: "a.txt", displayName: null, mimeType: "text/plain", fileSize: 1, status: "READY" },
    { id: "archived", userId: "owner", deletedAt: new Date(), createdAt: new Date(), fileName: "b.txt", displayName: null, mimeType: "text/plain", fileSize: 1, status: "READY" },
  ];
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findMany: async ({ where }) => stored.filter((item) => item.userId === where.userId && (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null)) },
  };
  const route = loadRoute("src/app/api/documents/route.ts", { db });
  const response = await route.GET(new Request("http://local/api/documents"));
  assert.deepEqual(response.body.documents.map((item) => item.id), ["active"]);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].id, "archived");
});

test("cross-user document and question-set updates are denied", async () => {
  let updateCalled = false;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => null, update: async () => { updateCalled = true; } },
    questionSet: { findFirst: async () => null, update: async () => { updateCalled = true; } },
  };
  const documentRoute = loadRoute("src/app/api/documents/[documentId]/route.ts", { db });
  const setRoute = loadRoute("src/app/api/question-sets/[questionSetId]/route.ts", { db });
  const documentResponse = await documentRoute.PATCH(new Request("http://local", { method: "PATCH", body: JSON.stringify({ displayName: "Renamed" }) }), context({ documentId: "foreign" }));
  const setResponse = await setRoute.PATCH(new Request("http://local", { method: "PATCH", body: JSON.stringify({ name: "Renamed set" }) }), context({ questionSetId: "foreign" }));
  assert.equal(documentResponse.status, 404);
  assert.equal(setResponse.status, 404);
  assert.equal(updateCalled, false);
});
