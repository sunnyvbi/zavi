import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { readLiveRuns, type LiveStuntConfig } from "./config";
import { buildSnapshot, type StuntSnapshot } from "./snapshot";
import { realSnapshotDeps } from "./snapshot-deps";
import { buildDayDraft, type DraftInputs, type Entry } from "./draft";
import { shownHeadline } from "./headline";
import { dayKey, dayRangeUtc, ET, stuntDay } from "./days";
import { hashToken, newReviewToken } from "./token";

const DAY_MS = 86400000;

export type SnapshotJobDeps = {
  readRuns(): Promise<LiveStuntConfig[]>;
  readPrevious(cfg: LiveStuntConfig): Promise<StuntSnapshot | null>;
  build(cfg: LiveStuntConfig, previous: StuntSnapshot | null): Promise<StuntSnapshot>;
  save(cfg: LiveStuntConfig, s: StuntSnapshot): Promise<void>;
  now(): Date;
};

export async function runSnapshotJob(d: SnapshotJobDeps) {
  const runs = await d.readRuns();
  if (runs.length === 0) return { skipped: "off" as const, runs: [] as { slug: string; result: string }[] };
  const t = d.now().getTime();
  const out: { slug: string; result: string }[] = [];
  for (const cfg of runs) {
    if (t < Date.parse(cfg.start_at) - 29 * DAY_MS || t > Date.parse(cfg.end_at) + 2 * DAY_MS) {
      out.push({ slug: cfg.slug, result: "window" });
      continue;
    }
    const previous = await d.readPrevious(cfg);
    const snap = await d.build(cfg, previous);
    await d.save(cfg, snap);
    out.push({ slug: cfg.slug, result: `saved:${snap.by_day.length}` });
  }
  return { runs: out };
}

export const realSnapshotJobDeps: SnapshotJobDeps = {
  readRuns: readLiveRuns,
  async readPrevious(cfg) {
    const { data } = await tenantClient(asTenantId(cfg.tenant_id))
      .from("live_stunt_snapshots").select("payload").eq("run_slug", cfg.slug).order("taken_at", { ascending: false }).limit(1);
    return ((data ?? []) as { payload: StuntSnapshot }[])[0]?.payload ?? null;
  },
  build: (cfg, previous) => buildSnapshot(cfg, realSnapshotDeps(cfg), previous),
  async save(cfg, s) {
    const db = tenantClient(asTenantId(cfg.tenant_id));
    const { error } = await db.from("live_stunt_snapshots").insert({ tenant_id: cfg.tenant_id, run_slug: cfg.slug, taken_at: s.taken_at, payload: s });
    if (error) throw new Error(`live_stunt_snapshot_insert_failed: ${error.message}`);
    await db.from("live_stunt_snapshots").delete().eq("run_slug", cfg.slug).lt("taken_at", new Date(Date.now() - 3 * DAY_MS).toISOString());
  },
  now: () => new Date(),
};

export type DraftJobDeps = {
  readRuns(): Promise<LiveStuntConfig[]>;
  gather(cfg: LiveStuntConfig, day: string): Promise<DraftInputs>;
  upsert(cfg: LiveStuntConfig, day: string, full: Entry, neutral: Entry, tokenHash: string, expiresAt: string): Promise<"ok" | "kept_published">;
  now(): Date;
};

export type DraftStepResult = {
  slug: string;
  tenant_id: string;
  day: string;
  dayNumber: number;
  headline: string;
  token: string;
  result: "ok" | "kept_published";
  ttlHours: number;
};

