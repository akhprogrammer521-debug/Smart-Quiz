import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ questionSetId: string }> };
const updateSchema = z.union([
  z.object({ name: z.string().trim().min(2).max(100) }).strict(),
  z.object({ restore: z.literal(true) }).strict(),
]);

function apiError(error: string, errorAr: string, status: number) {
  return NextResponse.json({ error, errorAr }, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function currentUserId() {
  const session = await auth();
  if (!session?.user?.email) return null;
  const user = await db.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  return user?.id ?? null;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  try {
    const user = await db.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const { questionSetId } = await params;
    const questionSet = await db.questionSet.findFirst({
      where: { id: questionSetId, userId: user.id, deletedAt: null, document: { userId: user.id, deletedAt: null } },
      include: { questions: { orderBy: { position: "asc" } } },
    });
    if (!questionSet) return apiError("Question set not found.", "مجموعة الأسئلة غير موجودة.", 404);

    return NextResponse.json({ questionSet }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not load this question set. Please try again.", "تعذّر تحميل مجموعة الأسئلة. يرجى المحاولة مجدداً.", 503);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const userId = await currentUserId();
  if (!userId) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);
  const body: unknown = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return apiError("Enter a name between 2 and 100 characters.", "أدخل اسمًا بين حرفين و100 حرف.", 400);
  try {
    const { questionSetId } = await params;
    const owned = await db.questionSet.findFirst({
      where: { id: questionSetId, userId, document: { userId } },
      select: { id: true },
    });
    if (!owned) return apiError("Question set not found.", "مجموعة الأسئلة غير موجودة.", 404);
    const questionSet = await db.questionSet.update({
      where: { id: questionSetId },
      data: "restore" in parsed.data ? { deletedAt: null } : { name: parsed.data.name },
      select: { id: true, name: true, deletedAt: true },
    });
    return NextResponse.json({ questionSet }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not update the question set.", "تعذّر تحديث مجموعة الأسئلة.", 503);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const userId = await currentUserId();
  if (!userId) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);
  try {
    const { questionSetId } = await params;
    const archived = await db.questionSet.updateMany({
      where: { id: questionSetId, userId, deletedAt: null, document: { userId } },
      data: { deletedAt: new Date() },
    });
    if (archived.count === 0) {
      const owned = await db.questionSet.findFirst({ where: { id: questionSetId, userId }, select: { id: true } });
      if (!owned) return apiError("Question set not found.", "مجموعة الأسئلة غير موجودة.", 404);
    }
    return NextResponse.json({ archived: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not archive the question set.", "تعذّر أرشفة مجموعة الأسئلة.", 503);
  }
}
