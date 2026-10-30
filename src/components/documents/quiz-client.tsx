"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, LoaderCircle, Sparkles, XCircle } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import type { QuizAttempt } from "@/types/quiz";

async function apiError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  } catch { /* The service may be temporarily unavailable. */ }
  return "Something went wrong. Please try again.";
}

function isAttempt(value: unknown): value is QuizAttempt {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string"
    && "status" in value && (value.status === "IN_PROGRESS" || value.status === "SUBMITTED")
    && "questionSet" in value && value.questionSet && typeof value.questionSet === "object"
    && "questions" in value.questionSet && Array.isArray(value.questionSet.questions)
    && "answers" in value && Array.isArray(value.answers));
}

export function QuizClient({ questionSetId }: { questionSetId: string }) {
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal, showLoading = true) => {
    if (signal?.aborted) return;
    if (showLoading) setLoading(true);
    setError("");
    try {
      const createResponse = await fetch(`/api/question-sets/${encodeURIComponent(questionSetId)}/attempt`, { method: "POST", signal });
      if (!createResponse.ok) throw new Error(await apiError(createResponse));
      const created: unknown = await createResponse.json();
      if (!created || typeof created !== "object" || !("attempt" in created) || !created.attempt
        || typeof created.attempt !== "object" || !("id" in created.attempt) || typeof created.attempt.id !== "string") {
        throw new Error("The quiz response was invalid.");
      }
      const response = await fetch(`/api/quiz-attempts/${encodeURIComponent(created.attempt.id)}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(await apiError(response));
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("attempt" in payload) || !isAttempt(payload.attempt)) {
        throw new Error("The quiz response was invalid.");
      }
      if (signal?.aborted) return;
      const answers = Object.fromEntries(payload.attempt.answers.map((answer) => [answer.questionId, answer.text]));
      setAttempt(payload.attempt);
      setDrafts(answers);
      setSaved(answers);
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : "Could not load the quiz.");
    } finally {
      if (!signal?.aborted && showLoading) setLoading(false);
    }
  }, [questionSetId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  async function saveQuestion(questionId: string, answerText?: string) {
    if (!attempt || saving || submitting) return false;
    const text = answerText ?? drafts[questionId] ?? "";
    if (text.length > 5000) { setError("Answers must be 5,000 characters or fewer."); return false; }
    if (text.trim() === (saved[questionId] ?? "")) return true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/quiz-attempts/${encodeURIComponent(attempt.id)}/answers/${encodeURIComponent(questionId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      setSaved((items) => ({ ...items, [questionId]: text.trim() }));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the answer.");
      return false;
    } finally { setSaving(false); }
  }

  async function move(nextIndex: number) {
    const question = attempt?.questionSet.questions[index];
    if (!question || !(await saveQuestion(question.id))) return;
    setIndex(nextIndex);
    setReviewing(nextIndex >= (attempt?.questionSet.questions.length ?? 0));
    setConfirming(false);
  }

  async function submit() {
    if (!attempt || saving || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/quiz-attempts/${encodeURIComponent(attempt.id)}/submit`, { method: "POST" });
      if (!response.ok) throw new Error(await apiError(response));
      setAttempt({ ...attempt, status: "SUBMITTED", submittedAt: new Date().toISOString() });
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit the quiz.");
    } finally { setSubmitting(false); }
  }

  async function grade() {
    if (!attempt || grading) return;
    setGrading(true);
    setError("");
    try {
      const response = await fetch(`/api/quiz-attempts/${encodeURIComponent(attempt.id)}/grade`, { method: "POST" });
      if (!response.ok) throw new Error(await apiError(response));
      await load(undefined, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not grade the quiz.");
    } finally { setGrading(false); }
  }

  if (loading) return <div aria-label="Loading quiz" className="space-y-4 rounded-3xl border border-border bg-card p-6 sm:p-8">
    <div className="h-6 w-1/3 animate-pulse rounded bg-[#F1F1F3]" /><div className="h-8 w-2/3 animate-pulse rounded bg-[#F1F1F3]" />
    <div className="h-28 animate-pulse rounded-xl bg-[#F1F1F3]" />
  </div>;

  if (!attempt) return <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
    <h1 className="text-2xl font-bold">Quiz unavailable</h1>
    <p role="alert" className="mt-3 text-sm text-red-700">{error || "Could not load the quiz."}</p>
    <Button className="mt-5" onClick={() => void load()}>Try again</Button>
  </div>;

  const questions = attempt.questionSet.questions;
  const question = questions[index];
  const unanswered = questions.filter((item) => !(drafts[item.id] ?? "").trim());
  const questionTypes = new Set(questions.map((item) => item.type));
  const quizTitle = questions.length === 0
    ? "Quiz"
    : questionTypes.size > 1
    ? "Mixed question quiz"
    : questionTypes.has("MULTIPLE_CHOICE")
      ? "Multiple-choice quiz"
      : questionTypes.has("TRUE_FALSE")
        ? "True/False quiz"
        : "Short-answer quiz";

  if (attempt.status === "SUBMITTED") {
    const resultAnswers = questions.map((item) => ({
      question: item,
      answer: attempt.answers.find((answer) => answer.questionId === item.id),
    }));
    const correct = resultAnswers.filter(({ answer }) => answer?.isCorrect && !answer.needsReview).length;
    const partial = resultAnswers.filter(({ answer }) => !answer?.needsReview && !answer?.isCorrect && (answer?.scoreRatio ?? 0) > 0).length;
    const incorrect = resultAnswers.filter(({ answer }) => !answer?.needsReview && answer?.scoreRatio === 0).length;
    const needsReview = resultAnswers.filter(({ answer }) => answer?.needsReview).length;

    if (attempt.gradingStatus === "GRADED") return <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-card p-7 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-9">
        <p className="text-sm font-bold text-primary">Quiz results</p>
        <h1 className="mt-2 break-words text-2xl font-bold">{attempt.questionSet.document.fileName}</h1>
        <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl bg-[#FFF8EE] p-5 sm:col-span-2"><p className="text-sm text-muted">Total score</p><p className="mt-2 text-3xl font-bold">{attempt.totalScore ?? 0} <span className="text-lg text-muted">/ {attempt.maximumScore ?? 0}</span></p></div>
          <div className="rounded-2xl border border-border p-5"><p className="text-sm text-muted">Difficulty bonus earned</p><p className="mt-2 text-2xl font-bold">{attempt.bonusScore ?? 0}</p></div>
          <div className="rounded-2xl border border-border p-5"><p className="text-sm text-muted">Base score</p><p className="mt-2 text-2xl font-bold">{attempt.baseScore ?? 0}</p></div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <p className="rounded-xl bg-green-50 p-3 font-semibold text-green-700">Correct: {correct}</p>
          <p className="rounded-xl bg-amber-50 p-3 font-semibold text-amber-700">Partial: {partial}</p>
          <p className="rounded-xl bg-red-50 p-3 font-semibold text-red-700">Incorrect: {incorrect}</p>
          <p className="rounded-xl bg-amber-50 p-3 font-semibold text-amber-700">Needs review: {needsReview}</p>
        </div>
      </section>
      <section className="space-y-4" aria-label="Answer results">
        {resultAnswers.map(({ question: item, answer }) => {
          const maximum = (answer?.basePoints ?? 1) + (answer?.bonusPoints ?? 0);
          const state = answer?.needsReview ? "review" : answer?.isCorrect ? "correct" : (answer?.scoreRatio ?? 0) > 0 ? "partial" : "incorrect";
          const styles = state === "correct" ? "border-green-200 bg-green-50/50" : state === "incorrect" ? "border-red-200 bg-red-50/50" : "border-amber-200 bg-amber-50/50";
          const Icon = state === "correct" ? CheckCircle2 : state === "incorrect" ? XCircle : AlertCircle;
          const label = state === "correct" ? "Correct" : state === "incorrect" ? "Incorrect" : state === "review" ? "Needs review" : "Partially correct";
          return <article key={item.id} className={`rounded-2xl border p-5 sm:p-6 ${styles}`}>
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-xs font-bold uppercase tracking-wide text-muted">Question {item.position}</p><h2 dir="auto" className="mt-2 whitespace-pre-wrap font-semibold leading-7">{item.text}</h2></div>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-bold"><Icon aria-hidden="true" className="size-4" />{label}</span>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto]">
              <div><p className="text-xs font-bold text-muted">Your answer</p><p dir="auto" className="mt-1 whitespace-pre-wrap text-sm leading-7">{answer?.text}</p></div>
              <p className="text-sm font-bold">{answer?.earnedPoints ?? 0} / {maximum} points</p>
            </div>
            {item.type !== "SHORT_ANSWER" && item.correctAnswer && (
              <div className="mt-4 border-t border-current/10 pt-4"><p className="text-xs font-bold text-muted">Correct answer</p><p dir="auto" className="mt-1 text-sm font-semibold">{item.correctAnswer}</p></div>
            )}
            <div className="mt-4 border-t border-current/10 pt-4"><p className="text-xs font-bold text-muted">Feedback</p><p dir="auto" className="mt-1 whitespace-pre-wrap text-sm leading-7">{answer?.feedback}</p></div>
          </article>;
        })}
      </section>
      <Link href="/documents" className={buttonStyles({ variant: "secondary" })}>Back to documents</Link>
    </div>;

    return <div className="rounded-3xl border border-border bg-card p-7 text-center shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-10">
      <CheckCircle2 aria-hidden="true" className="mx-auto size-12 text-primary" />
      <h1 className="mt-5 text-2xl font-bold">Answers submitted</h1>
      <p className="mt-3 text-sm leading-7 text-muted">Your answers were saved successfully. Grade them against the document&apos;s educational source when you are ready.</p>
      {attempt.gradingStatus === "GRADING" && <p className="mt-4 text-sm font-semibold text-primary">This attempt is being graded.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <Button onClick={() => void grade()} disabled={grading}>
          {grading ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Sparkles aria-hidden="true" className="size-4" />}
          {grading ? "Grading answers..." : error || attempt.gradingStatus === "GRADING" ? "Retry grading" : "Grade my answers"}
        </Button>
        <Link href="/documents" className={buttonStyles({ variant: "secondary" })}>Back to documents</Link>
      </div>
    </div>;
  }

  return <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8">
    <p className="text-sm font-bold text-primary">{quizTitle}</p>
    <h1 className="mt-1 break-words text-2xl font-bold">{attempt.questionSet.document.fileName}</h1>
    <p className="mt-2 text-sm text-muted">{reviewing ? "Review your answers" : `Question ${index + 1} of ${questions.length}`}</p>
    <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#F1F1F3]" role="progressbar" aria-valuenow={reviewing ? questions.length : index + 1} aria-valuemin={0} aria-valuemax={questions.length}>
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${questions.length ? ((reviewing ? questions.length : index + 1) / questions.length) * 100 : 0}%` }} />
    </div>

    {reviewing ? <div className="mt-8">
      <h2 className="text-lg font-bold">Final review</h2>
      <p className="mt-2 text-sm text-muted">Check your answers before submitting. Unanswered questions are marked below.</p>
      <ol className="mt-5 space-y-3">{questions.map((item, itemIndex) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
        <span className="min-w-0 text-sm font-semibold">Question {itemIndex + 1}: <span dir="auto" className="break-words">{item.text}</span></span>
        <Button size="sm" variant="secondary" onClick={() => { setIndex(itemIndex); setReviewing(false); setConfirming(false); }} disabled={submitting}>
          {(drafts[item.id] ?? "").trim() ? "Edit answer" : "Unanswered — answer now"}
        </Button>
      </li>)}</ol>
      {questions.length === 0 && <p role="alert" className="mt-5 text-sm text-red-700">This quiz has no questions.</p>}
      {unanswered.length > 0 && <p role="alert" className="mt-5 text-sm text-red-700">{unanswered.length} question{unanswered.length === 1 ? " is" : "s are"} unanswered.</p>}
      {error && <p role="alert" className="mt-5 text-sm text-red-700">{error}</p>}
      {confirming && <div className="mt-6 rounded-2xl border border-primary/30 bg-[#FFF8EE] p-5">
        <p className="text-sm font-semibold">Submit your answers? You cannot edit them afterward.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button onClick={() => void submit()} disabled={submitting || unanswered.length > 0 || questions.length === 0}>
            {submitting && <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />}{submitting ? "Submitting..." : "Confirm submission"}
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={submitting}>Cancel</Button>
        </div>
      </div>}
      <div className="mt-7 flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => { setReviewing(false); setIndex(questions.length - 1); }} disabled={submitting || questions.length === 0}><ArrowLeft aria-hidden="true" className="size-4" />Previous</Button>
        {!confirming && <Button onClick={() => setConfirming(true)} disabled={submitting || unanswered.length > 0 || questions.length === 0}>Submit answers</Button>}
      </div>
    </div> : question ? <div className="mt-8">
      <h2 dir="auto" className="whitespace-pre-wrap break-words text-lg font-semibold leading-8">{question.text}</h2>
      {question.type === "SHORT_ANSWER" ? <>
        <label htmlFor="quiz-answer" className="mt-6 block text-sm font-semibold">Your answer</label>
        <textarea id="quiz-answer" dir="auto" rows={7} maxLength={5000} value={drafts[question.id] ?? ""}
          onChange={(event) => { setDrafts((items) => ({ ...items, [question.id]: event.target.value })); setError(""); }}
          disabled={saving || submitting} placeholder="Write your answer here..."
          className="mt-2 w-full resize-y rounded-2xl border border-border bg-white p-4 text-sm leading-7 outline-none transition focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60" />
      </> : <fieldset className="mt-6" disabled={saving || submitting}>
        <legend className="text-sm font-semibold">Select one answer</legend>
        <div className="mt-3 grid gap-3">
          {(question.options ?? []).map((option) => {
            const selected = drafts[question.id] === option;
            return <label key={option} className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition focus-within:ring-4 focus-within:ring-primary/20 ${selected ? "border-primary bg-[#FFF8EE]" : "border-border bg-white hover:border-primary/50"}`}>
              <input
                type="radio"
                name={`question-${question.id}`}
                value={option}
                checked={selected}
                onChange={() => {
                  setDrafts((items) => ({ ...items, [question.id]: option }));
                  setError("");
                  void saveQuestion(question.id, option);
                }}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span dir="auto" className="min-w-0 break-words text-sm leading-7">{option}</span>
            </label>;
          })}
        </div>
      </fieldset>}
      <p aria-live="polite" className="mt-2 text-sm text-muted">{saving ? "Saving..." : (drafts[question.id] ?? "").trim() === (saved[question.id] ?? "") ? "Saved" : "Unsaved changes"}</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-7 flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => void move(index - 1)} disabled={index === 0 || saving || submitting}><ArrowLeft aria-hidden="true" className="size-4" />Previous</Button>
        <Button variant="secondary" onClick={() => void saveQuestion(question.id)} disabled={saving || submitting || (drafts[question.id] ?? "").trim() === (saved[question.id] ?? "")}>
          {saving && <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />}Save answer
        </Button>
        <Button onClick={() => void move(index + 1)} disabled={saving || submitting}>{index + 1 === questions.length ? "Review answers" : "Next"}<ArrowRight aria-hidden="true" className="size-4" /></Button>
      </div>
    </div> : <p role="alert" className="mt-6 text-sm text-red-700">This quiz has no questions.</p>}
  </div>;
}
