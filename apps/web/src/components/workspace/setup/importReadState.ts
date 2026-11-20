
export const STALE_READ_MS = 10 * 60 * 1000;
const RETRY_LATER = "I couldn't read it right now, try again later";

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

export function namesOf(files: readonly ImportFile[]): string {
  return files.length === 1 ? files[0].filename : `${files.length} files`;
}

const AFTER_READ_KEY = "zavi.setup.afterRead";

export type AfterRead = { files: string[]; untouched: Array<{ key: string; label: string; value: string }> };

export function loadAfterRead(): AfterRead | null {
  try {
    const raw = window.sessionStorage.getItem(AFTER_READ_KEY);
    const v = raw ? (JSON.parse(raw) as AfterRead) : null;
    return v && Array.isArray(v.files) && Array.isArray(v.untouched) ? v : null;
  } catch {
    return null;
  }
}

export function saveAfterRead(a: AfterRead | null): void {
  try {
    if (a) window.sessionStorage.setItem(AFTER_READ_KEY, JSON.stringify(a));
    else window.sessionStorage.removeItem(AFTER_READ_KEY);
  } catch {
  }
}
