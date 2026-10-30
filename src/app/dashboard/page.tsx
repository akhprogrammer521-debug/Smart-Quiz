import { redirect } from "next/navigation";
import { BookOpenText, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const user = await db.user.findUnique({
    where: { email: session.user.email },
    select: { name: true, email: true, role: true },
  });
  if (!user) redirect("/login");

  return (
    <section className="mx-auto min-h-[calc(100vh-9rem)] max-w-7xl px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
      <DashboardNav active="dashboard" />
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-bold text-primary">Your learning space</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Welcome, {user.name}</h1>
          <p className="mt-3 text-sm leading-6 text-muted">Your SmartQuiz account is ready.</p>
        </div>
        <form action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}>
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            <LogOut aria-hidden="true" className="size-4" /> Log out
          </Button>
        </form>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="rounded-3xl border border-border bg-card p-7 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary"><UserRound aria-hidden="true" className="size-6" /></span>
          <h2 className="mt-6 text-xl font-bold">Your account</h2>
          <dl className="mt-6 divide-y divide-border text-sm">
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-5"><dt className="text-muted">Name</dt><dd className="font-semibold break-words">{user.name}</dd></div>
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-5"><dt className="text-muted">Email</dt><dd className="font-semibold break-all">{user.email}</dd></div>
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-5"><dt className="text-muted">Role</dt><dd className="inline-flex items-center gap-1.5 font-semibold"><ShieldCheck aria-hidden="true" className="size-4 text-primary" />{user.role === "STUDENT" ? "Student" : "Admin"}</dd></div>
          </dl>
        </div>

        <div className="rounded-3xl border border-border bg-[#FFF8EE] p-7 sm:p-8">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-white text-primary"><BookOpenText aria-hidden="true" className="size-6" /></span>
          <h2 className="mt-6 text-xl font-bold">Your study tools are coming next</h2>
          <p className="mt-3 max-w-xl text-sm leading-7 text-muted">This dashboard is ready for summaries, quizzes, and progress insights as those features are built. For now, your account details and secure sign-in are in place.</p>
        </div>
      </div>
    </section>
  );
}
