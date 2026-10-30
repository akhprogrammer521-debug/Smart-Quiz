import Link from "next/link";
import { GraduationCap } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-border bg-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-9 text-sm text-muted sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12">
        <Link href="/" className="inline-flex w-fit items-center gap-2 rounded-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25">
          <GraduationCap aria-hidden="true" className="size-5 text-primary" />
          SmartQuiz
        </Link>
        <p>Helping curious minds learn with purpose.</p>
        <p>© {new Date().getFullYear()} SmartQuiz</p>
      </div>
    </footer>
  );
}
