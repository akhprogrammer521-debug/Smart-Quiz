export type SupportedQuestionType = "SHORT_ANSWER" | "MULTIPLE_CHOICE" | "TRUE_FALSE";

export const questionTypeCapabilities = {
  SHORT_ANSWER: { label: "Short Answer / تعاليل", available: true, reason: "" },
  MULTIPLE_CHOICE: { label: "Multiple Choice", available: true, reason: "" },
  TRUE_FALSE: { label: "True / False", available: true, reason: "" },
} as const satisfies Record<SupportedQuestionType, { label: string; available: boolean; reason: string }>;

export function allocateQuestionCounts(total: number, selected: SupportedQuestionType[]) {
  const allocation: Record<SupportedQuestionType, number> = {
    SHORT_ANSWER: 0,
    MULTIPLE_CHOICE: 0,
    TRUE_FALSE: 0,
  };
  if (!Number.isInteger(total) || total < 1 || selected.length === 0) return allocation;
  const base = Math.floor(total / selected.length);
  const remainder = total % selected.length;
  selected.forEach((type, index) => { allocation[type] = base + (index < remainder ? 1 : 0); });
  return allocation;
}
