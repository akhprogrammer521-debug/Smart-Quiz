"use client";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FileText, Files, ListChecks, LoaderCircle, Pencil, RotateCcw, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuestionSetsClient } from "@/components/documents/question-sets-client";
import { getDocumentExtension, validateDocumentFile } from "@/lib/document-file";
import type { DocumentListItem, DocumentSummary } from "@/types/document";

const statusStyles: Record<DocumentListItem["status"], string> = {
  UPLOADED: "bg-[#FFF4E5] text-[#A65E00]",
  PROCESSING: "bg-blue-50 text-blue-700",
  READY: "bg-green-50 text-green-700",
  FAILED: "bg-red-50 text-red-700",
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileType(fileName: string) {
  const extension = getDocumentExtension(fileName);
  return extension === "jpg" || extension === "jpeg" ? "JPG" : extension.toUpperCase();
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // Use the same safe fallback for malformed or empty error responses.
  }
  return fallback;
}

async function fetchDocuments(archived: boolean, signal?: AbortSignal) {
  const response = await fetch(`/api/documents?archived=${archived}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseError(response, "Could not load your documents."));
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("documents" in payload) || !Array.isArray(payload.documents)) {
    throw new Error("Could not load your documents.");
  }
  return payload.documents as DocumentListItem[];
}

function isDocumentSummary(value: unknown): value is DocumentSummary {
  if (!value || typeof value !== "object") return false;
  return "id" in value && typeof value.id === "string"
    && "content" in value && typeof value.content === "string"
    && "originalText" in value && typeof value.originalText === "string"
    && "normalizedText" in value && typeof value.normalizedText === "string"
    && "createdAt" in value && typeof value.createdAt === "string"
    && "updatedAt" in value && typeof value.updatedAt === "string";
}

async function requestSummary(documentId: string, method: "GET" | "POST"): Promise<DocumentSummary | null> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/summary`, {
    method,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await responseError(response, "Could not load the summary. Please try again."));

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("summary" in payload)) {
    throw new Error("The summary response was invalid.");
  }
  if (payload.summary === null) return null;
  if (!isDocumentSummary(payload.summary)) throw new Error("The summary response was invalid.");
  return payload.summary;
}

