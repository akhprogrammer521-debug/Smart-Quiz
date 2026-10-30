"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loginSchema } from "@/lib/validation";

type Field = "email" | "password";
type FieldErrors = Partial<Record<Field, string>>;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError("");

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "email" || field === "password") && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const result = await signIn("credentials", {
        email: parsed.data.email,
        password: parsed.data.password,
        redirect: false,
      });

      if (result?.error) {
        setServerError("Invalid email or password.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setServerError("Unable to sign in right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-[calc(100vh-9rem)] items-center justify-center px-5 py-16 sm:px-8">
      <div className="w-full max-w-md rounded-[2rem] border border-border bg-card p-7 shadow-[0_18px_50px_-38px_rgba(38,38,38,0.35)] sm:p-10">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary">
          <LockKeyhole aria-hidden="true" className="size-6" />
        </span>
        <p className="mt-7 text-sm font-bold text-primary">Welcome back</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Log in to SmartQuiz</h1>
        <p className="mt-3 text-sm leading-6 text-muted">Continue your learning journey.</p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="login-email" className="mb-2 block text-sm font-semibold">Email address</label>
            <input
              id="login-email"
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
              aria-describedby={fieldErrors.email ? "login-email-error" : undefined}
              className="h-12 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none transition-colors placeholder:text-[#A3A3A3] hover:border-[#FFD39A] focus:border-primary focus:ring-4 focus:ring-primary/15 aria-invalid:border-red-400"
              placeholder="you@example.com"
            />
            {fieldErrors.email && <p id="login-email-error" className="mt-2 text-sm text-red-600">{fieldErrors.email}</p>}
          </div>

          <div>
            <label htmlFor="login-password" className="mb-2 block text-sm font-semibold">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((errors) => ({ ...errors, password: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
              className="h-12 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none transition-colors placeholder:text-[#A3A3A3] hover:border-[#FFD39A] focus:border-primary focus:ring-4 focus:ring-primary/15 aria-invalid:border-red-400"
              placeholder="Enter your password"
            />
            {fieldErrors.password && <p id="login-password-error" className="mt-2 text-sm text-red-600">{fieldErrors.password}</p>}
          </div>

          {serverError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{serverError}</p>}

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <ArrowRight aria-hidden="true" className="size-4 rtl:rotate-180" />}
            {isSubmitting ? "Logging in…" : "Log in"}
          </Button>
        </form>

        <p className="mt-7 text-center text-sm text-muted">
          New to SmartQuiz?{" "}
          <Link href="/register" className="rounded-sm font-semibold text-primary transition-colors hover:text-primary-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25">Create an account</Link>
        </p>
      </div>
    </section>
  );
}
