
import { serviceClient } from "../supabase";
import { buildEpisodeNote, type EpisodeSignalRow } from "./build-episode-note";
import { writeNote } from "./index";

const LOOKBACK_DAYS = 14;
const PAGE_SIZE = 1000;
const MAX_WRITES = 50;

type StampedEpisodeRow = {
  tenant_id: string;
  agent_slug: string;
  agent_run_id: string;
  trust_tier: number;
  outcome: string | null;
  redacted_trajectory: { question?: unknown; output_text?: unknown } | null;
};

async function lookupRunThreadId(agent_run_id: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("agent_runs")
    .select("payload")
    .eq("id", agent_run_id)
    .maybeSingle();
  const payload = data?.payload;
  if (!payload || typeof payload !== "object") return null;
  const tid = (payload as { thread_id?: unknown }).thread_id;
  return typeof tid === "string" ? tid : null;
}

export async function distillEpisodes(): Promise<{ scanned: number; written: number }> {
  const sb = serviceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: rows, error } = await sb
    .from("memory_signal")
    .select("tenant_id, agent_slug, agent_run_id, trust_tier, outcome, redacted_trajectory")
    .eq("signal_kind", "episode")
    .not("outcome", "is", null)
    .lt("trust_tier", 3)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) {
    console.warn(`[distill-episode] memory_signal scan failed: ${error.message}`);
    return { scanned: 0, written: 0 };
  }

  const scanned = (rows ?? []).length;
  let written = 0;

  for (const r of (rows ?? []) as StampedEpisodeRow[]) {
    if (written >= MAX_WRITES) break;
    if (r.outcome !== "accepted" && r.outcome !== "rejected") continue;

    const built = buildEpisodeNote({
      agent_slug: r.agent_slug,
      agent_run_id: r.agent_run_id,
      outcome: r.outcome,
      trust_tier: r.trust_tier,
      redacted_trajectory: r.redacted_trajectory,
    } as EpisodeSignalRow);
    if (!built) continue;

    try {
      const { data: existing } = await sb
        .from("memory_note")
        .select("id")
        .eq("tenant_id", r.tenant_id)
        .eq("note_type", "agent_experience")
        .eq("source_ref", built.source_ref)
        .maybeSingle();
      if (existing) continue;

      const thread_id = await lookupRunThreadId(r.agent_run_id).catch(() => null);

      await writeNote(r.tenant_id, {
        title: built.title,
        body_markdown: built.body_markdown,
        source: "episode_distill",
        source_ref: built.source_ref,
        note_type: "agent_experience",
        agent_slug: r.agent_slug,
        trust_tier: 2,
        metadata: built.metadata,
        thread_id,
      });
      written += 1;
    } catch (e) {
      console.error(
        `[distill-episode] write ${built.source_ref} FAILED: ${(e as Error).message}`,
        e,
      );
    }
  }

  return { scanned, written };
}