export function DocumentsClient() {
  const fileInput = useRef<HTMLInputElement>(null);
  const summaryRequestInFlight = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [fileError, setFileError] = useState("");
  const [listError, setListError] = useState("");
  const [success, setSuccess] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [activeDocument, setActiveDocument] = useState<DocumentListItem | null>(null);
  const [summary, setSummary] = useState<DocumentSummary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [questionsDocument, setQuestionsDocument] = useState<DocumentListItem | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [managingDocumentId, setManagingDocumentId] = useState<string | null>(null);
  const [managementSuccess, setManagementSuccess] = useState("");

  async function loadDocuments() {
    try {
      setDocuments(await fetchDocuments(showArchived));
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load your documents.");
    } finally {
      setIsLoadingList(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetchDocuments(showArchived, controller.signal)
      .then((items) => { setDocuments(items); setListError(""); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setListError(error instanceof Error ? error.message : "Could not load your documents.");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoadingList(false); });
    return () => controller.abort();
  }, [showArchived]);

  function chooseFile(file: File | undefined) {
    setSuccess("");
    if (!file) return;
    const error = validateDocumentFile(file);
    setFileError(error ?? "");
    setSelectedFile(error ? null : file);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    if (event.dataTransfer.files.length !== 1) {
      setSelectedFile(null);
      setFileError("Choose one file at a time.");
      return;
    }
    chooseFile(event.dataTransfer.files[0]);
  }

  async function handleUpload() {
    if (!selectedFile || isUploading) return;
    setIsUploading(true);
    setFileError("");
    setSuccess("");

    try {
      const form = new FormData();
      form.set("file", selectedFile);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      if (!response.ok) {
        setFileError(await responseError(response, "Could not upload the file. Please try again."));
        return;
      }

      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setSuccess("Document uploaded successfully.");
      setIsLoadingList(true);
      await loadDocuments();
    } catch {
      setFileError("Could not upload the file. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleSummary(document: DocumentListItem) {
    if (summaryRequestInFlight.current || isLoadingSummary || isGeneratingSummary) return;
    summaryRequestInFlight.current = true;
    setActiveDocument(document);
    setSummary(null);
    setSummaryError("");
    setIsLoadingSummary(true);

    try {
      try {
        const saved = await requestSummary(document.id, "GET");
        if (saved) {
          setSummary(saved);
          setDocuments((items) => items.map((item) => item.id === document.id ? { ...item, hasSummary: true, status: "READY" } : item));
          return;
        }
      } catch (error) {
        setSummaryError(error instanceof Error ? error.message : "Could not load the summary. Please try again.");
        return;
      } finally {
        setIsLoadingSummary(false);
      }

      setIsGeneratingSummary(true);
      try {
        const created = await requestSummary(document.id, "POST");
        if (!created) throw new Error("The summary response was invalid.");
        setSummary(created);
        setDocuments((items) => items.map((item) => item.id === document.id ? { ...item, hasSummary: true, status: "READY" } : item));
      } catch (error) {
        setSummaryError(error instanceof Error ? error.message : "Could not summarize this document. Please try again.");
      } finally {
        setIsGeneratingSummary(false);
      }
    } finally {
      summaryRequestInFlight.current = false;
    }
  }

  async function updateDocument(documentId: string, body: { displayName: string } | { restore: true }) {
    setManagingDocumentId(documentId);
    setListError("");
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not update the document."));
      if ("restore" in body) setDocuments((items) => items.filter((item) => item.id !== documentId));
      else setDocuments((items) => items.map((item) => item.id === documentId ? { ...item, displayName: body.displayName } : item));
      setEditingDocumentId(null);
    } catch (error) { setListError(error instanceof Error ? error.message : "Could not update the document."); }
    finally { setManagingDocumentId(null); }
  }

  async function archiveDocument(documentId: string) {
    if (!window.confirm("Delete this document? It will be moved to Archived documents and can be restored later.")) return;
    setManagingDocumentId(documentId);
    setListError("");
    setManagementSuccess("");
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "Could not archive the document."));
      setDocuments((items) => items.filter((item) => item.id !== documentId));
      setManagementSuccess("Document moved to Archived documents.");
      if (activeDocument?.id === documentId) { setActiveDocument(null); setSummary(null); }
      if (questionsDocument?.id === documentId) setQuestionsDocument(null);
    } catch (error) { setListError(error instanceof Error ? error.message : "Could not archive the document."); }
    finally { setManagingDocumentId(null); }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)] lg:items-start">
      <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8">
        <h2 className="text-xl font-bold">Upload a document</h2>
        <p className="mt-2 text-sm leading-6 text-muted">PDF, DOCX, DOC, TXT, PNG, or JPG · up to 15 MB</p>

        <div
          onDragOver={(event) => { event.preventDefault(); if (!isUploading) setIsDragging(true); }}
          onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
          onDrop={handleDrop}
          className={`mt-6 rounded-2xl border-2 border-dashed p-8 text-center transition-colors sm:p-10 ${isDragging ? "border-primary bg-[#FFF8EE]" : "border-[#E3E3E8] bg-[#FAFAFB]"}`}
        >
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#FFF4E5] text-primary">
            <UploadCloud aria-hidden="true" className="size-7" />
          </span>
          <p className="mt-5 font-semibold">Drag and drop your file here</p>
          <p className="mt-1 text-sm text-muted">or use the file picker</p>
          <input
            ref={fileInput}
            id="document-file"
            type="file"
            accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg"
            disabled={isUploading}
            tabIndex={-1}
            onChange={handleFileChange}
            className="sr-only"
          />
          <Button type="button" variant="secondary" size="sm" disabled={isUploading} onClick={() => fileInput.current?.click()} className="mt-5">
            Choose a file
          </Button>
        </div>

        {selectedFile && (
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-border p-4">
            <FileText aria-hidden="true" className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={selectedFile.name}>{selectedFile.name}</span>
            <span className="shrink-0 text-xs text-muted">{formatSize(selectedFile.size)}</span>
          </div>
        )}
        {fileError && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{fileError}</p>}
        {success && <p role="status" className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{success}</p>}

        <Button type="button" disabled={!selectedFile || isUploading} onClick={handleUpload} className="mt-6 w-full">
          {isUploading ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <UploadCloud aria-hidden="true" className="size-4" />}
          {isUploading ? "Uploading..." : "Upload document"}
        </Button>
      </div>

      <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{showArchived ? "Archived documents" : "Your documents"}</h2>
            <p className="mt-2 text-sm text-muted">{showArchived ? "Archived records remain stored with their learning history." : "Only active documents in your account appear here."}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setShowArchived((value) => !value); setActiveDocument(null); setQuestionsDocument(null); }} disabled={isLoadingList}>
              {showArchived ? "View active" : "View archived"}
            </Button>
            <Files aria-hidden="true" className="size-6 text-primary" />
          </div>
        </div>

        <div className="mt-6" aria-busy={isLoadingList}>
          {managementSuccess && <p role="status" className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{managementSuccess}</p>}
          {isLoadingList ? (
            <div className="space-y-3" aria-label="Loading documents">
              {[1, 2, 3].map((item) => (
                <div key={item} className="flex animate-pulse gap-4 rounded-xl border border-border p-4">
                  <span className="size-11 shrink-0 rounded-xl bg-[#F1F1F3]" />
                  <div className="flex-1 space-y-2 py-1"><div className="h-3 w-2/3 rounded bg-[#F1F1F3]" /><div className="h-3 w-1/2 rounded bg-[#F1F1F3]" /></div>
                </div>
              ))}
            </div>
          ) : listError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {listError}
              <Button type="button" variant="secondary" size="sm" onClick={() => { setIsLoadingList(true); void loadDocuments(); }} className="mt-3 block">Try again</Button>
            </div>
          ) : documents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
              <Files aria-hidden="true" className="mx-auto size-9 text-primary" />
              <p className="mt-4 font-semibold">{showArchived ? "No archived documents" : "No documents yet"}</p>
              <p className="mt-1 text-sm text-muted">{showArchived ? "Archived documents will appear here." : "Upload your first study file to see it here."}</p>
            </div>
          ) : (
            <ul className="space-y-4">
              {documents.map((document) => (
                <li
                  key={document.id}
                  className={`flex min-w-0 flex-col gap-4 overflow-hidden rounded-2xl border p-4 transition-[border-color,box-shadow] duration-200 hover:border-primary/30 hover:shadow-[0_10px_28px_-24px_rgba(38,38,38,0.45)] sm:p-5 xl:flex-row xl:items-center xl:justify-between ${showArchived ? "border-border bg-[#FAFAFB]" : "border-border bg-card"}`}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#FFF4E5] text-primary">
                      <FileText aria-hidden="true" className="size-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      {editingDocumentId === document.id ? (
                        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                          <input
                            value={displayName}
                            maxLength={150}
                            onChange={(event) => setDisplayName(event.target.value)}
                            aria-label="Document display name"
                            className="h-10 min-w-0 flex-1 rounded-xl border border-border px-3 text-sm outline-none transition-colors focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20"
                          />
                          <div className="flex shrink-0 gap-2">
                            <Button size="sm" disabled={managingDocumentId === document.id || displayName.trim().length < 2} onClick={() => void updateDocument(document.id, { displayName: displayName.trim() })}>Save</Button>
                            <Button size="sm" variant="ghost" disabled={managingDocumentId === document.id} onClick={() => setEditingDocumentId(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <p className="truncate text-sm font-bold text-foreground" title={document.displayName || document.fileName}>
                          {document.displayName || document.fileName}
                        </p>
                      )}

                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-xs text-muted">
                        <span className="shrink-0 font-medium">{fileType(document.fileName)}</span>
                        <span aria-hidden="true" className="text-border">•</span>
                        <span className="shrink-0">{formatSize(document.fileSize)}</span>
                        <span aria-hidden="true" className="text-border">•</span>
                        <span className="shrink-0">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(document.createdAt))}</span>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 font-semibold ${statusStyles[document.status]}`}>
                          {document.status.charAt(0) + document.status.slice(1).toLowerCase()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex w-full shrink-0 flex-wrap items-center gap-2 xl:w-auto xl:flex-nowrap xl:justify-end">
                    {showArchived ? (
                      <Button
                        type="button"
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={managingDocumentId === document.id}
                        onClick={() => void updateDocument(document.id, { restore: true })}
                      >
                        {managingDocumentId === document.id ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <RotateCcw aria-hidden="true" className="size-4" />}
                        {managingDocumentId === document.id ? "Restoring..." : "Restore"}
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="shrink-0"
                          aria-label="Rename document"
                          title="Rename document"
                          disabled={managingDocumentId === document.id}
                          onClick={() => { setEditingDocumentId(document.id); setDisplayName(document.displayName || document.fileName); }}
                        >
                          <Pencil aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                          aria-label="Delete document"
                          title="Delete document"
                          disabled={managingDocumentId === document.id}
                          onClick={() => void archiveDocument(document.id)}
                        >
                          {managingDocumentId === document.id ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="flex-1 whitespace-nowrap sm:flex-none"
                          disabled={isLoadingSummary || isGeneratingSummary || managingDocumentId === document.id}
                          onClick={() => void handleSummary(document)}
                        >
                          {activeDocument?.id === document.id && (isLoadingSummary || isGeneratingSummary)
                            ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                            : <Sparkles aria-hidden="true" className="size-4" />}
                          {activeDocument?.id === document.id && isLoadingSummary
                            ? "Loading..."
                            : activeDocument?.id === document.id && isGeneratingSummary
                              ? "Summarizing..."
                              : document.hasSummary ? "View summary" : "Summarize"}
                        </Button>
                        <Button type="button" size="sm" variant="secondary" className="flex-1 whitespace-nowrap sm:flex-none" onClick={() => setQuestionsDocument(document)}>
                          <ListChecks aria-hidden="true" className="size-4" />Generate questions
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {activeDocument && (
        <section className="rounded-3xl border border-border bg-card p-6 shadow-[0_8px_30px_-26px_rgba(38,38,38,0.25)] sm:p-8 lg:col-span-2" aria-live="polite" aria-busy={isLoadingSummary || isGeneratingSummary}>
          <p className="text-sm font-bold text-primary">Study summary</p>
          <h2 className="mt-2 break-words text-xl font-bold">{activeDocument.displayName || activeDocument.fileName}</h2>

          {isLoadingSummary ? (
            <div className="mt-6 space-y-3" aria-label="Loading summary">
              {[1, 2, 3, 4].map((item) => <div key={item} className={`h-4 animate-pulse rounded bg-[#F1F1F3] ${item === 4 ? "w-2/3" : "w-full"}`} />)}
            </div>
          ) : isGeneratingSummary ? (
            <div className="mt-6 flex items-center gap-3 text-sm text-muted">
              <LoaderCircle aria-hidden="true" className="size-5 motion-safe:animate-spin text-primary" />
              Creating your summary. This may take a moment.
            </div>
          ) : summaryError ? (
            <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <p>{summaryError}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void handleSummary(activeDocument)}>Try again</Button>
            </div>
          ) : summary ? (
            <div className="mt-6">
              <p className="text-xs text-muted">Created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(summary.createdAt))}</p>
              <div dir="auto" className="mt-4 whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{summary.content}</div>
              <details className="mt-8 rounded-2xl border border-border bg-[#FAFAFB] p-4 open:pb-5">
                <summary className="cursor-pointer font-semibold marker:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25">Original extracted text</summary>
                <div dir="auto" className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border pt-4 text-sm leading-7 text-muted">{summary.originalText}</div>
              </details>
            </div>
          ) : null}
        </section>
      )}

      {questionsDocument && <QuestionSetsClient key={questionsDocument.id} document={questionsDocument} />}
    </div>
  );
}
