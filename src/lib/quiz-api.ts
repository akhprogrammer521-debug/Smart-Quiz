import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const privateHeaders = { "Cache-Control": "private, no-store" };

export function quizError(error: string, errorAr: string, status: number) {
  return NextResponse.json({ error, errorAr }, { status, headers: privateHeaders });
}

export function quizJson(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: privateHeaders });
}

export async function getQuizUser() {
  const session = await auth();
  if (!session?.user?.email) return null;
  return db.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
}
