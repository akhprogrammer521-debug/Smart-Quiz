import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  BookOpenText,
  FileText,
  Lightbulb,
  Sparkles,
} from "lucide-react";
import { buttonStyles } from "@/components/ui/button";

const steps = [
  {
    number: "01",
    title: "Bring your material",
    description: "Start with the lessons and documents you already study from.",
    icon: FileText,
  },
  {
    number: "02",
    title: "Find the key ideas",
    description: "Get a clearer view of the concepts that deserve your attention.",
    icon: BookOpenText,
  },
  {
    number: "03",
    title: "Practice with purpose",
    description: "Turn what you have learned into questions you can work through.",
    icon: Lightbulb,
  },
  {
    number: "04",
    title: "See your progress",
    description: "Understand your strengths and where to focus next.",
    icon: BarChart3,
  },
];

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border bg-white">
        <div aria-hidden="true" className="pointer-events-none absolute -end-32 -top-48 size-150 rounded-full bg-[#FFF4E5] blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-12 lg:py-32">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#FFE0B2] bg-[#FFF8EE] px-3.5 py-2 text-xs font-semibold tracking-wide text-[#A65D00]">
              <Sparkles aria-hidden="true" className="size-4" />
              A better study rhythm starts here
            </span>
            <h1 className="mt-7 text-4xl leading-[1.12] font-bold tracking-tight text-foreground sm:text-5xl lg:text-[3.7rem]">
              Learn deeply.
              <br />
              Practice confidently.
              <br />
              <span className="text-primary">Grow every day.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-muted sm:text-lg">
              SmartQuiz is being shaped into one calm space for turning study material into clear ideas, meaningful practice, and useful insight.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="#how-it-works" className={buttonStyles({ className: "h-13 px-6" })}>
                See how it will work <ArrowRight aria-hidden="true" className="size-4 rtl:rotate-180" />
              </Link>
              <Link href="#features" className={buttonStyles({ variant: "secondary", className: "h-13 px-6" })}>
                Explore the vision
              </Link>
            </div>
            <p className="mt-6 text-sm text-muted">A simple foundation for a more focused way to learn.</p>
          </div>

          <div className="relative mx-auto w-full max-w-xl lg:mx-0">
            <div aria-hidden="true" className="absolute -inset-4 rounded-[2.5rem] bg-[#FFF4E5]/70 blur-xl" />
            <div className="relative overflow-hidden rounded-[2rem] border border-[#F4E9D9] bg-white p-5 shadow-[0_24px_70px_-35px_rgba(80,54,20,0.26)] sm:p-7">
              <div className="flex items-center justify-between border-b border-border pb-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-[#FFF3E0] text-primary">
                    <Sparkles aria-hidden="true" className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-bold">A more connected way to study</p>
                    <p className="mt-0.5 text-xs text-muted">The SmartQuiz vision</p>
                  </div>
                </div>
                <span className="hidden rounded-full bg-[#FFF8EE] px-3 py-1.5 text-xs font-medium text-[#A65D00] sm:inline-flex">Coming together</span>
              </div>

              <div className="relative space-y-3 pt-6">
                <div aria-hidden="true" className="absolute bottom-8 start-6 top-9 w-px bg-[#FFE2BA]" />
                {steps.map((step) => {
                  const Icon = step.icon;
                  return (
                    <div key={step.number} className="relative flex items-center gap-4 rounded-2xl border border-border bg-white p-4 shadow-[0_7px_22px_-18px_rgba(38,38,38,0.5)]">
                      <span className="z-10 flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#FFF6E9] text-primary">
                        <Icon aria-hidden="true" className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-primary">STEP {step.number}</p>
                        <p className="mt-0.5 text-sm font-semibold text-foreground sm:text-base">{step.title}</p>
                      </div>
                      <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-[#B8B8B8] rtl:rotate-180" />
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 rounded-xl bg-[#FFF8EE] px-4 py-3 text-center text-xs font-medium text-[#9A620F]">
                Everything you need to move from reading to understanding.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-sm font-bold tracking-wide text-primary uppercase">Built around learning</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">A clearer path from study to progress</h2>
            <p className="mt-4 text-base leading-7 text-muted">Good learning takes more than reading. SmartQuiz will help make every step feel connected and intentional.</p>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            <article className="rounded-3xl border border-border bg-card p-7 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)]">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><BookOpenText aria-hidden="true" className="size-6" /></span>
              <h3 className="mt-6 text-lg font-bold">Understand the essentials</h3>
              <p className="mt-3 text-sm leading-7 text-muted">See the main ideas in your material so you can study with a sense of direction.</p>
            </article>
            <article className="rounded-3xl border border-border bg-card p-7 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)]">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><Lightbulb aria-hidden="true" className="size-6" /></span>
              <h3 className="mt-6 text-lg font-bold">Make knowledge stick</h3>
              <p className="mt-3 text-sm leading-7 text-muted">Practice with relevant questions and strengthen what you have learned.</p>
            </article>
            <article className="rounded-3xl border border-border bg-card p-7 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)]">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><BarChart3 aria-hidden="true" className="size-6" /></span>
              <h3 className="mt-6 text-lg font-bold">Know what comes next</h3>
              <p className="mt-3 text-sm leading-7 text-muted">Use a view of your progress to choose what needs another look.</p>
            </article>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-24 bg-white px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div className="max-w-2xl">
              <p className="text-sm font-bold tracking-wide text-primary uppercase">The planned journey</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Four steps, one learning flow</h2>
              <p className="mt-4 text-base leading-7 text-muted">From your own material to a better understanding of where you stand.</p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs font-semibold text-muted">
              <Sparkles aria-hidden="true" className="size-4 text-primary" />
              In development
            </span>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.number} className="rounded-2xl border border-border bg-background p-6">
                  <div className="flex items-start justify-between">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-white text-primary"><Icon aria-hidden="true" className="size-5" /></span>
                    <span className="text-sm font-bold text-[#C4C4C4]">{step.number}</span>
                  </div>
                  <h3 className="mt-8 text-base font-bold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{step.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="px-5 py-20 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-foreground px-7 py-12 text-white sm:px-12 sm:py-14 lg:flex lg:items-center lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="text-sm font-bold tracking-wide text-[#FFC36F] uppercase">SmartQuiz is taking shape</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">A more thoughtful way to learn is on its way.</h2>
            <p className="mt-4 text-sm leading-7 text-white/70 sm:text-base">We are building the foundation for a focused study experience, one useful step at a time.</p>
          </div>
          <Link href="#main-content" className={buttonStyles({ variant: "primary", className: "mt-8 shrink-0 lg:mt-0" })}>
            Back to the top <ArrowRight aria-hidden="true" className="size-4 -rotate-90" />
          </Link>
        </div>
      </section>
    </>
  );
}
