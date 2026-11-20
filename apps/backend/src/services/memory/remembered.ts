
import { asTenantId, tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { deleteNote, NoteNotFoundError, unsupersedeNote, writeNote, type WriteNoteType } from ".";
import { logReview } from "@/services/logging/log-review";

export const FORGET_UNDO_MS = 10_000;
const FORGET_UNDO_GRACE_MS = 5_000;
export const FORGET_PURGE_AFTER_MS = 30_000;
const PURGE_ALERT_AFTER = 5;
const PURGE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const PURGE_STALE_MS = 10 * 60 * 1000;
const EXCERPT_CHARS = 240;
const DISTILL_WAIT_MS = 10 * 60 * 1000;
const PILL_ACTIONS = ["added", "updated", "conflict"] as const;

export type WriteItemKind = "added" | "updated" | "conflict";

export type WriteItem = {
  note_id: string;
  kind: WriteItemKind;
  title: string;
  body_excerpt: string;
  previous?: { note_id: string; title: string; body_excerpt: string };
  conflict_with?: { note_id: string; title: string; body_excerpt: string };
  pair_id?: string;
  pair_status?: "open" | "resolved";
};

export type RecentWriteItem = WriteItem & {
  source: { run_id?: string; thread_id?: string };
  created_at: string;
};

type LogRow = {
  id: string;
  action: WriteItemKind;
  note_id: string | null;
  matched_note_id: string | null;
  run_id: string | null;
  thread_id: string | null;
  created_at: string;
};

type NoteRow = {
  id: string;
  title: string | null;
  body_markdown: string | null;
  archived_at: string | null;
  forgotten_at: string | null;
};

function excerpt(body: string | null): string {
  const t = (body ?? "").replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS - 1)}…` : t;
}

async function hydrate(tid: TenantId, rows: LogRow[]): Promise<Map<string, WriteItem>> {
  const out = new Map<string, WriteItem>();
  if (rows.length === 0) return out;
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.note_id, r.matched_note_id]).filter((x): x is string => !!x)),
  );
  const { data: notesData, error } = await tenantClient(tid)
    .from("memory_note")
    .select("id, title, body_markdown, archived_at, forgotten_at")
    .in("id", ids);
  if (error) throw new Error(`memory writes: note read failed: ${error.message}`);
  const notes = new Map(((notesData ?? []) as NoteRow[]).map((n) => [n.id, n]));

  const conflictNoteIds = rows.filter((r) => r.action === "conflict" && r.note_id).map((r) => r.note_id!);
  const pairByNew = new Map<string, { id: string; status: "open" | "resolved" }>();
  if (conflictNoteIds.length > 0) {
    const { data: pairs } = await tenantClient(tid)
      .from("memory_conflict_pair")
      .select("id, new_note_id, status")
      .in("new_note_id", conflictNoteIds);
    for (const p of (pairs ?? []) as Array<{ id: string; new_note_id: string; status: "open" | "resolved" }>) {
      pairByNew.set(p.new_note_id, { id: p.id, status: p.status });
    }
  }

  for (const r of rows) {
    const n = r.note_id ? notes.get(r.note_id) : undefined;
    if (!n || n.forgotten_at || n.archived_at) continue;
    const item: WriteItem = {
      note_id: n.id,
      kind: r.action,
      title: n.title ?? "",
      body_excerpt: excerpt(n.body_markdown),
    };
    const m = r.matched_note_id ? notes.get(r.matched_note_id) : undefined;
    if (r.action === "updated" && m) {
      item.previous = { note_id: m.id, title: m.title ?? "", body_excerpt: excerpt(m.body_markdown) };
    }
    if (r.action === "conflict") {
      if (m) item.conflict_with = { note_id: m.id, title: m.title ?? "", body_excerpt: excerpt(m.body_markdown) };
      const p = pairByNew.get(n.id);
      if (p) {
        item.pair_id = p.id;
        item.pair_status = p.status;
      }
    }
    out.set(r.id, item);
  }
  return out;
}

export async function getRunWrites(
  tenant_id: string,
  q: { run_id?: string | null; thread_message_id?: string | null },
): Promise<{ status: "pending" | "done"; items: WriteItem[] } | null> {
  const tid = asTenantId(tenant_id);
  let runId = q.run_id ?? null;
  if (!runId && q.thread_message_id) {
    const { data: msg } = await tenantClient(tid)
      .from("agent_thread_messages")
      .select("id, agent_run_id")
      .eq("id", q.thread_message_id)
      .maybeSingle();
    if (!msg) return null;
    runId = (msg as { agent_run_id: string | null }).agent_run_id;
    if (!runId) return { status: "done", items: [] };
  }
  if (!runId) return null;

  const { data: run } = await tenantClient(tid)
    .from("agent_runs")
    .select("id, distilled_at, finished_at")
    .eq("id", runId)
    .maybeSingle();
  if (!run) return null;
  const r = run as { distilled_at: string | null; finished_at: string | null };

  const { data: logData, error } = await tenantClient(tid)
    .from("memory_write_log")
    .select("id, action, note_id, matched_note_id, run_id, thread_id, created_at")
    .eq("run_id", runId)
    .in("action", PILL_ACTIONS as unknown as string[])
    .is("restored_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`memory writes read failed: ${error.message}`);
  const rows = (logData ?? []) as LogRow[];
  const items = Array.from((await hydrate(tid, rows)).values());

  const waitedOut =
    !!r.finished_at && Date.now() - new Date(r.finished_at).getTime() > DISTILL_WAIT_MS;
  const status = r.distilled_at || rows.length > 0 || waitedOut ? "done" : "pending";
  return { status, items };
}

export async function listRecentWrites(
  tenant_id: string,
  opts: { since?: string | null; before?: string | null; limit?: number },
): Promise<RecentWriteItem[]> {
  const tid = asTenantId(tenant_id);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = tenantClient(tid)
    .from("memory_write_log")
    .select("id, action, note_id, matched_note_id, run_id, thread_id, created_at")
    .in("action", PILL_ACTIONS as unknown as string[])
    .is("restored_at", null);
  if (opts.since) q = q.gte("created_at", opts.since);
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`recent writes read failed: ${error.message}`);
  const rows = (data ?? []) as LogRow[];
  const items = await hydrate(tid, rows);
  const out: RecentWriteItem[] = [];
  for (const r of rows) {
    const it = items.get(r.id);
    if (!it) continue;
    out.push({
      ...it,
      source: {
        ...(r.run_id ? { run_id: r.run_id } : {}),
        ...(r.thread_id ? { thread_id: r.thread_id } : {}),
      },
      created_at: r.created_at,
    });
  }
  return out;
}

export type ForgetResult =
  | { ok: true; undo_token: string; undo_expires_at: string }
  | { ok: false; code: "not_found" | "anchor" };

export async function forgetNote(
  tenant_id: string,
  note_id: string,
  user_id: string | null,
): Promise<ForgetResult> {
  const tid = asTenantId(tenant_id);
  const { data: note } = await tenantClient(tid)
    .from("memory_note")
    .select("id, slug, archived_at")
    .eq("id", note_id)
    .maybeSingle();
  if (!note) return { ok: false, code: "not_found" };
  const n = note as { slug: string | null; archived_at: string | null };
  if (n.slug) return { ok: false, code: "anchor" };
  if (n.archived_at) return { ok: false, code: "not_found" };

  const now = Date.now();
  const { data: flipped, error: flipErr } = await tenantClient(tid)
    .from("memory_note")
    .update({
      archived_at: new Date(now).toISOString(),
      archive_reason: "forgotten",
      forgotten_at: new Date(now).toISOString(),
    })
    .eq("id", note_id)
    .is("archived_at", null)
    .select("id");
  if (flipErr) throw new Error(`forget failed: ${flipErr.message}`);
  if (!flipped || (flipped as unknown[]).length === 0) return { ok: false, code: "not_found" };

  const undo_expires_at = new Date(now + FORGET_UNDO_MS).toISOString();
  const { data: reqRow, error: reqErr } = await tenantClient(tid)
    .from("memory_forget_request")
    .insert({
      note_id,
      requested_by: user_id,
      undo_expires_at,
      purge_after: new Date(now + FORGET_PURGE_AFTER_MS).toISOString(),
    })
    .select("id")
    .single();
  if (reqErr || !reqRow) {
    await tenantClient(tid)
      .from("memory_note")
      .update({ archived_at: null, archive_reason: null, forgotten_at: null })
      .eq("id", note_id);
    throw new Error(`forget request failed: ${reqErr?.message ?? "no row"}`);
  }
  return { ok: true, undo_token: (reqRow as { id: string }).id, undo_expires_at };
}

export async function undoForget(tenant_id: string, undo_token: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "memory_undo_forget", {
    p_request_id: undo_token,
    p_grace_seconds: Math.round(FORGET_UNDO_GRACE_MS / 1000),
  });
  if (error) throw new Error(`undo forget failed: ${error.message}`);
  return data === true;
}

export async function purgeForgetRequest(
  tenant_id: string,
  request_id: string,
): Promise<"purged" | "not_due" | "retry"> {
  const tid = asTenantId(tenant_id);
  const now = Date.now();
  const { data, error } = await tenantClient(tid)
    .from("memory_forget_request")
    .update({ state: "purged", resolved_at: null, purge_after: new Date(now + PURGE_STALE_MS).toISOString() })
    .eq("id", request_id)
    .or(
      `and(state.eq.pending,purge_after.lte."${new Date(now).toISOString()}"),` +
        `and(state.eq.purged,resolved_at.is.null,purge_after.lte."${new Date(now).toISOString()}")`,
    )
    .select("note_id, requested_by, attempts");
  if (error) throw new Error(`forget claim failed: ${error.message}`);
  const req = (data as Array<{ note_id: string; requested_by: string | null; attempts: number }> | null)?.[0];
  if (!req) return "not_due";
  try {
    for (const col of ["note_id", "matched_note_id"]) {
      const { error: scrubErr } = await tenantClient(tid)
        .from("memory_write_log")
        .update({ candidate_title: null, candidate_body: null })
        .eq(col, req.note_id);
      if (scrubErr) throw new Error(`skip-log scrub failed: ${scrubErr.message}`);
    }
    try {
      await deleteNote(tenant_id, req.note_id, req.requested_by, "forgotten by the user");
    } catch (e) {
      if (!(e instanceof NoteNotFoundError)) throw e;
    }
    await tenantClient(tid)
      .from("memory_forget_request")
      .update({ resolved_at: new Date().toISOString() })
      .eq("id", request_id);
    return "purged";
  } catch (e) {
    const attempts = (req.attempts ?? 0) + 1;
    const delay = Math.min(FORGET_PURGE_AFTER_MS * 2 ** attempts, PURGE_BACKOFF_MAX_MS);
    await tenantClient(tid)
      .from("memory_forget_request")
      .update({
        state: "pending",
        attempts,
        resolved_at: null,
        purge_after: new Date(Date.now() + delay).toISOString(),
      })
      .eq("id", request_id);
    console.warn(`[memory-forget] purge failed for ${request_id} (attempt ${attempts}): ${(e as Error).message}`);
    if (attempts >= PURGE_ALERT_AFTER) {
      logReview({
        feature: "memory_forget",
        event: "purge",
        outcome: "stuck",
        run_id: request_id,
        tenant_id,
        meta: { attempts },
      });
    }
    return "retry";
  }
}

export async function undoUpdate(tenant_id: string, note_id: string): Promise<string | null> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "memory_undo_update", {
    p_new_note_id: note_id,
  });
  if (error) throw new Error(`undo update failed: ${error.message}`);
  return (data as string | null) ?? null;
}

export type KeepResult = "kept" | "not_open" | "not_in_pair";

export async function keepConflictValue(
  tenant_id: string,
  pair_id: string,
  note_id: string,
  user_id: string | null,
): Promise<KeepResult> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "memory_keep_conflict_value", {
    p_pair_id: pair_id,
    p_keep_note_id: note_id,
    p_user_id: user_id,
  });
  if (error) {
    if ((error as { code?: string }).code === "22023") return "not_in_pair";
    throw new Error(`keep conflict value failed: ${error.message}`);
  }
  return data === true ? "kept" : "not_open";
}

export type ConflictPairView = {
  pair_id: string;
  subject: string | null;
  attribute: string | null;
  created_at: string;
  values: Array<{ note_id: string; title: string; body_excerpt: string }>;
};

export async function listOpenConflicts(
  tenant_id: string,
  opts: { limit?: number; before?: string | null },
): Promise<ConflictPairView[]> {
  const tid = asTenantId(tenant_id);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = tenantClient(tid)
    .from("memory_conflict_pair")
    .select("id, existing_note_id, new_note_id, subject, attribute, created_at")
    .eq("status", "open");
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`conflicts read failed: ${error.message}`);
  const pairs = (data ?? []) as Array<{
    id: string;
    existing_note_id: string;
    new_note_id: string;
    subject: string | null;
    attribute: string | null;
    created_at: string;
  }>;
  if (pairs.length === 0) return [];
  const ids = Array.from(new Set(pairs.flatMap((p) => [p.existing_note_id, p.new_note_id])));
  const { data: notesData } = await tenantClient(tid)
    .from("memory_note")
    .select("id, title, body_markdown, archived_at, forgotten_at")
    .in("id", ids);
  const notes = new Map(((notesData ?? []) as NoteRow[]).map((n) => [n.id, n]));
  const out: ConflictPairView[] = [];
  for (const p of pairs) {
    const values = [p.existing_note_id, p.new_note_id]
      .map((id) => notes.get(id))
      .filter((n): n is NoteRow => !!n && !n.archived_at && !n.forgotten_at)
      .map((n) => ({ note_id: n.id, title: n.title ?? "", body_excerpt: excerpt(n.body_markdown) }));
    if (values.length === 2) {
      out.push({ pair_id: p.id, subject: p.subject, attribute: p.attribute, created_at: p.created_at, values });
    }
  }
  return out;
}

export type RestoreResult = "restored" | "not_found" | "not_restorable" | "already_restored";

const RESTORABLE_NOTE_TYPES: ReadonlySet<string> = new Set([
  "operator_preference",
  "agent_feedback",
  "tenant_project",
  "tenant_reference",
]);

export async function restoreWrite(tenant_id: string, log_id: string): Promise<RestoreResult> {
  const tid = asTenantId(tenant_id);
  const { data } = await tenantClient(tid)
    .from("memory_write_log")
    .select("id, action, note_id, candidate_title, candidate_body, candidate_note_type, restored_at")
    .eq("id", log_id)
    .maybeSingle();
  if (!data) return "not_found";
  const row = data as {
    action: string;
    note_id: string | null;
    candidate_title: string | null;
    candidate_body: string | null;
    candidate_note_type: string | null;
    restored_at: string | null;
  };
  if (row.restored_at) return "already_restored";
  if (row.action === "cleanup_superseded") {
    if (!row.note_id) return "not_restorable";
    await unsupersedeNote(tenant_id, row.note_id);
  } else if (row.action === "duplicate" || row.action === "rejected" || row.action === "junk") {
    if (!row.candidate_body) return "not_restorable";
    const note_type = RESTORABLE_NOTE_TYPES.has(row.candidate_note_type ?? "")
      ? (row.candidate_note_type as WriteNoteType)
      : "tenant_reference";
    await writeNote(tenant_id, {
      title: row.candidate_title ?? "",
      body_markdown: row.candidate_body,
      note_type,
      source: "human",
      source_class: "user_stated",
      trust_tier: 0,
    });
  } else {
    return "not_restorable";
  }
  await tenantClient(tid)
    .from("memory_write_log")
    .update({ restored_at: new Date().toISOString() })
    .eq("id", log_id);
  return "restored";
}
