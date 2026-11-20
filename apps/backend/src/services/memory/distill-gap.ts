
import { serviceClient } from "../supabase";
import { aggregateGaps, type GapEpisode } from "./gap-aggregate";
import { isGapDistillEnabled } from "./gap-flag";
import { writeNote } from "./index";

const LOOKBACK_DAYS = 14;
const PAGE_SIZE = 1000;
const MIN_COUNT = 2;
const MAX_UPSERTS = 50;
const FAILED_STATUSES = ["failed", "parse_failed", "dispatch_error"];

export async function distillGaps(): Promise<{ groups: number; upserted: number }> {
  if (!(await isGapDistillEnabled())) return { groups: 0, upserted: 0 };

  const sb = serviceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: rows, error } = await sb
    .from("memory_signal")
    .select("tenant_id, agent_slug, status, created_at, redacted_trajectory, trust_tier")
    .in("status", FAILED_STATUSES)
    .lt("trust_tier", 3)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) {
    console.warn(`[distill-gap] memory_signal scan failed: ${error.message}`);
    return { groups: 0, upserted: 0 };
  }

  const episodes: GapEpisode[] = [];
  for (const r of (rows ?? []) as Array<{
    tenant_id: string;
    agent_slug: string;
    status: string;
    created_at: string;
    redacted_trajectory: { question?: unknown } | null;
  }>) {
    const q = r.redacted_trajectory?.question;
    if (typeof q === "string" && q.trim()) {
      episodes.push({
        tenant_id: r.tenant_id,
        agent_slug: r.agent_slug,
        status: r.status,
        created_at: r.created_at,
        question: q,
      });
    }
  }

  const groups = aggregateGaps(episodes, MIN_COUNT);
  let upserted = 0;
  for (const g of groups.slice(0, MAX_UPSERTS)) {
    const sref = `gap:${g.hash}`;
    const metadata = {
      kind: "knowledge_gap",
      count: g.count,
      last_seen: g.last_seen,
      agents: g.agents,
      statuses: g.statuses,
    };
    try {
      const { data: existing } = await sb
        .from("memory_note")
        .select("id, metadata")
        .eq("tenant_id", g.tenant_id)
        .eq("note_type", "knowledge_gap")
        .eq("source_ref", sref)
        .maybeSingle();

      if (existing) {
        const merged = { ...((existing as { metadata: Record<string, unknown> | null }).metadata ?? {}), ...metadata };
        await sb
          .from("memory_note")
          .update({ metadata: merged, updated_at: new Date().toISOString() })
          .eq("id", (existing as { id: string }).id);
      } else {
        await writeNote(g.tenant_id, {
          title: `Unanswered: ${g.question.slice(0, 80)}`,
          body_markdown: `Recurring question the fleet could not answer (failed ${g.count}× in ${LOOKBACK_DAYS}d):\n\n> ${g.question}`,
          source: "gap_distill",
          source_ref: sref,
          note_type: "knowledge_gap",
          metadata,
        });
      }
      upserted += 1;
    } catch (e) {
      console.error(`[distill-gap] upsert ${sref} FAILED: ${(e as Error).message}`, e);
    }
  }
  return { groups: groups.length, upserted };
}
