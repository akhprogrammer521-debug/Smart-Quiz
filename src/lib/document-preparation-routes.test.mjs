import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

function loadSummaryRoute({ db, ensureText, summarize }) {
  const path = "src/app/api/documents/[documentId]/summary/route.ts";
  const source = readFileSync(new URL(path, `file:///${root.replaceAll("\\", "/")}`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const routeModule = { exports: {} };
  class ServiceError extends Error {
    constructor(status, error, errorAr) { super(error); this.status = status; this.error = error; this.errorAr = errorAr; }
  }
  vm.runInNewContext(compiled, {
    module: routeModule,
    exports: routeModule.exports,
    require: (name) => {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } };
      if (name === "@/lib/auth") return { auth: async () => ({ user: { email: "owner@example.com" } }) };
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/document-text") return { DocumentTextServiceError: ServiceError, ensureDocumentText: ensureText };
      if (name === "@/lib/summarization") return { SummaryServiceError: ServiceError, summarizePreparedDocument: summarize };
      return require(name);
    },
    Request, Response, URL, Date,
  }, { filename: path });
  return routeModule.exports;
}

function loadQuestionRoute({ db, ensureText, generate }) {
  const path = "src/app/api/documents/[documentId]/question-sets/route.ts";
  const source = readFileSync(new URL(path, `file:///${root.replaceAll("\\", "/")}`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const routeModule = { exports: {} };
  class ServiceError extends Error {
    constructor(status, error, errorAr) { super(error); this.status = status; this.error = error; this.errorAr = errorAr; }
  }
  vm.runInNewContext(compiled, {
    module: routeModule,
    exports: routeModule.exports,
    require: (name) => {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } };
      if (name === "@/lib/auth") return { auth: async () => ({ user: { email: "owner@example.com" } }) };
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/document-text") return { DocumentTextServiceError: ServiceError, ensureDocumentText: ensureText };
      if (name === "@/lib/question-generation") return { QuestionGenerationError: ServiceError, generateShortAnswerQuestions: generate };
      if (name === "@/lib/mcq-generation") return { generateMcqQuestions: async () => [] };
      if (name === "@/lib/true-false-generation") return { generateTrueFalseQuestions: async () => [] };
      return require(name);
    },
    Request, Response, URL, Date,
  }, { filename: path });
  return routeModule.exports;
}

const context = { params: Promise.resolve({ documentId: "doc" }) };
const documentRecord = {
  id: "doc", userId: "owner", fileName: "lesson.txt", mimeType: "text/plain",
  storagePath: "documents/owner/lesson.txt", status: "UPLOADED",
  originalText: null, normalizedText: null, summary: null,
};
const summaryRecord = {
  id: "summary", originalText: "Original", normalizedText: "Normalized", content: "Summary",
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
};

function summaryDb() {
  let savedSummary = null;
  return {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ ...documentRecord, summary: savedSummary }) },
    summary: {
      findUnique: async () => savedSummary,
      create: async () => { savedSummary = summaryRecord; return savedSummary; },
    },
  };
}

test("summary ensures source text before calling Gemini", async () => {
  let ensured = false;
  let summarizedText;
  const route = loadSummaryRoute({
    db: summaryDb(),
    ensureText: async () => { ensured = true; return { originalText: "Original", normalizedText: "Normalized" }; },
    summarize: async (text) => { summarizedText = text; return { ...text, content: "Summary" }; },
  });

  const response = await route.POST(new Request("http://local"), context);
  assert.equal(response.status, 201);
  assert.equal(ensured, true);
  assert.equal(summarizedText.normalizedText, "Normalized");
});

test("a Gemini failure releases only the summary claim and can be retried", async () => {
  let calls = 0;
  const route = loadSummaryRoute({
    db: summaryDb(),
    ensureText: async () => ({ originalText: "Original", normalizedText: "Normalized" }),
    summarize: async (text) => {
      calls += 1;
      if (calls === 1) throw new Error("Gemini unavailable");
      return { ...text, content: "Summary" };
    },
  });

  assert.equal((await route.POST(new Request("http://local"), context)).status, 503);
  assert.equal((await route.POST(new Request("http://local"), context)).status, 201);
  assert.equal(calls, 2);
});

test("Gemini failure does not block question generation or create a Summary", async () => {
  let savedSummary = null;
  const db = {
    user: { findUnique: async () => ({ id: "owner" }) },
    document: { findFirst: async () => ({ ...documentRecord, status: "READY", originalText: "Original", normalizedText: "Normalized", summary: savedSummary }) },
    summary: { findUnique: async () => savedSummary, create: async () => { throw new Error("must not create"); } },
    questionSet: { create: async ({ data }) => ({ id: "set", ...data, questions: data.questions.create }) },
  };
  const ensureText = async () => ({ originalText: "Original", normalizedText: "Normalized" });
  const summaryRoute = loadSummaryRoute({ db, ensureText, summarize: async () => { throw new Error("Gemini unavailable"); } });
  const questionRoute = loadQuestionRoute({
    db,
    ensureText,
    generate: async () => [{ question: "What is this lesson about?", type: "short_answer" }],
  });

  assert.equal((await summaryRoute.POST(new Request("http://local"), context)).status, 503);
  const questionRequest = new Request("http://local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionCounts: { SHORT_ANSWER: 1, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 } }),
  });
  assert.equal((await questionRoute.POST(questionRequest, context)).status, 201);
  assert.equal(savedSummary, null);
});

test("rapid summary requests start only one Gemini operation", async () => {
  let calls = 0;
  let releaseSummary;
  const gate = new Promise((resolve) => { releaseSummary = resolve; });
  const route = loadSummaryRoute({
    db: summaryDb(),
    ensureText: async () => ({ originalText: "Original", normalizedText: "Normalized" }),
    summarize: async (text) => { calls += 1; await gate; return { ...text, content: "Summary" }; },
  });

  const first = route.POST(new Request("http://local"), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await route.POST(new Request("http://local"), context)).status, 409);
  assert.equal(calls, 1);
  releaseSummary();
  assert.equal((await first).status, 201);
});
