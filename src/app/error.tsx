"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[55vh] items-center justify-center px-5 py-16">
      <div className="w-full max-w-md rounded-3xl border border-border bg-white p-8 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><AlertCircle aria-hidden="true" className="size-7" /></span>
        <h1 className="mt-6 text-2xl font-bold">Something went wrong</h1>
        <p className="mt-3 text-sm leading-6 text-muted">We could not load this page. Please try again.</p>
        <Button className="mt-7" onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
