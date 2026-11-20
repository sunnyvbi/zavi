
import crypto from "crypto";
import { serviceClient } from "@/services/supabase";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER, MODELS } from "@/services/llm/models";
import type { MemoryDocSlug } from "@/services/memory/loader";
import type { KeyFact } from "@/services/memory/generate-anchors";
import { writeMutationAudit, buildRetireSnapshot } from "@/services/memory/mutation-audit";

export type PendingAnchorCorrection = {
  slug: MemoryDocSlug;
  proposed_body: string;
  key_facts: KeyFact[] | undefined;
  metadata: Record<string, unknown>;
  hash: string;
  run_id: string | null;
  created_at: string;
};

export const PENDING_TTL_MS = 30 * 60 * 1000;

export function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 32);
}

export async function stashPending(
  tenant_id: string,
  thread_id: string,
  pending: PendingAnchorCorrection,
): Promise<void> {
  const { error } = await serviceClient()
    .from("agent_threads")
    .update({ pending_anchor_correction: pending })
    .eq("id", thread_id)
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`stashPending failed: ${error.message}`);
}

export async function readPending(
  tenant_id: string,
  thread_id: string,
): Promise<PendingAnchorCorrection | null> {
  const { data, error } = await serviceClient()
    .from("agent_threads")
    .select("pending_anchor_correction")
    .eq("id", thread_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error || !data) return null;
  const raw = (data as { pending_anchor_correction?: unknown }).pending_anchor_correction;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<PendingAnchorCorrection>;
  if (typeof p.slug !== "string" || typeof p.proposed_body !== "string") return null;
  return p as PendingAnchorCorrection;
}

export async function clearPending(tenant_id: string, thread_id: string): Promise<void> {
  await serviceClient()
    .from("agent_threads")
    .update({ pending_anchor_correction: null })
    .eq("id", thread_id)
    .eq("tenant_id", tenant_id);
}

export function isPendingFresh(p: PendingAnchorCorrection): boolean {
  const t = Date.parse(p.created_at);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= PENDING_TTL_MS;
}

export async function supersedeContradictingDerivedNotes(
  tenant_id: string,
  slug: MemoryDocSlug,
  winnerNoteId: string,
  correctionText: string,
): Promise<number> {
  try {
    const sb = serviceClient();
    const { data: rows, error } = await sb
      .from("memory_note")
      .select("id, title, body_markdown")
      .eq("tenant_id", tenant_id)
      .is("slug", null)
      .is("superseded_by", null)
      .in("note_type", ["tenant_reference", "tenant_project"])
      .like("source", "auto_distill%")
      .order("created_at", { ascending: false })
      .limit(60);
    if (error || !rows || rows.length === 0) return 0;

    const candidates = rows as Array<{ id: string; title: string | null; body_markdown: string | null }>;
    const list = candidates
      .map((r, i) => `[${i}] ${(r.title ?? "").slice(0, 120)} — ${(r.body_markdown ?? "").slice(0, 280)}`)
      .join("\n");

    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: MODELS.anthropic.haiku,
      max_tokens: 256,
      system:
        "You decide which stored notes are now FACTUALLY CONTRADICTED or made stale by an operator's " +
        "correction to their company knowledge. Be conservative: include a note ONLY if the correction " +
        "directly negates a claim in it. Return ONLY a JSON array of the integer indices to retire, e.g. [0,3]. " +
        "Empty array if none clearly contradicted.",
      messages: [
        {
          role: "user",
          content: `Operator correction to the "${slug}" anchor:\n${correctionText.slice(0, 1000)}\n\nNotes:\n${list}\n\nIndices to retire (JSON array only):`,
        },
      ],
      timeoutMs: 20_000,
    });

    const m = resp.text.match(/\[[\d,\s]*\]/);
    if (!m) return 0;
    const idxs = (JSON.parse(m[0]) as unknown[])
      .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < candidates.length)
      .slice(0, 10);
    if (idxs.length === 0) return 0;

    const loserIds = idxs.map((i) => candidates[i].id);
    const { error: upErr } = await sb
      .from("memory_note")
      .update({
        superseded_by: winnerNoteId,
        supersession_rationale: `Operator conversational correction of the ${slug} anchor`,
      })
      .eq("tenant_id", tenant_id)
      .in("id", loserIds)
      .is("superseded_by", null);
    if (upErr) return 0;
    return loserIds.length;
  } catch {
    return 0;
  }
}

export async function retireNotesByDescription(
  tenant_id: string,
  description: string,
  opts?: { agent_slug?: string | null; actor_user_id?: string | null },
): Promise<{ retired: number; titles: string[] }> {
  const empty = { retired: 0, titles: [] as string[] };
  try {
    const sb = serviceClient();
    const { data: rows, error } = await sb
      .from("memory_note")
      .select("id, title, body_markdown, source, note_type")
      .eq("tenant_id", tenant_id)
      .is("slug", null)
      .is("superseded_by", null)
      .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
      .order("created_at", { ascending: false })
      .limit(60);
    if (error || !rows || rows.length === 0) return empty;

    const candidates = rows as Array<{
      id: string;
      title: string | null;
      body_markdown: string | null;
      source?: string | null;
      note_type?: string | null;
    }>;
    const list = candidates
      .map((r, i) => `[${i}] ${(r.title ?? "").slice(0, 120)} — ${(r.body_markdown ?? "").slice(0, 280)}`)
      .join("\n");

    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: MODELS.anthropic.haiku,
      max_tokens: 256,
      system:
        "An operator wants to RETIRE (remove) specific stored notes. Return ONLY the integer indices of " +
        "the notes that clearly match what they describe — be conservative; include a note ONLY if it is " +
        "clearly the one(s) they mean. Return a JSON array of indices, e.g. [2]. Empty array if no clear match.",
      messages: [
        {
          role: "user",
          content: `Operator wants to retire: ${description.slice(0, 1000)}\n\nNotes:\n${list}\n\nIndices to retire (JSON array only):`,
        },
      ],
      timeoutMs: 20_000,
    });

    const m = resp.text.match(/\[[\d,\s]*\]/);
    if (!m) return empty;
    const idxs = (JSON.parse(m[0]) as unknown[])
      .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < candidates.length)
      .slice(0, 3);
    if (idxs.length === 0) return empty;

    const picked = idxs.map((i) => candidates[i]);
    let retired = 0;
    const titles: string[] = [];
    for (const note of picked) {
      const { error: upErr } = await sb
        .from("memory_note")
        .update({
          superseded_by: note.id,
          supersession_rationale: "Operator conversational retire request",
        })
        .eq("tenant_id", tenant_id)
        .eq("id", note.id)
        .is("superseded_by", null);
      if (!upErr) {
        retired += 1;
        titles.push(note.title ?? "(untitled note)");
        await writeMutationAudit({
          tenant_id,
          note_id: note.id,
          action: "retire",
          actor_user_id: opts?.actor_user_id ?? null,
          reason: description,
          before_snapshot: buildRetireSnapshot(note, opts?.agent_slug ?? null),
        });
      }
    }
    return { retired, titles };
  } catch {
    return empty;
  }
}
