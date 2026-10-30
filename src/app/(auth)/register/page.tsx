"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { registerSchema } from "@/lib/validation";

type Field = "name" | "email" | "password";
type FieldErrors = Partial<Record<Field, string>>;

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError("");

    const parsed = registerSchema.safeParse({ name, email, password });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "name" || field === "email" || field === "password") && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        const payload: unknown = await response.json();
        const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Unable to create your account. Please try again.";
        setServerError(message);
        return;
      }

      router.replace("/login");
    } catch {
      setServerError("Unable to create your account. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-[calc(100vh-9rem)] items-center justify-center px-5 py-16 sm:px-8">
      <div className="w-full max-w-md rounded-[2rem] border border-border bg-card p-7 shadow-[0_18px_50px_-38px_rgba(38,38,38,0.35)] sm:p-10">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary">
          <UserRoundPlus aria-hidden="true" className="size-6" />
        </span>
        <p className="mt-7 text-sm font-bold text-primary">Start learning with purpose</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Create your account</h1>
        <p className="mt-3 text-sm leading-6 text-muted">Your SmartQuiz learning space starts here.</p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="register-name" className="mb-2 block text-sm font-semibold">Full name</label>
            <input
              id="register-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFieldErrors((errors) => ({ ...errors, name: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? "register-name-error" : undefined}
              className="h-12 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none transition-colors placeholder:text-[#A3A3A3] hover:border-[#FFD39A] focus:border-primary focus:ring-4 focus:ring-primary/15 aria-invalid:border-red-400"
              placeholder="Your full name"
            />
            {fieldErrors.name && <p id="register-name-error" className="mt-2 text-sm text-red-600">{fieldErrors.name}</p>}
          </div>

          <div>
            <label htmlFor="register-email" className="mb-2 block text-sm font-semibold">Email address</label>
            <input
              id="register-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((errors) => ({ ...errors, email: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? "register-email-error" : undefined}
              className="h-12 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none transition-colors placeholder:text-[#A3A3A3] hover:border-[#FFD39A] focus:border-primary focus:ring-4 focus:ring-primary/15 aria-invalid:border-red-400"
              placeholder="you@example.com"
            />
            {fieldErrors.email && <p id="register-email-error" className="mt-2 text-sm text-red-600">{fieldErrors.email}</p>}
          </div>

          <div>
            <label htmlFor="register-password" className="mb-2 block text-sm font-semibold">Password</label>
            <input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((errors) => ({ ...errors, password: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? "register-password-error" : "register-password-help"}
              className="h-12 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none transition-colors placeholder:text-[#A3A3A3] hover:border-[#FFD39A] focus:border-primary focus:ring-4 focus:ring-primary/15 aria-invalid:border-red-400"
              placeholder="At least 8 characters"
            />
            {fieldErrors.password ? (
              <p id="register-password-error" className="mt-2 text-sm text-red-600">{fieldErrors.password}</p>
            ) : (
              <p id="register-password-help" className="mt-2 text-xs text-muted">Use at least 8 characters.</p>
            )}
          </div>

          {serverError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{serverError}</p>}

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <ArrowRight aria-hidden="true" className="size-4 rtl:rotate-180" />}
            {isSubmitting ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="mt-7 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className="rounded-sm font-semibold text-primary transition-colors hover:text-primary-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25">Log in</Link>
        </p>
      </div>
    </section>
  );
}
