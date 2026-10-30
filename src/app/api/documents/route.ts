import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getDocumentExtension,
  getDocumentMimeType,
  MAX_DOCUMENT_SIZE,
  validateDocumentFile,
} from "@/lib/document-file";
import { getPrivateStorage } from "@/lib/supabase-storage";

export const runtime = "nodejs";

function apiError(error: string, errorAr: string, status: number) {
  return NextResponse.json({ error, errorAr }, { status });
}

function hasValidContent(file: Buffer, extension: string) {
  if (extension === "pdf") return file.subarray(0, 5).toString() === "%PDF-";
  if (extension === "docx") return file.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (extension === "doc") return file.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (extension === "png") return file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === "jpg" || extension === "jpeg") {
    return file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
  }
  if (extension === "txt") {
    if (file.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(file);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  try {
    const user = await db.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    });
    if (!user) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const archived = new URL(request.url).searchParams.get("archived") === "true";
    const documents = await db.document.findMany({
      where: { userId: user.id, deletedAt: archived ? { not: null } : null },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, displayName: true, mimeType: true, fileSize: true, status: true, createdAt: true, deletedAt: true },
    });

    return NextResponse.json(
      { documents: documents.map((document) => ({ ...document, createdAt: document.createdAt.toISOString() })) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return apiError("Could not load documents. Please try again.", "تعذر تحميل الملفات. يرجى المحاولة مجدداً.", 503);
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

  const contentLength = Number(request.headers.get("content-length"));
  if (contentLength > MAX_DOCUMENT_SIZE + 1024 * 1024) {
    return apiError("The file must be 15 MB or smaller.", "يجب ألا يتجاوز حجم الملف 15 ميغابايت.", 413);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return apiError("Send a multipart file upload.", "يرجى إرسال الملف بصيغة تحميل متعددة الأجزاء.", 415);
  }

  let file: File;
  try {
    const form = await request.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) {
      return apiError("Choose a file to upload.", "يرجى اختيار ملف لرفعه.", 400);
    }
    file = entry;
  } catch {
    return apiError("Invalid upload request.", "طلب رفع الملف غير صالح.", 400);
  }

  const validationError = validateDocumentFile(file);
  if (validationError) {
    if (file.size > MAX_DOCUMENT_SIZE) {
      return apiError(validationError, "يجب ألا يتجاوز حجم الملف 15 ميغابايت.", 413);
    }
    if (file.size === 0) return apiError(validationError, "الملف فارغ.", 400);
    if (file.name.length > 255) return apiError(validationError, "اسم الملف طويل جداً.", 400);
    return apiError(validationError, "نوع الملف غير مدعوم.", 415);
  }

  const fileName = file.name.split(/[\\/]/).pop() ?? file.name;
  const extension = getDocumentExtension(fileName);
  const mimeType = getDocumentMimeType(extension);
  const contents = Buffer.from(await file.arrayBuffer());
  if (!mimeType || !hasValidContent(contents, extension)) {
    return apiError("The file content does not match its type.", "محتوى الملف لا يطابق نوعه.", 415);
  }

  try {
    const user = await db.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    });
    if (!user) return apiError("Please log in.", "يرجى تسجيل الدخول.", 401);

    const storage = getPrivateStorage();
    if (!storage) {
      return apiError("Document storage is not configured.", "تخزين الملفات غير مُعدّ حالياً.", 503);
    }

    const { data: bucket, error: bucketError } = await storage.client.storage.getBucket(storage.bucket);
    if (bucketError || !bucket || bucket.public) {
      return apiError("Private document storage is unavailable.", "تخزين الملفات الخاص غير متاح حالياً.", 503);
    }

    const storagePath = `documents/${user.id}/${randomUUID()}.${extension}`;
    const { error: uploadError } = await storage.client.storage
      .from(storage.bucket)
      .upload(storagePath, contents, { contentType: mimeType, upsert: false });

    if (uploadError) {
      return apiError("Could not upload the file. Please try again.", "تعذر رفع الملف. يرجى المحاولة مجدداً.", 502);
    }

    try {
      const document = await db.document.create({
        data: { userId: user.id, fileName, storagePath, mimeType, fileSize: file.size },
        select: { id: true, fileName: true, displayName: true, mimeType: true, fileSize: true, status: true, createdAt: true, deletedAt: true },
      });

      return NextResponse.json(
        { document: { ...document, createdAt: document.createdAt.toISOString() } },
        { status: 201, headers: { "Cache-Control": "private, no-store" } },
      );
    } catch {
      try {
        await storage.client.storage.from(storage.bucket).remove([storagePath]);
      } catch {
        // The database error is still the response even if cleanup cannot complete.
      }
      return apiError("Could not save the document. Please try again.", "تعذر حفظ الملف. يرجى المحاولة مجدداً.", 503);
    }
  } catch {
    return apiError("Document upload is unavailable. Please try again.", "رفع الملفات غير متاح حالياً. يرجى المحاولة مجدداً.", 503);
  }
}
