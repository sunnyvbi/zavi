
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting, getSetting, setTenantSetting } from "@/services/settings";
import { getCompanyFacts, joinCompetitors, setCompanyFact } from "@/services/company/facts";
import { validateCustomBrands } from "@/services/competitor-intel/brands";
import {
  applyDecision,
  coerceDecisions,
} from "@/services/competitor-intel/rec-decisions";
import { enqueueCompetitorScan } from "@/services/competitor-intel/scan";
import { COMPETITOR_INTEL_SOURCE, mondayUtc } from "@/agents/research/persist-snapshot";
import { logEvent } from "@/services/logging/logEvent";
import { refusalFor } from "@/services/agents/refusal";

const SNAPSHOT_LIMIT = 12;
const CUSTOM_BRANDS_KEY = "competitor_intel_custom_brands";
const REC_DECISIONS_KEY = "competitor_intel_rec_decisions";

const IN_FLIGHT_RUN_STATUSES = ["queued", "dispatched", "running"] as const;

async function hasInFlightScan(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  opts: { throwOnError?: boolean } = {},
): Promise<boolean> {
  const { data, error } = await sb
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "research")
    .eq("payload->>source", COMPETITOR_INTEL_SOURCE)
    .in("status", IN_FLIGHT_RUN_STATUSES as unknown as string[])
    .limit(1);
  if (error && opts.throwOnError) throw new Error(`in-flight check failed: ${error.message}`);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

export async function competitorIntelGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const [enabled, record, decisionsRaw] = await Promise.all([
      getBoolSetting("competitor_intel_weekly_enabled", auth.tenant_id),
      getCompanyFacts(auth.tenant_id),
      getSetting(REC_DECISIONS_KEY, auth.tenant_id),
    ]);

    const sb = serviceClient();
    const { data, error } = await sb
      .from("competitor_snapshots")
      .select("week_bucket, landscape, delta, created_at")
      .eq("tenant_id", auth.tenant_id)
      .order("week_bucket", { ascending: false })
      .limit(SNAPSHOT_LIMIT);

    if (error) {
      res.status(500).json({
        error: { code: "snapshot_read_failed", message: error.message },
      });
      return;
    }

    const snapshots = data ?? [];
    const scan_in_progress =
      enabled && snapshots.length === 0
        ? await hasInFlightScan(sb, auth.tenant_id)
        : false;

    res.json({
      enabled,
      snapshots: snapshots.map((row) => ({
        week_bucket: row.week_bucket,
        landscape: row.landscape,
        delta: row.delta,
        created_at: row.created_at,
      })),
      custom_brands: record.competitors,
      rec_decisions: coerceDecisions(decisionsRaw),
      scan_in_progress,
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "competitor_intel_failed", message: (e as Error).message },
    });
  }
}

export async function postCompetitorRecDecision(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { rec_key?: unknown; title?: unknown; status?: unknown };
  let stored: unknown;
  try {
    stored = await getSetting(REC_DECISIONS_KEY, auth.tenant_id);
  } catch (e) {
    res.status(500).json({
      error: { code: "rec_decisions_read_failed", message: (e as Error).message },
    });
    return;
  }

  const result = applyDecision(stored, body, new Date().toISOString());
  if (!result.ok) {
    res.status(400).json({ error: { code: result.code, message: result.message } });
    return;
  }

  try {
    await setTenantSetting(auth.tenant_id, REC_DECISIONS_KEY, result.decisions, auth.user_id);
  } catch (e) {
    res.status(500).json({
      error: { code: "rec_decisions_save_failed", message: (e as Error).message },
    });
    return;
  }

  res.json({ rec_decisions: result.decisions });
}

const REC_EVENT_STATUSES = new Set(["act", "snooze", "dismiss"]);
const REC_EVENT_AGENT = /^[a-z-]{1,40}$/;
export async function postCompetitorRecEvent(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { event?: unknown; agent_slug?: unknown; status?: unknown };
  const event = body.event === "ask_agent" || body.event === "decision" ? body.event : null;
  if (!event) {
    res.status(400).json({ error: { code: "bad_event", message: "event must be ask_agent|decision" } });
    return;
  }
  const status =
    typeof body.status === "string" && REC_EVENT_STATUSES.has(body.status) ? body.status : null;
  const agent_slug =
    typeof body.agent_slug === "string" && REC_EVENT_AGENT.test(body.agent_slug)
      ? body.agent_slug
      : undefined;

  try {
    await logEvent({
      level: "info",
      source: "competitor_intel",
      tenant_id: auth.tenant_id,
      code: `competitor_intel.rec_${event}${status ? `.${status}` : ""}`,
      meta: agent_slug ? { agent_slug } : {},
    });
  } catch {
  }
  res.status(202).json({ ok: true });
}

export async function postCompetitorBrands(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const allowed = await requireTenantRole(auth, ["owner", "admin"], res);
  if (!allowed) return;

  const body = (req.body ?? {}) as { brands?: unknown };
  const result = validateCustomBrands(body.brands);
  if (!result.ok) {
    res.status(400).json({ error: { code: result.code, message: result.message } });
    return;
  }

  try {
    const { ok, error } = await setCompanyFact(
      auth.tenant_id,
      "competitors",
      joinCompetitors(result.brands),
      `competitor tab, user ${auth.user_id}`,
    );
    if (!ok) throw new Error(error ?? "the list did not save");
  } catch (e) {
    res.status(500).json({
      error: { code: "custom_brands_save_failed", message: (e as Error).message },
    });
    return;
  }

  res.json({ brands: result.brands, dropped: result.dropped });
}

export async function postCompetitorFirstScan(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const enabled = await getBoolSetting("competitor_intel_weekly_enabled", auth.tenant_id);
    if (!enabled) {
      res.status(403).json({
        error: { code: "not_enabled", message: "Competitor Intel isn't enabled for this workspace." },
      });
      return;
    }

    const sb = serviceClient();
    const { count, error: countErr } = await sb
      .from("competitor_snapshots")
      .select("week_bucket", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id);
    if (countErr) {
      res.status(500).json({
        error: { code: "snapshot_count_failed", message: countErr.message },
      });
      return;
    }
    if ((count ?? 0) > 0) {
      res.status(409).json({
        error: {
          code: "already_scanned",
          message: "A scan already exists. The weekly refresh runs automatically.",
        },
      });
      return;
    }

    const week_bucket = mondayUtc(new Date());
    const baseKey = `competitor-intel-firstscan:${auth.tenant_id}:${week_bucket}`;
    const { count: tries, error: triesErr } = await sb
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .like("cron_dedupe_key", `${baseKey}%`);
    if (triesErr) throw new Error(`attempt count failed: ${triesErr.message}`);

    if (await hasInFlightScan(sb, auth.tenant_id, { throwOnError: true })) {
      res.json({ status: "already_running" });
      return;
    }

    const { run_id } = await enqueueCompetitorScan(auth.tenant_id, {
      dedupe_key: tries ? `${baseKey}:r${tries}` : baseKey,
      trigger: "cron",
    });

    res.json(run_id ? { status: "started", run_id } : { status: "already_running" });
  } catch (e) {
    const err = e as Error;
    const name = err.name ?? "";
    if (/Credits/i.test(name)) {
      res.status(402).json({ error: refusalFor({ kind: "out_of_credits" }) });
      return;
    }
    if (/Budget|Halt/i.test(name)) {
      res.status(503).json({ error: { code: "unavailable", message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "first_scan_failed", message: err.message } });
  }
}
