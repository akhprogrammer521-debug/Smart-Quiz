export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-5" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm font-medium text-muted">
        <span aria-hidden="true" className="size-5 rounded-full border-2 border-[#FFDDAA] border-t-primary motion-safe:animate-spin" />
        Loading SmartQuiz…
      </div>
    </div>
  );
}
