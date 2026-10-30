"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, GraduationCap, Menu, X } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";

const links = [
  { href: "/#features", label: "Why SmartQuiz" },
  { href: "/#how-it-works", label: "How it works" },
];

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-18 max-w-7xl items-center justify-between gap-6 px-5 sm:px-8 lg:px-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 rounded-lg text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25"
          aria-label="SmartQuiz home"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-white">
            <GraduationCap aria-hidden="true" className="size-6" strokeWidth={2.2} />
          </span>
          <span className="text-xl font-bold tracking-tight">Smart<span className="text-primary">Quiz</span></span>
        </Link>

        <nav aria-label="Main navigation" className="hidden items-center gap-8 lg:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md text-sm font-medium text-muted transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Link href="/login" className={buttonStyles({ variant: "ghost", size: "sm" })}>Log in</Link>
          <Link href="/register" className={buttonStyles({ size: "sm" })}>
            Get started <ArrowRight aria-hidden="true" className="size-4 rtl:rotate-180" />
          </Link>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-controls="mobile-navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        </Button>
      </div>

      {menuOpen && (
        <nav id="mobile-navigation" aria-label="Mobile navigation" className="border-t border-border bg-white px-5 py-4 lg:hidden">
          <div className="mx-auto flex max-w-7xl flex-col gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-3 text-sm font-medium text-foreground transition-colors hover:bg-[#FFF4E5] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25"
              >
                {link.label}
              </Link>
            ))}
            <div className="mt-3 flex gap-2 border-t border-border pt-4">
              <Link href="/login" onClick={() => setMenuOpen(false)} className={buttonStyles({ variant: "secondary", size: "sm", className: "flex-1" })}>Log in</Link>
              <Link href="/register" onClick={() => setMenuOpen(false)} className={buttonStyles({ size: "sm", className: "flex-1" })}>Get started</Link>
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}
