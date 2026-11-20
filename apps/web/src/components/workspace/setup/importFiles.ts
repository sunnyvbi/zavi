import { couldntRead, STORED_IMAGE } from "./setupCopy";

export const MAX_FILES_PER_DROP = 20;
export const MAX_FILE_MB = 25;
export const ACCEPT = ".md,.txt,.pdf,.docx,.csv,.json,.png,.jpg,.jpeg,.webp,.gif,.doc,.xlsx,.ppt,.pptx";
const OK_EXT = new Set(["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg", "jpeg", "webp", "gif"]);
const OFFICE_ADVICE: Record<string, string> = {
  doc: "save it as .docx and drop it again",
  xlsx: "save it as .csv and drop it again",
  ppt: "save it as .pdf and drop it again",
  pptx: "save it as .pdf and drop it again",
};

export type FileRow = {
  key: string;
  name: string;
  size: number;
  status: "waiting" | "reading" | "done" | "stored" | "failed";
  facts?: number;
  truncated?: boolean;
  redactions?: number;
  reason?: string;
  file?: File;
};

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export function admitFiles(files: readonly File[]): FileRow[] {
  return files.slice(0, MAX_FILES_PER_DROP).map((file, i): FileRow => {
    const base = { key: `${Date.now()}-${i}-${file.name}`, name: file.name, size: file.size, file };
    const advice = OFFICE_ADVICE[ext(file.name)];
    if (advice) return { ...base, status: "failed", reason: advice };
    if (!OK_EXT.has(ext(file.name))) return { ...base, status: "failed", reason: `.${ext(file.name) || "?"} files aren't supported` };
    if (file.size > MAX_FILE_MB * 1024 * 1024) return { ...base, status: "failed", reason: `bigger than ${MAX_FILE_MB} MB` };
    return { ...base, status: "waiting" };
  });
}

export function rowLabel(r: FileRow): string {
  if (r.status === "done") return `${r.facts ?? 0} ${r.facts === 1 ? "fact" : "facts"}`;
  if (r.status === "stored") return STORED_IMAGE;
  if (r.status === "failed") return couldntRead(r.reason ?? "unknown error");
  return r.status === "reading" ? "Reading" : "Adding";
}
