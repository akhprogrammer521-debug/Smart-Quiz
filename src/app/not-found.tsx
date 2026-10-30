import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[55vh] items-center justify-center px-5 py-16">
      <div className="w-full max-w-md rounded-3xl border border-border bg-white p-8 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><SearchX aria-hidden="true" className="size-7" /></span>
        <p className="mt-6 text-sm font-bold text-primary">404</p>
        <h1 className="mt-2 text-2xl font-bold">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-muted">The page you are looking for does not exist.</p>
        <Link href="/" className={buttonStyles({ className: "mt-7" })}>Back to home</Link>
      </div>
    </div>
  );
}
