"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LoaderCircle, ListChecks, Pencil, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import type { DocumentListItem } from "@/types/document";
import type { QuestionSet, QuestionSetListItem } from "@/types/question";
import { questionTypeCapabilities, type SupportedQuestionType } from "@/lib/question-types";

const questionTypes = Object.entries(questionTypeCapabilities) as [SupportedQuestionType, (typeof questionTypeCapabilities)[SupportedQuestionType]][];

function questionTypeLabel(type: SupportedQuestionType) {
  if (type === "SHORT_ANSWER") return "Short Answer";
  if (type === "MULTIPLE_CHOICE") return "Multiple Choice";
  return "True / False";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not load questions. Please try again.";
}

async function readError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "errorAr" in body && typeof body.errorAr === "string") return body.errorAr;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  } catch {
    // Use a safe fallback when the service response is unavailable.
  }
  return "Could not load questions. Please try again.";
}

function isQuestionSet(value: unknown): value is QuestionSet {
  return Boolean(value && typeof value === "object"
    && "id" in value && typeof value.id === "string"
    && "questions" in value && Array.isArray(value.questions)
    && "requestedCount" in value && typeof value.requestedCount === "number");
}

async function requestQuestionSet(url: string, options?: RequestInit): Promise<QuestionSet> {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) throw new Error(await readError(response));
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("questionSet" in payload) || !isQuestionSet(payload.questionSet)) {
    throw new Error("The question response was invalid.");
  }
  return payload.questionSet;
}

