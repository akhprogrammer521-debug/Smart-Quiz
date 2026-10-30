import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

function loadDocumentText({ db, fetchImpl }) {
  const path = "src/lib/document-text.ts";
  const source = readFileSync(new URL(path, `file:///${root.replaceAll("\\", "/")}`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const textModule = { exports: {} };
  const storage = {
    bucket: "documents",
    client: { storage: {
      getBucket: async () => ({ data: { public: false }, error: null }),
      from: () => ({ download: async () => ({ data: new Blob(["Study material"]), error: null }) }),
    } },
  };
  vm.runInNewContext(compiled, {
    module: textModule,
    exports: textModule.exports,
    require: (name) => {
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/document-file") return { MAX_DOCUMENT_SIZE: 15 * 1024 * 1024 };
      if (name === "@/lib/supabase-storage") return { getPrivateStorage: () => storage };
      return require(name);
    },
    process: { env: { AI_SUMMARIZATION_SERVICE_URL: "http://127.0.0.1:5000", AI_SERVICE_INTERNAL_KEY: "internal-test-key" } },
    fetch: fetchImpl,
    Blob, File, FormData, Response, URL, AbortSignal, Date,
  }, { filename: path });
  return textModule.exports;
}

const documentRecord = {
  id: "doc", userId: "owner", storagePath: "documents/owner/lesson.txt",
  fileName: "lesson.txt", mimeType: "text/plain", status: "UPLOADED",
  originalText: null, normalizedText: null,
};

test("failed extraction resets PROCESSING and an immediate retry succeeds", async () => {
  const state = { status: "UPLOADED", updatedAt: new Date(0), originalText: null, normalizedText: null };
  let requests = 0;
  const db = {
    document: {
      findFirst: async () => ({ ...state }),
      updateMany: async ({ where, data }) => {
        if (where.OR && state.status === "PROCESSING") return { count: 0 };
        if (!where.OR && where.status === "PROCESSING" && state.status !== "PROCESSING") return { count: 0 };
        Object.assign(state, data);
        state.updatedAt = data.updatedAt ?? new Date(state.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
  };
  const service = loadDocumentText({
    db,
    fetchImpl: async (_url, options) => {
      requests += 1;
      assert.equal(options.headers["X-Internal-Api-Key"], "internal-test-key");
      if (requests === 1) return new Response(JSON.stringify({ success: false, error: "Unavailable" }), { status: 503 });
      return new Response(JSON.stringify({
        success: true,
        original_text: "Original study text",
        normalized_text: "Normalized study text",
        structure: {},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await assert.rejects(service.ensureDocumentText(documentRecord), (error) => error.status === 503);
  assert.equal(state.status, "FAILED");

  const prepared = await service.ensureDocumentText({ ...documentRecord, status: "FAILED" });
  assert.equal(prepared.normalizedText, "Normalized study text");
  assert.equal(state.status, "READY");
});

test("saved normalized text bypasses extraction and clears a legacy PROCESSING status", async () => {
  const state = { status: "PROCESSING" };
  let fetchCalled = false;
  const db = {
    document: {
      updateMany: async ({ data }) => { state.status = data.status; return { count: 1 }; },
    },
  };
  const service = loadDocumentText({
    db,
    fetchImpl: async () => { fetchCalled = true; throw new Error("should not fetch"); },
  });

  const prepared = await service.ensureDocumentText({
    ...documentRecord,
    status: "PROCESSING",
    originalText: "Original",
    normalizedText: "Normalized",
  });
  assert.equal(prepared.normalizedText, "Normalized");
  assert.equal(fetchCalled, false);
  assert.equal(state.status, "READY");
});

test("a stale PROCESSING status without text is reclaimed instead of returning 409", async () => {
  const state = { status: "PROCESSING", updatedAt: new Date(), originalText: null, normalizedText: null };
  let requests = 0;
  const db = {
    document: {
      findFirst: async () => ({ ...state }),
      updateMany: async ({ where, data }) => {
        if (where.status === "PROCESSING" && state.status !== "PROCESSING") return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
  };
  const service = loadDocumentText({
    db,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        success: true,
        original_text: "Original study text",
        normalized_text: "Normalized study text",
        structure: {},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const prepared = await service.ensureDocumentText({ ...documentRecord, status: "PROCESSING" });

  assert.equal(prepared.normalizedText, "Normalized study text");
  assert.equal(requests, 1);
  assert.equal(state.status, "READY");
});

test("simultaneous extraction calls run the extraction service only once", async () => {
  const state = { status: "UPLOADED", updatedAt: new Date(), originalText: null, normalizedText: null };
  let requests = 0;
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const db = {
    document: {
      findFirst: async () => ({ ...state }),
      updateMany: async ({ where, data }) => {
        if (where.status === "PROCESSING" && state.status !== "PROCESSING") return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
  };
  const service = loadDocumentText({
    db,
    fetchImpl: async () => {
      requests += 1;
      await requestGate;
      return new Response(JSON.stringify({
        success: true,
        original_text: "Original study text",
        normalized_text: "Normalized study text",
        structure: {},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const first = service.ensureDocumentText(documentRecord);
  while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(service.ensureDocumentText(documentRecord), (error) => error.status === 409);
  assert.equal(requests, 1);

  releaseRequest();
  const prepared = await first;
  assert.equal(prepared.normalizedText, "Normalized study text");
  assert.equal(state.status, "READY");
});
