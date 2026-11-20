
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";

const WRITE_ROLES = ["owner", "admin"] as const;
import { inngest } from "@/../workers/client";
import {
  forgetNote,
  getRunWrites,
  keepConflictValue,
  listOpenConflicts,
  listRecentWrites,
  restoreWrite,
  undoForget,
  undoUpdate,
} from "@/services/memory/remembered";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(res: Response, code: string, message: string, status = 400): void {
  res.status(status).json({ error: { code, message } });
}

function internal(res: Response, e: unknown): void {
  res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
}

function isoParam(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return null;
  return new Date(v).toISOString();
}

function limitParam(v: unknown, dflt: number): number {
  return typeof v === "string" && /^\d+$/.test(v) ? Math.min(parseInt(v, 10), 100) : dflt;
}

export async function memoryWritesGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const run_id = typeof req.query.run_id === "string" ? req.query.run_id : null;
  const thread_message_id =
    typeof req.query.thread_message_id === "string" ? req.query.thread_message_id : null;
  if (!run_id && !thread_message_id) return bad(res, "missing_ref", "run_id or thread_message_id required");
  if ((run_id && !UUID_RE.test(run_id)) || (thread_message_id && !UUID_RE.test(thread_message_id))) {
    return bad(res, "bad_id", "invalid id");
  }
  try {
    const out = await getRunWrites(auth.tenant_id, { run_id, thread_message_id });
    if (!out) return bad(res, "not_found", "run not found", 404);
    res.json(out);
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryRecentWrites(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const since = isoParam(req.query.since);
  const before = isoParam(req.query.before);
  if (since === null || before === null) return bad(res, "bad_time", "since/before must be ISO timestamps");
  try {
    const items = await listRecentWrites(auth.tenant_id, {
      since: since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      before: before ?? null,
      limit: limitParam(req.query.limit, 50),
    });
    res.json({ items, next_before: items.length > 0 ? items[items.length - 1].created_at : null });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryNoteForget(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = req.params.id;
  if (!UUID_RE.test(id)) return bad(res, "bad_id", "invalid note id");
  try {
    const r = await forgetNote(auth.tenant_id, id, auth.user_id);
    if (!r.ok) {
      return r.code === "anchor"
        ? bad(res, "anchor", "anchors are edited, not forgotten", 409)
        : bad(res, "not_found", "memory note not found", 404);
    }
    await inngest
      .send({ name: "memory.note.forget.requested", data: { request_id: r.undo_token, tenant_id: auth.tenant_id } })
      .catch((e: Error) => console.warn(`[memory-forget] event send failed: ${e.message}`));
    res.json({ undo_token: r.undo_token, undo_expires_at: r.undo_expires_at });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryForgetUndo(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const token = (req.body as { undo_token?: unknown } | undefined)?.undo_token;
  if (typeof token !== "string" || !UUID_RE.test(token)) return bad(res, "bad_token", "invalid undo_token");
  try {
    const ok = await undoForget(auth.tenant_id, token);
    if (!ok) return bad(res, "undo_expired", "too late to undo", 409);
    res.json({ ok: true });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryNoteUndoUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = req.params.id;
  if (!UUID_RE.test(id)) return bad(res, "bad_id", "invalid note id");
  try {
    const restored = await undoUpdate(auth.tenant_id, id);
    if (!restored) return bad(res, "nothing_to_undo", "this note did not replace another", 409);
    res.json({ ok: true, restored_note_id: restored });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryOpenConflicts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const before = isoParam(req.query.before);
  if (before === null) return bad(res, "bad_time", "before must be an ISO timestamp");
  try {
    const pairs = await listOpenConflicts(auth.tenant_id, {
      before: before ?? null,
      limit: limitParam(req.query.limit, 50),
    });
    res.json({ pairs, next_before: pairs.length > 0 ? pairs[pairs.length - 1].created_at : null });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryConflictKeep(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const pairId = req.params.pair_id;
  const noteId = (req.body as { note_id?: unknown } | undefined)?.note_id;
  if (!UUID_RE.test(pairId) || typeof noteId !== "string" || !UUID_RE.test(noteId)) {
    return bad(res, "bad_id", "invalid pair_id or note_id");
  }
  try {
    const r = await keepConflictValue(auth.tenant_id, pairId, noteId, auth.user_id);
    if (r === "not_in_pair") return bad(res, "not_in_pair", "note_id is not one of the pair's values");
    if (r === "not_open") return bad(res, "not_open", "this pair is already answered", 409);
    res.json({ ok: true });
  } catch (e) {
    internal(res, e);
  }
}

export async function memoryWriteRestore(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = req.params.id;
  if (!UUID_RE.test(id)) return bad(res, "bad_id", "invalid id");
  try {
    const r = await restoreWrite(auth.tenant_id, id);
    if (r === "not_found") return bad(res, "not_found", "write not found", 404);
    if (r === "not_restorable") return bad(res, "not_restorable", "nothing to restore", 409);
    if (r === "already_restored") return bad(res, "already_restored", "already restored", 409);
    res.json({ ok: true });
  } catch (e) {
    internal(res, e);
  }
}
