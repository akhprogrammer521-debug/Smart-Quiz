import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { DocumentsClient } from "@/components/documents/documents-client";
import { auth } from "@/lib/auth";

export default async function DocumentsPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  return (
    <section className="mx-auto min-h-[calc(100vh-9rem)] max-w-7xl px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
      <DashboardNav active="documents" />
      <div className="mb-9">
        <p className="text-sm font-bold text-primary">Your learning library</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">My Documents</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          Keep your study materials in one private place and create summaries when you need them.
        </p>
      </div>
      <DocumentsClient />
    </section>
  );
}
