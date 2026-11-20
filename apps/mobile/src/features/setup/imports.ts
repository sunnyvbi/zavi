import { couldntRead, STORED_IMAGE } from "./copy";

export const MAX_FILES_PER_PICK = 20;
export const MAX_FILE_MB = 25;
export const IMPORT_POLL_MS = 4_000;
export const KICK_AFTER_MS = 20_000;
export const MAX_FAILURES = 15;
export const SLOW_POLL_MS = 60_000;
export const STALE_READ_MS = 10 * 60 * 1000;

export const PICK_TYPES = [
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/comma-separated-values",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/octet-stream",
];

const OK_EXT = new Set(["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg", "jpeg", "webp", "gif"]);
const OFFICE_ADVICE: Record<string, string> = {
  doc: "save it as .docx and add it again",
  xlsx: "save it as .csv and add it again",
  ppt: "save it as .pdf and add it again",
  pptx: "save it as .pdf and add it again",
};

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export type PickedFile = { uri: string; name: string; size: number | null; mime: string | null };

export type LocalRow = { key: string; name: string; status: "waiting" | "failed"; reason?: string; file?: PickedFile };

export function admitPicked(files: readonly PickedFile[], stamp: number = Date.now()): { rows: LocalRow[]; dropped: number } {
  const rows = files.slice(0, MAX_FILES_PER_PICK).map((file, i): LocalRow => {
    const base = { key: `${stamp}-${i}-${file.name}`, name: file.name };
    const e = ext(file.name);
    const advice = OFFICE_ADVICE[e];
    if (advice) return { ...base, status: "failed", reason: advice };
    if (!OK_EXT.has(e)) return { ...base, status: "failed", reason: `.${e || "?"} files aren't supported` };
    if (file.size !== null && file.size > MAX_FILE_MB * 1024 * 1024) {
      return { ...base, status: "failed", reason: `bigger than ${MAX_FILE_MB} MB` };
    }
    return { ...base, status: "waiting", file };
  });
  return { rows, dropped: Math.max(0, files.length - MAX_FILES_PER_PICK) };
}

export function mimeFor(file: Pick<PickedFile, "name" | "mime">): string {
  if (file.mime && file.mime !== "application/octet-stream") return file.mime;
  const byExt: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    csv: "text/csv",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return byExt[ext(file.name)] ?? "application/octet-stream";
}

export function uploadFailure(status: number, message: string | null | undefined): string {
  if (status === 413) return "bigger than the server takes right now";
  return message?.trim() || "upload failed";
}

export type ImportFile = {
  id: string;
  filename: string;
  created_at: string;
  status: "reading" | "done" | "stored" | "failed";
  facts: number;
  redactions: number;
  truncated: boolean;
  reason?: string;
  unclaimed: boolean;
};

export type ServerFile = { id: string; filename: string; created_at: string; extraction: unknown };

const RETRY_LATER = "I couldn't read it right now, try again later";

export function fileFromServer(row: ServerFile, now = Date.now()): ImportFile {
  const ex = (row.extraction ?? null) as
    | { state?: string; facts?: number; redactions?: number; truncated?: boolean; reason?: string }
    | null;
  const base = { id: row.id, filename: row.filename, created_at: row.created_at, facts: 0, redactions: 0, truncated: false, unclaimed: !ex };
  if (ex?.state === "read") {
    return { ...base, status: "done", facts: ex.facts ?? 0, redactions: ex.redactions ?? 0, truncated: ex.truncated === true };
  }
  if (ex?.state === "stored") return { ...base, status: "stored" };
  if (ex?.state === "unreadable") return { ...base, status: "failed", reason: ex.reason ?? RETRY_LATER };
  const age = now - Date.parse(row.created_at);
  if (Number.isFinite(age) && age > STALE_READ_MS) return { ...base, status: "failed", reason: RETRY_LATER };
  return { ...base, status: "reading" };
}

export type ReadSummary = {
  reading: ImportFile[];
  done: ImportFile[];
  stored: ImportFile[];
  failed: ImportFile[];
  facts: number;
};

export function summarizeReads(files: readonly ImportFile[] | null | undefined): ReadSummary {
  const all = files ?? [];
  const done = all.filter((f) => f.status === "done");
  return {
    reading: all.filter((f) => f.status === "reading"),
    done,
    stored: all.filter((f) => f.status === "stored"),
    failed: all.filter((f) => f.status === "failed"),
    facts: done.reduce((n, f) => n + f.facts, 0),
  };
}

export function namesOf(files: readonly Pick<ImportFile, "filename">[]): string {
  return files.length === 1 ? files[0].filename : `${files.length} files`;
}

export function rowLabel(r: { status: ImportFile["status"] | LocalRow["status"]; facts?: number; reason?: string }): string {
  if (r.status === "done") return `${r.facts ?? 0} ${r.facts === 1 ? "fact" : "facts"}`;
  if (r.status === "stored") return STORED_IMAGE;
  if (r.status === "failed") return couldntRead(r.reason ?? "unknown error");
  return r.status === "reading" ? "Reading" : "Adding";
}

export function filesToKick(files: readonly ImportFile[], kicked: ReadonlySet<string>, now: number): string[] {
  return files
    .filter((f) => f.status === "reading" && f.unclaimed && !kicked.has(f.id))
    .filter((f) => now - Date.parse(f.created_at) >= KICK_AFTER_MS)
    .map((f) => f.id);
}

export function nextPollMs(input: { enabled: boolean; files: readonly ImportFile[] | null; failures: number }): number | null {
  const reading = (input.files ?? []).some((f) => f.status === "reading");
  const gaveUp = input.failures >= MAX_FAILURES;
  if (reading) return gaveUp ? SLOW_POLL_MS : IMPORT_POLL_MS;
  if (gaveUp) return null;
  const waitingFirst = input.enabled && input.files === null;
  return waitingFirst || input.failures > 0 ? IMPORT_POLL_MS : null;
}

export function uploadName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extPart = dot > 0 ? name.slice(dot + 1) : "";
  const clean = (s: string) => s.replace(/[^A-Za-z0-9\-_.!~*'()]+/g, "_").replace(/^_+|_+$/g, "");
  const base = /[A-Za-z0-9]/.test(clean(stem)) ? clean(stem) : "file";
  const e = clean(extPart);
  return e ? `${base}.${e}` : base;
}
