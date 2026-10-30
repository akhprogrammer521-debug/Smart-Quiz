import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { QuizClient } from "@/components/documents/quiz-client";
import { auth } from "@/lib/auth";

type PageProps = { params: Promise<{ questionSetId: string }> };

export default async function QuizPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const { questionSetId } = await params;
  return (
    <section className="mx-auto min-h-[calc(100vh-9rem)] max-w-5xl px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
      <DashboardNav active="documents" />
      <QuizClient questionSetId={questionSetId} />
    </section>
  );
}
