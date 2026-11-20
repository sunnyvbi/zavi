
import { serviceClient } from "@/services/supabase";
import { writeNote, type WriteNoteType } from "@/services/memory";

export type DreamApplyResult = {
  applied: boolean;
  reason: string;
  candidate_id: string;
  merged_note_id?: string;
};

type CandidateRow = {
  id: string;
  tenant_id: string;
  new_note_id: string;
  existing_note_id: string;
  verdict: "KEEP_NEW" | "KEEP_OLD" | "MERGE";
  rationale: string | null;
  merged_body: string | null;
  note_type: string | null;
  source_ref: string | null;
  label: string;
};

async function noteActive(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  note_id: string,
): Promise<{ active: boolean; title: string }> {
  const { data } = await sb
    .from("memory_note")
    .select("id, title, superseded_by")
    .eq("tenant_id", tenant_id)
    .eq("id", note_id)
    .maybeSingle();
  const row = data as { id: string; title: string; superseded_by: string | null } | null;
  return { active: !!row && row.superseded_by === null, title: row?.title ?? "" };
}

async function logVerdict(
  sb: ReturnType<typeof serviceClient>,
  c: CandidateRow,
): Promise<void> {
  await sb
    .from("dream_cycle_verdicts")
    .insert({
      tenant_id: c.tenant_id,
      new_note_id: c.new_note_id,
      existing_note_id: c.existing_note_id,
      verdict: c.verdict,
      rationale: c.rationale,
    })
    .then(
      () => {},
      () => {},
    );
}

async function markRejected(
  sb: ReturnType<typeof serviceClient>,
  candidate_id: string,
  decided_by: string | null,
  reason: string,
): Promise<void> {
  await sb
    .from("dream_candidates")
    .update({
      label: "rejected",
      decision_reason: reason,
      decided_by,
      decided_at: new Date().toISOString(),
    })
    .eq("id", candidate_id);
}

export async function approveDreamCandidate(
  candidate_id: string,
  decided_by: string,
): Promise<DreamApplyResult> {
  const sb = serviceClient();

  const { data: claimedRaw } = await sb
    .from("dream_candidates")
    .update({ label: "approved", decided_by, decided_at: new Date().toISOString() })
    .eq("id", candidate_id)
    .eq("label", "pending")
    .select("*")
    .maybeSingle();
  const c = claimedRaw as CandidateRow | null;
  if (!c) {
    return { applied: false, reason: "candidate not pending (already decided or missing)", candidate_id };
  }

  const newActive = await noteActive(sb, c.tenant_id, c.new_note_id);
  const existingActive = await noteActive(sb, c.tenant_id, c.existing_note_id);
  if (!newActive.active || !existingActive.active) {
    await markRejected(sb, candidate_id, decided_by, "stale: a note was edited/superseded/deleted since the candidate was queued");
    return { applied: false, reason: "stale_notes", candidate_id };
  }

  try {
    if (c.verdict === "MERGE") {
      if (!c.merged_body || c.merged_body.length === 0) {
        await markRejected(sb, candidate_id, decided_by, "merge candidate has empty merged_body");
        return { applied: false, reason: "empty_merged_body", candidate_id };
      }
      const merged = await writeNote(c.tenant_id, {
        title: `[merged] ${newActive.title}`.slice(0, 200),
        body_markdown: c.merged_body.slice(0, 8000),
        source: "dream_cycle_merge",
        source_ref: c.source_ref ?? `${c.new_note_id}+${c.existing_note_id}`,
        note_type: (c.note_type ?? "untyped") as WriteNoteType,
        tags: ["merged"],
      });
      for (const original of [c.new_note_id, c.existing_note_id]) {
        await sb.rpc("apply_dream_verdict", {
          p_tenant_id: c.tenant_id,
          p_new_id: merged.note_id,
          p_existing_id: original,
          p_verdict: "MERGE",
          p_rationale: c.rationale,
        });
      }
      await logVerdict(sb, c);
      return { applied: true, reason: "merged", candidate_id, merged_note_id: merged.note_id };
    }

    await sb.rpc("apply_dream_verdict", {
      p_tenant_id: c.tenant_id,
      p_new_id: c.new_note_id,
      p_existing_id: c.existing_note_id,
      p_verdict: c.verdict,
      p_rationale: c.rationale,
    });
    await logVerdict(sb, c);
    return { applied: true, reason: c.verdict.toLowerCase(), candidate_id };
  } catch (e) {
    await markRejected(sb, candidate_id, decided_by, `apply_failed: ${(e as Error).message}`.slice(0, 500));
    return { applied: false, reason: "apply_failed", candidate_id };
  }
}

export async function rejectDreamCandidate(
  candidate_id: string,
  decided_by: string,
): Promise<{ rejected: boolean; reason: string; candidate_id: string }> {
  const sb = serviceClient();
  const { data } = await sb
    .from("dream_candidates")
    .update({
      label: "rejected",
      decision_reason: "founder_rejected",
      decided_by,
      decided_at: new Date().toISOString(),
    })
    .eq("id", candidate_id)
    .eq("label", "pending")
    .select("id, tenant_id, new_note_id, existing_note_id, verdict, rationale")
    .maybeSingle();
  const c = data as Pick<CandidateRow, "id" | "tenant_id" | "new_note_id" | "existing_note_id" | "verdict" | "rationale"> | null;
  if (!c) {
    return { rejected: false, reason: "candidate not pending (already decided or missing)", candidate_id };
  }
  await logVerdict(sb, c as CandidateRow);
  return { rejected: true, reason: "founder_rejected", candidate_id };
}
