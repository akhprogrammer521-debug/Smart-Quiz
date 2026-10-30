export type DocumentListItem = {
  id: string;
  fileName: string;
  displayName: string | null;
  mimeType: string;
  fileSize: number;
  status: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  createdAt: string;
  deletedAt: string | null;
  hasSummary?: boolean;
};

export type DocumentSummary = {
  id: string;
  originalText: string;
  normalizedText: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};
