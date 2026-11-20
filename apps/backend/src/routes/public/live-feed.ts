
import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";

type FeedRow = { ts: string; agent_slug: string; verb: string };
type FeedCounts = { lifetime: number; day: number; hour: number; now: number };
type FeedPayload = {
  events: FeedRow[];
  counts: FeedCounts;
  lifetime_count: number;
  window_24h_count: number;
  generated_at: string;
};

const VERB_BY_SLUG: Record<string, string> = {
  operator: "handled an inbox item",
  engineer: "shipped code",
  pm: "drafted a plan",
  "chief-of-staff": "synthesized a brief",
  "performance-marketer": "tuned ad spend",
  advisor: "reviewed a deck",
  "growth-lead": "queued an experiment",
  research: "logged market intel",
  "dispute-response": "drafted a dispute response",
  "support-lead": "triaged a ticket",
  qa: "ran a test pass",
  "daily-brief": "sent a daily brief",
};

function verbFor(slug: string): string {
  return VERB_BY_SLUG[slug] ?? "ran a task";
}

let cache: { payload: FeedPayload; expires: number } | null = null;
const CACHE_MS = 30_000;
const RAW_LIMIT = 80;
const FEED_LIMIT = 8;

export async function publicLiveFeed(_req: Request, res: Response): Promise<void> {
  const now = Date.now();
  if (cache && cache.expires > now) {
    res.json(cache.payload);
    return;
  }

  const sb = serviceClient();

  const { data: tenantRows, error: tErr } = await sb
    .from("tenants")
    .select("id")
    .eq("show_in_public_feed", true);
  if (tErr) {
    res.status(500).json({ error: { code: "tenants_query_failed", message: tErr.message } });
    return;
  }
  const tenantIds = (tenantRows ?? []).map((r) => r.id);
  if (tenantIds.length === 0) {
    const empty: FeedPayload = {
      events: [],
      counts: { lifetime: 0, day: 0, hour: 0, now: 0 },
      lifetime_count: 0,
      window_24h_count: 0,
      generated_at: new Date().toISOString(),
    };
    cache = { payload: empty, expires: now + CACHE_MS };
    res.json(empty);
    return;
  }

  const { data: runs, error: rErr } = await sb
    .from("agent_runs")
    .select("agent_slug,finished_at,enqueued_at")
    .in("tenant_id", tenantIds)
    .eq("status", "success")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(RAW_LIMIT);
  if (rErr) {
    res.status(500).json({ error: { code: "runs_query_failed", message: rErr.message } });
    return;
  }

  const seen = new Set<string>();
  const events: FeedRow[] = [];
  for (const r of runs ?? []) {
    if (seen.has(r.agent_slug)) continue;
    seen.add(r.agent_slug);
    events.push({
      ts: r.finished_at ?? r.enqueued_at,
      agent_slug: r.agent_slug,
      verb: verbFor(r.agent_slug),
    });
    if (events.length >= FEED_LIMIT) break;
  }

  const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
  const hourAgo = new Date(now - 3600 * 1000).toISOString();
  const minuteAgo = new Date(now - 60 * 1000).toISOString();

  const [{ count: lifetime }, { count: day }, { count: hour }, { count: nowCount }] = await Promise.all([
    sb.from("agent_runs").select("id", { count: "exact", head: true }).in("tenant_id", tenantIds).eq("status", "success"),
    sb.from("agent_runs").select("id", { count: "exact", head: true }).in("tenant_id", tenantIds).eq("status", "success").gte("enqueued_at", dayAgo),
    sb.from("agent_runs").select("id", { count: "exact", head: true }).in("tenant_id", tenantIds).eq("status", "success").gte("enqueued_at", hourAgo),
    sb.from("agent_runs").select("id", { count: "exact", head: true }).in("tenant_id", tenantIds).eq("status", "success").gte("enqueued_at", minuteAgo),
  ]);

  const counts: FeedCounts = {
    lifetime: lifetime ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    now: nowCount ?? 0,
  };

  const payload: FeedPayload = {
    events,
    counts,
    lifetime_count: counts.lifetime,
    window_24h_count: counts.day,
    generated_at: new Date().toISOString(),
  };

  cache = { payload, expires: now + CACHE_MS };
  res.set("Cache-Control", "public, max-age=30");
  res.json(payload);
}
