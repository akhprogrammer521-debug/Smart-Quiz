import assert from "node:assert/strict";
import test from "node:test";
import { allocateQuestionCounts } from "./question-types.ts";

test("allocates a total across multiple selected question types", () => {
  assert.deepEqual(
    allocateQuestionCounts(7, ["SHORT_ANSWER", "MULTIPLE_CHOICE", "TRUE_FALSE"]),
    { SHORT_ANSWER: 3, MULTIPLE_CHOICE: 2, TRUE_FALSE: 2 },
  );
});

test("does not allocate questions when no type is selected", () => {
  assert.deepEqual(
    allocateQuestionCounts(5, []),
    { SHORT_ANSWER: 0, MULTIPLE_CHOICE: 0, TRUE_FALSE: 0 },
  );
});
