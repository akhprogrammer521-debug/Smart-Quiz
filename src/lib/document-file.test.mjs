import assert from "node:assert/strict";
import test from "node:test";
import { getDocumentExtension, getDocumentMimeType, validateDocumentFile } from "./document-file.ts";

test("accepts legacy DOC and DOCX extensions with matching MIME types", () => {
  assert.equal(getDocumentExtension("LESSON.DOC"), "doc");
  assert.equal(getDocumentMimeType("doc"), "application/msword");
  assert.equal(validateDocumentFile(new File(["content"], "lesson.doc", { type: "application/msword" })), null);
  assert.equal(validateDocumentFile(new File(["content"], "lesson.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })), null);
});

test("rejects mismatched Word file MIME types and unsupported extensions", () => {
  assert.match(validateDocumentFile(new File(["content"], "lesson.doc", { type: "application/pdf" })), /Choose a PDF/);
  assert.match(validateDocumentFile(new File(["content"], "lesson.exe", { type: "application/octet-stream" })), /Choose a PDF/);
});
