export const MAX_DOCUMENT_SIZE = 15 * 1024 * 1024;

const mimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export function getDocumentExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function getDocumentMimeType(extension: string) {
  return mimeTypes[extension];
}

export function validateDocumentFile(file: File): string | null {
  const extension = getDocumentExtension(file.name);
  const mimeType = getDocumentMimeType(extension);

  const genericMimeType = file.type === "application/octet-stream" || (extension === "docx" && file.type === "application/zip");
  if (!mimeType || (file.type && file.type !== mimeType && !genericMimeType)) {
    return "Choose a PDF, DOCX, DOC, TXT, PNG, or JPG file.";
  }
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_DOCUMENT_SIZE) return "The file must be 15 MB or smaller.";
  if (file.name.length > 255) return "The file name is too long.";

  return null;
}
