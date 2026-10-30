import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ documentId: string }> };
const updateSchema = z.union([
  z.object({ displayName: z.string().trim().min(2).max(150) }).strict(),
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

function documentJson(document: {
  id: string; fileName: string; displayName: string | null; mimeType: string; fileSize: number;
  status: "UPLOADED" | "PROCESSING" | "READY" | "FAILED"; createdAt: Date; deletedAt: Date | null;
}) {
  return { ...document, createdAt: document.createdAt.toISOString(), deletedAt: document.deletedAt?.toISOString() ?? null };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const userId = await currentUserId();
  if (!userId) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);
  try {
    const { documentId } = await params;
    const document = await db.document.findFirst({
      where: { id: documentId, userId },
      select: { id: true, fileName: true, displayName: true, mimeType: true, fileSize: true, status: true, createdAt: true, deletedAt: true },
    });
    if (!document) return apiError("Document not found.", "المستند غير موجود.", 404);
    return NextResponse.json({ document: documentJson(document) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not load the document.", "تعذّر تحميل المستند.", 503);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const userId = await currentUserId();
  if (!userId) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);
  const body: unknown = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return apiError("Enter a display name between 2 and 150 characters.", "أدخل اسم عرض بين حرفين و150 حرفًا.", 400);
  try {
    const { documentId } = await params;
    const owned = await db.document.findFirst({ where: { id: documentId, userId }, select: { id: true } });
    if (!owned) return apiError("Document not found.", "المستند غير موجود.", 404);
    const document = await db.document.update({
      where: { id: documentId },
      data: "restore" in parsed.data ? { deletedAt: null } : { displayName: parsed.data.displayName },
      select: { id: true, fileName: true, displayName: true, mimeType: true, fileSize: true, status: true, createdAt: true, deletedAt: true },
    });
    return NextResponse.json({ document: documentJson(document) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not update the document.", "تعذّر تحديث المستند.", 503);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const userId = await currentUserId();
  if (!userId) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);
  try {
    const { documentId } = await params;
    const archived = await db.document.updateMany({
      where: { id: documentId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (archived.count === 0) {
      const owned = await db.document.findFirst({ where: { id: documentId, userId }, select: { id: true } });
      if (!owned) return apiError("Document not found.", "المستند غير موجود.", 404);
    }
    return NextResponse.json({ archived: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return apiError("Could not archive the document.", "تعذّر أرشفة المستند.", 503);
  }
}