export async function runDraftJob(d: DraftJobDeps): Promise<DraftStepResult[]> {
  const runs = await d.readRuns();
  const now = d.now();
  const out: DraftStepResult[] = [];
  for (const cfg of runs) {
    if (now.getTime() < Date.parse(cfg.start_at) || now.getTime() > Date.parse(cfg.end_at) + 3 * 3600000) continue;
    const day = dayKey(now, ET);
    const inputs = await d.gather(cfg, day);
    const { full, neutral } = buildDayDraft(inputs);
    const token = newReviewToken();
    const expiresAt = new Date(now.getTime() + cfg.review_ttl_hours * 3600000).toISOString();
    const result = await d.upsert(cfg, day, full, neutral, hashToken(token), expiresAt);
    out.push({ slug: cfg.slug, tenant_id: cfg.tenant_id, day, dayNumber: stuntDay(now, cfg.start_at), headline: full.headline, token, result, ttlHours: cfg.review_ttl_hours });
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const realDraftJobDeps: DraftJobDeps = {
  readRuns: readLiveRuns,
  async gather(cfg, day) {
    const db = tenantClient(asTenantId(cfg.tenant_id));
    const { since, until } = dayRangeUtc(day, ET);
    const [actions, notes, campaigns, snap, prior] = await Promise.all([
      db.from("channel_actions").select("channel_slug, exec_payload").eq("exec_status", "executed").gte("executed_at", since).lt("executed_at", until),
      db.from("cgo_notes").select("changed, items").gte("created_at", since).lt("created_at", until).order("created_at", { ascending: true }),
      db.from("ad_campaigns").select("name"),
      db.from("live_stunt_snapshots").select("payload").eq("run_slug", cfg.slug).order("taken_at", { ascending: false }).limit(1),
      db.from("live_stunt_days").select("day, status, why:full_entry->>why, edited_why, headline:full_entry->>headline, edited_headline").eq("run_slug", cfg.slug).lt("day", day).limit(100),
    ]);
    for (const r of [actions, notes, campaigns, snap, prior]) if (r.error) throw new Error(`live_stunt_draft_read_failed: ${r.error.message}`);
    const budgetChanges = ((actions.data ?? []) as { channel_slug: string; exec_payload: Record<string, unknown> | null }[])
      .filter((a) => num(a.exec_payload?.daily_budget_usd) !== null)
      .map((a) => ({
        channel_slug: a.channel_slug,
        from_usd: num(a.exec_payload?.expected_current_daily_budget_usd),
        to_usd: num(a.exec_payload?.daily_budget_usd),
        rationale: typeof a.exec_payload?.rationale === "string" ? (a.exec_payload.rationale as string) : null,
      }));
    const noteRows = (notes.data ?? []) as { changed: string[] | null; items: unknown }[];
    const changedLines = noteRows.flatMap((n) => n.changed ?? []);
    const moveReasons = noteRows.flatMap((n) => (Array.isArray(n.items) ? n.items : []) as { section?: unknown; channel_slug?: unknown; reason?: unknown }[])
      .filter((it) => it.section === "working_on" && typeof it.channel_slug === "string" && typeof it.reason === "string" && it.reason.trim())
      .map((it) => ({ channel_slug: it.channel_slug as string, reason: (it.reason as string).trim() }));
    type PriorRow = { day: string; status: string; why: string | null; edited_why: string | null; headline: string | null; edited_headline: string | null };
    const priorRows = (prior.data ?? []) as PriorRow[];
    const campaignNames = ((campaigns.data ?? []) as { name: string | null }[]).map((c) => c.name ?? "").filter(Boolean);
    const snapshot = ((snap.data ?? []) as { payload: StuntSnapshot }[])[0]?.payload;
    const row = snapshot?.by_day.find((r) => r.day === day);
    return {
      day,
      isFirstDay: day === dayKey(new Date(cfg.start_at), ET),
      budgetChanges,
      changedLines,
      results: { spent_usd: row ? row.spent_usd : null, bookings: row?.bookings ?? null, hosts: row?.hosts ?? null, booking_value_usd: row?.booking_value_usd ?? null },
      pace: snapshot?.pace ?? null,
      campaignNames,
      moveReasons,
      priorWhys: priorRows.flatMap((r) => [r.why, r.edited_why]).filter((w): w is string => !!w),
      priorHeadlines: priorRows.filter((r) => r.status === "published").map((r) => shownHeadline(r.edited_headline, r.headline)).filter(Boolean),
    };
  },
  async upsert(cfg, day, full, neutral, tokenHash, expiresAt) {
    const { data, error } = await tenantRpc(asTenantId(cfg.tenant_id), "live_stunt_draft_upsert", {
      p_tenant_id: cfg.tenant_id, p_run_slug: cfg.slug, p_day: day, p_full: full, p_neutral: neutral, p_token_hash: tokenHash, p_expires: expiresAt,
    });
    if (error) throw new Error(`live_stunt_draft_upsert_failed: ${error.message}`);
    return data === "kept_published" ? "kept_published" : "ok";
  },
  now: () => new Date(),
};

export function reviewLink(slug: string, day: string, token: string): string {
  const origin = (process.env.WEB_ORIGIN ?? "https://www.zaviagent.com").split(",")[0].trim().replace(/\/$/, "");
  return `${origin}/live/${slug}/review/${day}?t=${token}`;
}
