
export type DocSource = "slack_file" | "run_artifact" | "chat_doc";

export type DocRetrievalEntry = {
  source: DocSource;
  ref: string | null;
  artifact_id: string | null;
  chars: number;
};

export type DocFailureEntry = {
  ref: string;
  reason: string;
};

export type ThreadAttachment = {
  file_id: string;
  name: string;
  filetype: string;
};

const MAX_RUNS_RETAINED = 200;

const attachments = new Map<string, ThreadAttachment[]>();
const retrievals = new Map<string, DocRetrievalEntry[]>();
const failures = new Map<string, DocFailureEntry[]>();

function evictIfFull(m: Map<string, unknown>): void {
  if (m.size >= MAX_RUNS_RETAINED) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) {
      attachments.delete(oldest as string);
      retrievals.delete(oldest as string);
      failures.delete(oldest as string);
    }
  }
}

export function recordThreadAttachments(
  run_id: string,
  files: ThreadAttachment[],
): void {
  if (!run_id || files.length === 0) return;
  evictIfFull(attachments);
  const existing = attachments.get(run_id) ?? [];
  const seen = new Set(existing.map((f) => f.file_id));
  const merged = existing.concat(files.filter((f) => f.file_id && !seen.has(f.file_id)));
  attachments.set(run_id, merged);
}

export function recordDocRetrieval(run_id: string, entry: DocRetrievalEntry): void {
  if (!run_id || entry.chars <= 0) return;
  evictIfFull(retrievals);
  const list = retrievals.get(run_id) ?? [];
  list.push(entry);
  retrievals.set(run_id, list);
}

export function recordRetrievalFailure(run_id: string, entry: DocFailureEntry): void {
  if (!run_id) return;
  evictIfFull(failures);
  const list = failures.get(run_id) ?? [];
  list.push(entry);
  failures.set(run_id, list);
}

export function threadAttachments(run_id: string): ThreadAttachment[] {
  return attachments.get(run_id) ?? [];
}

export function hasAnyRetrieval(run_id: string): boolean {
  return (retrievals.get(run_id) ?? []).length > 0;
}

export function hasRetrievedAnyOf(run_id: string, refs: string[]): boolean {
  if (refs.length === 0) return false;
  const wanted = new Set(refs);
  return (retrievals.get(run_id) ?? []).some((r) => r.ref !== null && wanted.has(r.ref));
}

export function retrievalFailures(run_id: string): DocFailureEntry[] {
  return failures.get(run_id) ?? [];
}

export function clearDocLedger(run_id: string): void {
  attachments.delete(run_id);
  retrievals.delete(run_id);
  failures.delete(run_id);
}

export function __resetDocLedgerForTests(): void {
  attachments.clear();
  retrievals.clear();
  failures.clear();
}
