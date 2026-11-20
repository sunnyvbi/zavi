
import { createHash } from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { embedOne } from "./embed";
import { PRIVATE_NOTE_TYPE_SET } from ".";
import {
  type ExistingFact,
  type SourceClass,
  type ValueKind,
  SOURCE_CLASSES,
  VALUE_KINDS,
} from "./write-gate";

export type WriteLogAction =
  | "added"
  | "duplicate"
  | "updated"
  | "conflict"
  | "rejected"
  | "junk"
  | "cleanup_superseded"
  | "proposed"
  | "proposal_expired";

export type WriteLogEntry = {
  source: string;
  action: WriteLogAction;
  run_id?: string | null;
  thread_id?: string | null;
  thread_message_id?: string | null;
  note_id?: string | null;
  matched_note_id?: string | null;
  candidate_title?: string | null;
  candidate_body?: string | null;
  candidate_note_type?: string | null;
  reason?: string | null;
};

export const GATE_NEIGHBOR_K = 8;
export const GATE_RECALLED_MAX = 8;
const GATE_MIN_COSINE = 0.5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UPDATE_RATIONALE = "memory-write: updated (same subject and attribute)";

function asValueKind(v: unknown): ValueKind | null {
  return VALUE_KINDS.has(v as ValueKind) ? (v as ValueKind) : null;
}
function asSourceClass(v: unknown): SourceClass | null {
  return SOURCE_CLASSES.has(v as SourceClass) ? (v as SourceClass) : null;
}

export async function recalledNoteIdsForRun(tenant_id: string, run_id: string): Promise<string[]> {
  if (!UUID_RE.test(run_id)) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_search_trace")
    .select("rank_components")
    .eq("run_id", run_id)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error || !data) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of data as Array<{ rank_components: Record<string, unknown> | null }>) {
    const rc = row.rank_components;
    const pairs = rc && Array.isArray(rc.returned_notes) ? rc.returned_notes : [];
    for (const p of pairs as Array<{ id?: unknown }>) {
      const id = p && typeof p.id === "string" ? p.id : null;
      if (id && UUID_RE.test(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out.slice(0, GATE_RECALLED_MAX);
}

type NoteKeyRow = {
  id: string;
  title: string | null;
  body_markdown: string | null;
  note_type: string;
  subject: string | null;
  attribute: string | null;
  value_kind: string | null;
  source_class: string | null;
  trust_tier: number | null;
};

export async function loadExistingFacts(
  tenant_id: string,
  opts: { queryText: string; run_id?: string | null },
): Promise<ExistingFact[]> {
  const tid = asTenantId(tenant_id);
  const out: ExistingFact[] = [];
  const seen = new Set<string>();

  try {
    const recalledIds = opts.run_id ? await recalledNoteIdsForRun(tenant_id, opts.run_id) : [];
    if (recalledIds.length > 0) {
      const { data } = await tenantClient(tid)
        .from("memory_note")
        .select("id, title, body_markdown, note_type, subject, attribute, value_kind, source_class, trust_tier")
        .in("id", recalledIds)
        .is("superseded_by", null)
        .is("archived_at", null)
        .is("slug", null);
      const byId = new Map(((data ?? []) as NoteKeyRow[]).map((r) => [r.id, r]));
      for (const id of recalledIds) {
        const r = byId.get(id);
        if (!r || PRIVATE_NOTE_TYPE_SET.has(r.note_type)) continue;
        seen.add(r.id);
        out.push({
          ref: `R${out.length + 1}`,
          note_id: r.id,
          title: r.title ?? "",
          body: r.body_markdown ?? "",
          note_type: r.note_type,
          subject: r.subject,
          attribute: r.attribute,
          value_kind: asValueKind(r.value_kind),
          source_class: asSourceClass(r.source_class),
          trust_tier: r.trust_tier ?? 2,
          recalled: true,
        });
      }
    }
  } catch (e) {
    console.warn(`[memory-write] recalled-note load failed: ${(e as Error).message}`);
  }

  const text = (opts.queryText ?? "").trim().slice(0, 4000);
  if (!text) return out;
  try {
    const emb = await embedOne(text, "query");
    const { data, error } = await tenantRpc(tid, "memory_fact_neighbors", {
      p_query_embedding: emb,
      p_limit: GATE_NEIGHBOR_K,
      p_min_cosine: GATE_MIN_COSINE,
    });
    if (error) throw new Error(error.message);
    let e = 0;
    for (const r of (data ?? []) as Array<{
      note_id: string;
      title: string | null;
      body_excerpt: string | null;
      note_type: string;
      subject: string | null;
      attribute: string | null;
      value_kind: string | null;
      source_class: string | null;
      trust_tier: number | null;
    }>) {
      if (seen.has(r.note_id) || PRIVATE_NOTE_TYPE_SET.has(r.note_type)) continue;
      seen.add(r.note_id);
      e += 1;
      out.push({
        ref: `E${e}`,
        note_id: r.note_id,
        title: r.title ?? "",
        body: r.body_excerpt ?? "",
        note_type: r.note_type,
        subject: r.subject,
        attribute: r.attribute,
        value_kind: asValueKind(r.value_kind),
        source_class: asSourceClass(r.source_class),
        trust_tier: r.trust_tier ?? 2,
        recalled: false,
      });
    }
  } catch (e) {
    console.warn(`[memory-write] neighbor lookup failed: ${(e as Error).message}`);
  }
  return out;
}

export async function recordWrites(tenant_id: string, entries: WriteLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    source: e.source.slice(0, 64),
    action: e.action,
    run_id: e.run_id && UUID_RE.test(e.run_id) ? e.run_id : null,
    thread_id: e.thread_id && UUID_RE.test(e.thread_id) ? e.thread_id : null,
    thread_message_id: e.thread_message_id && UUID_RE.test(e.thread_message_id) ? e.thread_message_id : null,
    note_id: e.note_id ?? null,
    matched_note_id: e.matched_note_id ?? null,
    candidate_title: e.candidate_title ? e.candidate_title.slice(0, 300) : null,
    candidate_body: e.candidate_body ? e.candidate_body.slice(0, 8000) : null,
    candidate_note_type: e.candidate_note_type ? e.candidate_note_type.slice(0, 64) : null,
    reason: e.reason ? e.reason.slice(0, 500) : null,
  }));
  try {
    const { error } = await tenantClient(asTenantId(tenant_id)).from("memory_write_log").insert(rows);
    if (error) console.warn(`[memory-write] write log insert failed: ${error.message}`);
  } catch (e) {
    console.warn(`[memory-write] write log insert threw: ${(e as Error).message}`);
  }
}

