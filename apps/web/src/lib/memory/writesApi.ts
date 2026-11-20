
import { apiFetch } from "@/lib/api";

export type MemoryWriteKind = "added" | "updated" | "conflict";

export type NoteRef = { note_id: string; title: string; body_excerpt?: string };

export type MemoryWriteItem = {
  note_id: string;
  kind: MemoryWriteKind;
  title: string;
  body_excerpt: string;
  previous?: NoteRef;
  conflict_with?: NoteRef;
  pair_id?: string;
};

export type MemoryWrites = { status: "pending" | "done"; items: MemoryWriteItem[] };

export type ConflictValue = { note_id: string; title: string; body_excerpt: string };

export type ConflictPair = { pair_id: string; values: ConflictValue[] };

export type MemoryApi = {
  getWrites(q: { runId: string }): Promise<MemoryWrites | null>;
  forget(noteId: string): Promise<{ undo_token: string }>;
  undoForget(undoToken: string): Promise<void>;
  undoUpdate(noteId: string): Promise<void>;
  keepConflict(pairId: string, noteId: string): Promise<void>;
  listConflicts(): Promise<ConflictPair[]>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function noteRef(v: unknown): NoteRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const note_id = str(o.note_id);
  return note_id ? { note_id, title: str(o.title), body_excerpt: str(o.body_excerpt) } : undefined;
}

const KINDS = new Set<MemoryWriteKind>(["added", "updated", "conflict"]);

export function normalizeWrites(raw: unknown): MemoryWrites | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.status !== "pending" && o.status !== "done") return null;
  const items: MemoryWriteItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const note_id = str(r.note_id);
    const kind = r.kind as MemoryWriteKind;
    const title = str(r.title);
    if (!note_id || !KINDS.has(kind) || !title) continue;
    const item: MemoryWriteItem = { note_id, kind, title, body_excerpt: str(r.body_excerpt) };
    const previous = noteRef(r.previous);
    const conflict_with = noteRef(r.conflict_with);
    if (previous) item.previous = previous;
    if (conflict_with) item.conflict_with = conflict_with;
    if (str(r.pair_id)) item.pair_id = str(r.pair_id);
    if (kind === "updated" && !previous) item.kind = "added";
    if (kind === "conflict" && !conflict_with) item.kind = "added";
    items.push(item);
  }
  return { status: o.status, items };
}

function conflictValue(v: unknown): ConflictValue | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const note_id = str(o.note_id) || str(o.id);
  const title = str(o.title);
  if (!note_id || !title) return null;
  return { note_id, title, body_excerpt: str(o.body_excerpt) };
}

export function normalizeConflicts(raw: unknown): ConflictPair[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.pairs) ? o.pairs : Array.isArray(o.conflicts) ? o.conflicts : [];
  const out: ConflictPair[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const pair_id = str(r.pair_id) || str(r.id);
    const rawValues = Array.isArray(r.values) ? r.values : Array.isArray(r.notes) ? r.notes : [r.a, r.b];
    const values = rawValues.map(conflictValue).filter((v): v is ConflictValue => v !== null);
    if (pair_id && values.length >= 2) out.push({ pair_id, values });
  }
  return out;
}

async function postOk(path: string, body?: unknown): Promise<Response> {
  const res = await apiFetch(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    retryOnNetworkError: false,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export const memoryApi: MemoryApi = {
  async getWrites({ runId }) {
    const res = await apiFetch(`/api/memory/writes?run_id=${encodeURIComponent(runId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeWrites(await res.json());
  },
  async forget(noteId) {
    const res = await postOk(`/api/memory/notes/${encodeURIComponent(noteId)}/forget`);
    const body = (await res.json().catch(() => null)) as { undo_token?: unknown } | null;
    return { undo_token: str(body?.undo_token) };
  },
  async undoForget(undoToken) {
    await postOk("/api/memory/forget/undo", { undo_token: undoToken });
  },
  async undoUpdate(noteId) {
    await postOk(`/api/memory/notes/${encodeURIComponent(noteId)}/undo-update`);
  },
  async keepConflict(pairId, noteId) {
    await postOk(`/api/memory/conflicts/${encodeURIComponent(pairId)}/keep`, { note_id: noteId });
  },
  async listConflicts() {
    const res = await apiFetch("/api/memory/conflicts");
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeConflicts(await res.json());
  },
};

export async function resolvePairId(api: MemoryApi, item: MemoryWriteItem): Promise<string | null> {
  if (item.pair_id) return item.pair_id;
  const other = item.conflict_with?.note_id;
  if (!other) return null;
  const pairs = await api.listConflicts();
  const hit = pairs.find((p) => {
    const ids = p.values.map((v) => v.note_id);
    return ids.includes(item.note_id) && ids.includes(other);
  });
  return hit?.pair_id ?? null;
}