export function QuestionSetsClient({ document }: { document: DocumentListItem }) {
  const generationRequestInFlight = useRef(false);
  const [questionCounts, setQuestionCounts] = useState<Record<SupportedQuestionType, number>>({
    SHORT_ANSWER: 5,
    MULTIPLE_CHOICE: 0,
    TRUE_FALSE: 0,
  });
  const [selectedTypes, setSelectedTypes] = useState<SupportedQuestionType[]>(["SHORT_ANSWER"]);
  const [sets, setSets] = useState<QuestionSetListItem[]>([]);
  const [activeSet, setActiveSet] = useState<QuestionSet | null>(null);
  const [error, setError] = useState("");
  const [failedAction, setFailedAction] = useState<"list" | "generate" | "open">("list");
  const [failedSetId, setFailedSetId] = useState<string | null>(null);
  const [isLoadingSets, setIsLoadingSets] = useState(true);
  const [isLoadingSet, setIsLoadingSet] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingSetId, setEditingSetId] = useState<string | null>(null);
  const [setName, setSetName] = useState("");
  const [managingSetId, setManagingSetId] = useState<string | null>(null);
  const [success, setSuccess] = useState("");

  async function loadSets() {
    setIsLoadingSets(true);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/question-sets?archived=${showArchived}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("questionSets" in payload) || !Array.isArray(payload.questionSets)) {
        throw new Error("The question response was invalid.");
      }
      setSets(payload.questionSets as QuestionSetListItem[]);
      setError("");
    } catch (caught) {
      setFailedAction("list");
      setError(errorMessage(caught));
    } finally {
      setIsLoadingSets(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/documents/${encodeURIComponent(document.id)}/question-sets?archived=${showArchived}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || !("questionSets" in payload) || !Array.isArray(payload.questionSets)) {
          throw new Error("The question response was invalid.");
        }
        setSets(payload.questionSets as QuestionSetListItem[]);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setFailedAction("list");
          setError(errorMessage(caught));
        }
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoadingSets(false); });
    return () => controller.abort();
  }, [document.id, showArchived]);

  async function generate() {
    if (generationRequestInFlight.current || isGenerating || isLoadingSet) return;
    if (selectedTypes.length === 0) {
      setFailedAction("generate");
      setError("Select at least one available question type.");
      return;
    }
    const requestedCounts = {
      SHORT_ANSWER: selectedTypes.includes("SHORT_ANSWER") ? questionCounts.SHORT_ANSWER : 0,
      MULTIPLE_CHOICE: selectedTypes.includes("MULTIPLE_CHOICE") ? questionCounts.MULTIPLE_CHOICE : 0,
      TRUE_FALSE: selectedTypes.includes("TRUE_FALSE") ? questionCounts.TRUE_FALSE : 0,
    };
    const totalQuestions = Object.values(requestedCounts).reduce((sum, count) => sum + count, 0);
    if (selectedTypes.some((type) => questionTypeCapabilities[type].available && questionCounts[type] < 1)
      || requestedCounts.MULTIPLE_CHOICE > 5
      || !Number.isInteger(totalQuestions) || totalQuestions < 1 || totalQuestions > 10) {
      setFailedAction("generate");
      setError("Choose at least 1 question per selected type, up to 5 Multiple Choice questions, and no more than 10 questions in total.");
      return;
    }
    generationRequestInFlight.current = true;
    setError("");
    setIsGenerating(true);
    try {
      const questionSet = await requestQuestionSet(`/api/documents/${encodeURIComponent(document.id)}/question-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionCounts: requestedCounts,
        }),
      });
      setActiveSet(questionSet);
      setSets((items) => [{
        id: questionSet.id,
        documentId: document.id,
        name: questionSet.name,
        requestedCount: questionSet.requestedCount,
        questionCount: questionSet.questions.length,
        typeCounts: questionSet.questions.reduce<QuestionSetListItem["typeCounts"]>((counts, question) => {
          counts[question.type] = (counts[question.type] ?? 0) + 1;
          return counts;
        }, {}),
        createdAt: questionSet.createdAt,
        deletedAt: null,
      }, ...items]);
    } catch (caught) {
      setFailedAction("generate");
      setError(errorMessage(caught));
    } finally {
      setIsGenerating(false);
      generationRequestInFlight.current = false;
    }
  }

  async function updateSet(id: string, body: { name: string } | { restore: true }) {
    setManagingSetId(id);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`/api/question-sets/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));
      if ("restore" in body) {
        setSets((items) => items.filter((item) => item.id !== id));
        setSuccess("Question set restored successfully.");
      }
      else setSets((items) => items.map((item) => item.id === id ? { ...item, name: body.name } : item));
      setEditingSetId(null);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setManagingSetId(null); }
  }

  async function archiveSet(id: string) {
    if (!window.confirm("Delete this question set? It will be moved to Archived sets and can be restored later.")) return;
    setManagingSetId(id);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`/api/question-sets/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      setSets((items) => items.filter((item) => item.id !== id));
      setSuccess("Question set moved to Archived sets.");
      if (activeSet?.id === id) setActiveSet(null);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setManagingSetId(null); }
  }

  async function openSet(id: string) {
    if (isGenerating || isLoadingSet) return;
    setError("");
    setIsLoadingSet(true);
    try {
      setActiveSet(await requestQuestionSet(`/api/question-sets/${encodeURIComponent(id)}`));
    } catch (caught) {
      setFailedAction("open");
      setFailedSetId(id);
      setError(errorMessage(caught));
    } finally {
      setIsLoadingSet(false);
    }
  }

  return (
    <section className="rounded-3xl border border-border bg-card p-6 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8 lg:col-span-2" aria-busy={isLoadingSets || isLoadingSet || isGenerating}>
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#FFF4E5] text-primary"><ListChecks aria-hidden="true" className="size-5" /></span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-primary">Question generation</p>
          <h2 className="mt-1 break-words text-xl font-bold">{document.displayName || document.fileName}</h2>
          <p className="mt-2 text-sm text-muted">Questions use the document&apos;s source text. If needed, SmartQuiz prepares the text automatically.</p>
        </div>
      </div>

      <fieldset className="mt-6">
        <legend className="text-sm font-bold">Question types</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {questionTypes.map(([type, capability]) => {
            const selected = selectedTypes.includes(type);
            return <label key={type} className={`rounded-2xl border p-4 transition ${capability.available ? "cursor-pointer hover:border-primary/50" : "cursor-not-allowed bg-[#FAFAFB] opacity-65"}`}>
              <span className="flex items-start gap-3">
                <input type="checkbox" checked={selected} disabled={!capability.available || isGenerating}
                  onChange={(event) => {
                    setSelectedTypes((items) => event.target.checked ? [...items, type] : items.filter((item) => item !== type));
                    if (event.target.checked && questionCounts[type] < 1) {
                      setQuestionCounts((counts) => ({ ...counts, [type]: 1 }));
                    }
                  }}
                  className="mt-1 size-4 accent-primary" />
                <span><span className="block text-sm font-semibold">{capability.label}</span>{capability.reason && <span className="mt-1 block text-xs leading-5 text-muted">{capability.reason}</span>}</span>
              </span>
            </label>;
          })}
        </div>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        {selectedTypes.filter((type) => questionTypeCapabilities[type].available).map((type) => (
          <label key={type} className="text-sm font-semibold" htmlFor={`question-count-${type}`}>
            {questionTypeLabel(type)} count
            <input
              id={`question-count-${type}`}
              type="number"
              min={1}
              max={type === "MULTIPLE_CHOICE" ? 5 : 10}
              value={questionCounts[type]}
              disabled={isGenerating || isLoadingSet}
              onChange={(event) => setQuestionCounts((counts) => ({ ...counts, [type]: Number(event.target.value) }))}
              className="mt-2 block w-36 rounded-xl border border-border bg-white px-4 py-2.5 text-foreground outline-none transition focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        ))}
        <Button type="button" onClick={() => void generate()} disabled={isGenerating || isLoadingSet}>
          {isGenerating ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Sparkles aria-hidden="true" className="size-4" />}
          {isGenerating ? "Generating..." : "Generate questions"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Generation plan: {selectedTypes.filter((type) => questionTypeCapabilities[type].available).map((type) => `${questionCounts[type]} ${questionTypeLabel(type)}`).join(" · ") || "No available type selected"}.
      </p>
      {isGenerating && <div className="mt-4 rounded-xl bg-[#FFF8EE] p-4 text-sm text-[#A65E00]" role="status">
        <span className="flex items-center gap-2 font-semibold"><LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />Generating and checking unique questions...</span>
        <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-white"><span className="block h-full w-2/3 animate-pulse rounded-full bg-primary" /></span>
      </div>}

      {error && (
        <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => {
            if (failedAction === "list") void loadSets();
            else if (failedAction === "open" && failedSetId) void openSet(failedSetId);
            else void generate();
          }} disabled={isGenerating || isLoadingSet}>Try again</Button>
        </div>
      )}
      {success && <p role="status" className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{success}</p>}

      <div className="mt-7 border-t border-border pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-bold">{showArchived ? "Archived question sets" : "Saved question sets"}</h3>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setShowArchived((value) => !value); setActiveSet(null); }} disabled={isLoadingSets}>
            {showArchived ? "View active sets" : "View archived sets"}
          </Button>
        </div>
        {isLoadingSets ? (
          <div className="mt-4 space-y-2" aria-label="Loading question sets">
            {[1, 2].map((item) => <div key={item} className="h-10 animate-pulse rounded-xl bg-[#F1F1F3]" />)}
          </div>
        ) : sets.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{showArchived ? "No archived question sets." : "No question sets yet."}</p>
        ) : (
          <div className="mt-3 space-y-3">
            {sets.map((set) => (
              <div key={set.id} className="rounded-xl border border-border p-3">
                {editingSetId === set.id ? <div className="flex flex-wrap gap-2">
                  <input value={setName} maxLength={100} onChange={(event) => setSetName(event.target.value)} aria-label="Question set name"
                    className="min-w-48 flex-1 rounded-xl border border-border px-3 py-2 text-sm outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20" />
                  <Button size="sm" disabled={managingSetId === set.id || setName.trim().length < 2} onClick={() => void updateSet(set.id, { name: setName.trim() })}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingSetId(null)}>Cancel</Button>
                </div> : <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button type="button" disabled={showArchived || isGenerating || isLoadingSet} onClick={() => void openSet(set.id)} className="text-start text-sm font-semibold hover:text-primary disabled:cursor-default disabled:text-foreground">
                      {set.name || `${set.questionCount} questions · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(set.createdAt))}`}
                    </button>
                    <div className="flex flex-wrap gap-2">
                      {showArchived ? <Button size="sm" disabled={managingSetId === set.id} onClick={() => void updateSet(set.id, { restore: true })}>{managingSetId === set.id ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <RotateCcw aria-hidden="true" className="size-4" />}{managingSetId === set.id ? "Restoring..." : "Restore"}</Button> : <>
                        <Button size="icon" variant="ghost" aria-label="Rename question set" title="Rename question set" disabled={managingSetId === set.id} onClick={() => { setEditingSetId(set.id); setSetName(set.name || `Question set ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(set.createdAt))}`); }}><Pencil aria-hidden="true" className="size-4" /></Button>
                        <Button size="icon" variant="ghost" className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700" aria-label="Delete question set" title="Delete question set" disabled={managingSetId === set.id} onClick={() => void archiveSet(set.id)}>{managingSetId === set.id ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}</Button>
                        <Link href={`/quiz/${encodeURIComponent(set.id)}`} className={buttonStyles({ size: "sm" })}><Play aria-hidden="true" className="size-4" />Start quiz</Link>
                      </>}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(set.typeCounts).map(([type, count]) => <span key={type} className="rounded-full bg-[#FFF4E5] px-2.5 py-1 text-xs font-semibold text-[#A65E00]">{type.replaceAll("_", " ")}: {count}</span>)}
                  </div>
                </>}
              </div>
            ))}
          </div>
        )}
      </div>

      {isLoadingSet ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted"><LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />Loading questions...</div>
      ) : activeSet && (
        <div className="mt-7 border-t border-border pt-6">
          <h3 className="text-lg font-bold">Generated questions</h3>
          {activeSet.questions.length < activeSet.requestedCount && (
            <p className="mt-2 text-sm text-muted">The model returned {activeSet.questions.length} of {activeSet.requestedCount} requested questions.</p>
          )}
          <ol className="mt-4 space-y-3">
            {activeSet.questions.map((question) => (
              <li key={question.id} className="rounded-2xl border border-border bg-[#FAFAFB] p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#FFF4E5] text-xs font-bold text-primary">{question.position}</span>
                  <div className="min-w-0">
                    <span className="inline-flex rounded-full bg-[#FFF4E5] px-2.5 py-1 text-[11px] font-bold text-[#A65E00]">{question.type.replaceAll("_", " ")}</span>
                    <p dir="auto" className="whitespace-pre-wrap break-words text-sm font-semibold leading-7">{question.text}</p>
                    {(question.topic || question.difficulty) && <p className="mt-2 text-xs text-muted">{[question.topic, question.difficulty].filter(Boolean).join(" · ")}</p>}
                    {question.correctAnswer && <p dir="auto" className="mt-3 text-sm leading-6 text-muted">Answer: {question.correctAnswer}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
