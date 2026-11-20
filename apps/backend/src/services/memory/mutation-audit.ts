
import crypto from "crypto";
import { serviceClient } from "@/services/supabase";

export type MutationAuditAction = "delete" | "edit" | "retire";

export const BODY_SNAPSHOT_CAP = 4000;
export const TITLE_SNAPSHOT_CAP = 200;
export const REASON_CAP = 1000;

export type MutationAuditNote = {
  id: string;
  title?: string | null;
  body_markdown?: string | null;
  source?: string | null;
  note_type?: string | null;
  trust_tier?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export function titleHash(title: string | null | undefined): string {
  return crypto.createHash("sha256").update(title ?? "", "utf8").digest("hex").slice(0, 16);
}

export function buildDeleteSnapshot(note: MutationAuditNote): Record<string, unknown> {
  return {
    redaction: "rtbf_delete",
    note_id: note.id,
    title_sha256: titleHash(note.title),
    source: note.source ?? null,
    note_type: note.note_type ?? null,
    trust_tier: note.trust_tier ?? null,
    created_at: note.created_at ?? null,
    updated_at: note.updated_at ?? null,
  };
}

export function buildEditSnapshot(note: MutationAuditNote): Record<string, unknown> {
  return {
    redaction: "bounded_edit",
    note_id: note.id,
    title: (note.title ?? "").slice(0, TITLE_SNAPSHOT_CAP),
    body_markdown: (note.body_markdown ?? "").slice(0, BODY_SNAPSHOT_CAP),
    source: note.source ?? null,
    note_type: note.note_type ?? null,
  };
}

export function buildRetireSnapshot(
  note: MutationAuditNote,
  agent_slug?: string | null,
): Record<string, unknown> {
  return {
    redaction: "retire_ref",
    note_id: note.id,
    title_sha256: titleHash(note.title),
    source: note.source ?? null,
    note_type: note.note_type ?? null,
    retired_via: "brain_retire_note",
    agent_slug: agent_slug ?? null,
  };
}

export async function writeMutationAudit(params: {
  tenant_id: string;
  note_id: string;
  action: MutationAuditAction;
  before_snapshot: Record<string, unknown>;
  actor_user_id?: string | null;
  reason?: string | null;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { tenant_id, note_id, action, before_snapshot } = params;
  try {
    const { error } = await serviceClient()
      .from("memory_mutation_audit")
      .insert({
        tenant_id,
        note_id,
        actor_user_id: params.actor_user_id ?? null,
        action,
        reason: typeof params.reason === "string" ? params.reason.slice(0, REASON_CAP) : null,
        before_snapshot,
      });
    if (error) {
      const msg = `[memory_mutation_audit] insert failed (action=${action}): ${error.message}`;
      // eslint-disable-next-line no-console
      console.error(msg);
      params.log?.(msg, { action });
    }
  } catch (e) {
    const msg = `[memory_mutation_audit] insert threw (action=${action}): ${(e as Error).message}`;
    // eslint-disable-next-line no-console
    console.error(msg);
    params.log?.(msg, { action });
  }
}
