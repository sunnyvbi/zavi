
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import {
  writeNote,
  deleteNote,
  listNotes,
  getNote,
  searchMemory,
  listConflicts,
  unsupersedeNote,
  getDreamCycleStatus,
  NoteNotFoundError,
  PRIVATE_NOTE_TYPE_SET,
  type WriteNoteSource,
  type WriteNoteType,
} from "@/services/memory";
import { writeMutationAudit, buildEditSnapshot } from "@/services/memory/mutation-audit";

const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_QUERY_MAX = 2000;

const VALID_NOTE_TYPES: ReadonlySet<WriteNoteType> = new Set([
  "operator_preference",
  "agent_feedback",
  "tenant_project",
  "tenant_reference",
  "untyped",
  "skill",
]);

const WRITE_ROLES = ["owner", "admin"] as const;

const OPERATOR_AUTHORED_SOURCES: readonly WriteNoteSource[] = [
  "human",
  "operator_feedback",
  "praxis_staff",
];

export async function memoryNotesList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const noteTypeRaw = req.query.note_type;
    const note_type =
      typeof noteTypeRaw === "string" && VALID_NOTE_TYPES.has(noteTypeRaw as WriteNoteType)
        ? (noteTypeRaw as WriteNoteType)
        : undefined;
    const tagRaw = req.query.tag;
    const tag = typeof tagRaw === "string" && tagRaw.length > 0 ? tagRaw : undefined;
    const sources =
      req.query.authored === "operator" ? OPERATOR_AUTHORED_SOURCES : undefined;
    const notes = await listNotes(auth.tenant_id, { limit: 200, note_type, tag, sources });
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryNoteGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!NOTE_ID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid note id" } });
    return;
  }
  try {
    const note = await getNote(auth.tenant_id, id);
    if (!note) {
      res.status(404).json({ error: { code: "not_found", message: "memory note not found" } });
      return;
    }
    res.json({ note });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryNoteUpsert(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const body = req.body as {
    id?: string;
    title?: string;
    body_markdown?: string;
    tags?: string[];
    note_type?: WriteNoteType;
    source?: WriteNoteSource;
    reason?: string;
  };
  const idFromUrl = req.params.id;
  const id = idFromUrl || body.id || null;
  if (id && !NOTE_ID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid note id" } });
    return;
  }
  if (typeof body.body_markdown !== "string" || body.body_markdown.length === 0) {
    res.status(400).json({ error: { code: "bad_body", message: "body_markdown required" } });
    return;
  }
  if (body.body_markdown.length > 50_000) {
    res.status(413).json({ error: { code: "too_long", message: "body_markdown > 50k chars" } });
    return;
  }
  let existingSource: WriteNoteSource | undefined;
  let existingSourceRef: string | null | undefined;
  let existingNote: Awaited<ReturnType<typeof getNote>> = null;
  if (id) {
    try {
      const existing = await getNote(auth.tenant_id, id);
      if (existing) {
        if (existing.slug) {
          res.status(422).json({
            error: {
              code: "anchor_protected",
              message: `Anchor notes (slug=${existing.slug}) are not editable here. Use POST /api/memory/regenerate-anchor to rewrite an anchor.`,
            },
          });
          return;
        }
        if (PRIVATE_NOTE_TYPE_SET.has((existing.note_type as string) ?? "")) {
          res.status(422).json({
            error: {
              code: "private_note_protected",
              message: `Per-agent notes (note_type=${existing.note_type}) are not editable via this route. Editing would declassify them into cross-agent memory. Delete instead.`,
            },
          });
          return;
        }
        existingSource = existing.source as WriteNoteSource;
        existingSourceRef = existing.source_ref ?? null;
        existingNote = existing;
      }
    } catch {
    }
  }
  const existingType = (existingNote?.note_type as WriteNoteType | undefined) ?? undefined;
  if (body.note_type === "operator_preference" && existingType !== "operator_preference") {
    res.status(422).json({
      error: {
        code: "rules_not_memory",
        message: "A standing instruction is a rule now. Add it on the Rules page in Settings.",
      },
    });
    return;
  }
  try {
    const result = await writeNote(auth.tenant_id, {
      id,
      title: body.title ?? existingNote?.title ?? "",
      body_markdown: body.body_markdown,
      source: existingSource ?? "human",
      source_ref: existingSourceRef ?? null,
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : (existingNote?.tags ?? []),
      note_type:
        body.note_type && VALID_NOTE_TYPES.has(body.note_type)
          ? body.note_type
          : existingType && VALID_NOTE_TYPES.has(existingType)
            ? existingType
            : undefined,
    });
    if (id && existingNote) {
      const reason = typeof body.reason === "string" ? body.reason : null;
      await writeMutationAudit({
        tenant_id: auth.tenant_id,
        note_id: id,
        action: "edit",
        actor_user_id: auth.user_id,
        reason,
        before_snapshot: buildEditSnapshot(existingNote),
      });
    }
    res.json(result);
  } catch (e) {
    if (e instanceof NoteNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: "memory note not found" } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryNoteDelete(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = req.params.id;
  if (!NOTE_ID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid note id" } });
    return;
  }
  try {
    const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === "string"
      ? (req.body as { reason: string }).reason
      : null;
    await deleteNote(auth.tenant_id, id, auth.user_id, reason);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof NoteNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: "memory note not found" } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryConflictsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Math.min(parseInt(limitRaw, 10), 200)
        : 50;
    const pairs = await listConflicts(auth.tenant_id, limit);
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryDreamCycleStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const status = await getDreamCycleStatus(auth.tenant_id);
    res.json({ status });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memoryNoteUnsupersede(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = req.params.id;
  if (!NOTE_ID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid note id" } });
    return;
  }
  try {
    await unsupersedeNote(auth.tenant_id, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function memorySearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = req.body as { query?: string; k?: number };
  if (!body.query || typeof body.query !== "string" || body.query.trim().length === 0) {
    res.status(400).json({ error: { code: "bad_query", message: "query required" } });
    return;
  }
  if (body.query.length > SEARCH_QUERY_MAX) {
    res.status(413).json({ error: { code: "too_long", message: `query > ${SEARCH_QUERY_MAX} chars` } });
    return;
  }
  const k = Math.min(Math.max(body.k ?? 8, 1), 50);
  try {
    const hits = await searchMemory(auth.tenant_id, body.query, k);
    res.json({ hits });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