export async function supersedeForUpdate(
  tenant_id: string,
  new_note_id: string,
  old_note_id: string,
): Promise<boolean> {
  if (new_note_id === old_note_id) return false;
  const { error } = await tenantRpc(asTenantId(tenant_id), "apply_dream_verdict", {
    p_new_id: new_note_id,
    p_existing_id: old_note_id,
    p_verdict: "KEEP_NEW",
    p_rationale: UPDATE_RATIONALE,
  });
  if (error) {
    console.warn(`[memory-write] update supersede failed for ${old_note_id}: ${error.message}`);
    return false;
  }
  return true;
}

export async function openConflictPair(
  tenant_id: string,
  pair: {
    existing_note_id: string;
    new_note_id: string;
    subject: string | null;
    attribute: string | null;
    reason: string;
    run_id?: string | null;
  },
): Promise<void> {
  if (pair.existing_note_id === pair.new_note_id) return;
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_conflict_pair")
    .upsert(
      {
        existing_note_id: pair.existing_note_id,
        new_note_id: pair.new_note_id,
        subject: pair.subject,
        attribute: pair.attribute,
        reason: pair.reason.slice(0, 200),
        run_id: pair.run_id && UUID_RE.test(pair.run_id) ? pair.run_id : null,
      },
      { onConflict: "tenant_id,existing_note_id,new_note_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`conflict pair insert failed: ${error.message}`);
}

export const MAX_PROPOSALS_PER_RUN = 10;
export const PROPOSAL_PROMPT_BODY_CHARS = 8000;

export type MemoryProposal = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  thread_id?: string | null;
};

export function proposalKey(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 40);
}

export async function insertProposal(
  tenant_id: string,
  p: { run_id: string; thread_id: string | null; title: string; body: string; tags: string[] },
): Promise<{ proposal_id: string | null; already_queued: boolean }> {
  if (!UUID_RE.test(p.run_id)) throw new Error("memory proposal needs a run id");
  const tid = asTenantId(tenant_id);
  const key = proposalKey(p.title, p.body);
  const { data, error } = await tenantClient(tid)
    .from("memory_write_log")
    .insert({
      source: "memory_write_tool",
      action: "proposed",
      run_id: p.run_id,
      thread_id: p.thread_id && UUID_RE.test(p.thread_id) ? p.thread_id : null,
      candidate_title: p.title ? p.title.slice(0, 300) : null,
      candidate_body: p.body.slice(0, 8000),
      candidate_tags: p.tags.slice(0, 10),
      tool_call_key: key,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const { data: prior } = await tenantClient(tid)
        .from("memory_write_log")
        .select("id")
        .eq("run_id", p.run_id)
        .eq("tool_call_key", key)
        .maybeSingle();
      return { proposal_id: (prior as { id: string } | null)?.id ?? null, already_queued: true };
    }
    throw new Error(`memory proposal insert failed: ${error.message}`);
  }
  return { proposal_id: (data as { id: string }).id, already_queued: false };
}

export async function loadPendingProposals(tenant_id: string, run_id: string): Promise<MemoryProposal[]> {
  if (!UUID_RE.test(run_id)) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_write_log")
    .select("id, candidate_title, candidate_body, candidate_tags, thread_id")
    .eq("run_id", run_id)
    .eq("action", "proposed")
    .is("decided_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_PROPOSALS_PER_RUN);
  if (error) throw new Error(`memory proposals read failed: ${error.message}`);
  return ((data ?? []) as Array<{
    id: string;
    candidate_title: string | null;
    candidate_body: string | null;
    candidate_tags: string[] | null;
    thread_id: string | null;
  }>)
    .filter((r) => !!r.candidate_body)
    .map((r) => ({
      id: r.id,
      title: r.candidate_title ?? "",
      body: r.candidate_body ?? "",
      tags: Array.isArray(r.candidate_tags) ? r.candidate_tags : [],
      thread_id: r.thread_id ?? null,
    }));
}

export async function markProposalsDecided(tenant_id: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_write_log")
    .update({ decided_at: new Date().toISOString() })
    .in("id", ids)
    .eq("action", "proposed")
    .is("decided_at", null);
  if (error) throw new Error(`memory proposal decided stamp failed: ${error.message}`);
}

export type WriteGateDeps = {
  loadExistingFacts: typeof loadExistingFacts;
  recordWrites: typeof recordWrites;
  supersedeForUpdate: typeof supersedeForUpdate;
  openConflictPair: typeof openConflictPair;
  markProposalsDecided: typeof markProposalsDecided;
  stampCustomAgentProvenance?: (
    tenant_id: string,
    run_id: string,
    agent_slug: string,
    note_id: string,
  ) => Promise<boolean>;
};

export const defaultWriteGateDeps: WriteGateDeps = {
  loadExistingFacts,
  recordWrites,
  supersedeForUpdate,
  openConflictPair,
  markProposalsDecided,
};
