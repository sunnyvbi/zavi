
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

const MAX_TENANTS_PER_SWEEP = 200;

const MIN_LIVE_AGE_MS = 24 * 60 * 60 * 1000;

const REFINE_SUGGESTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

const MIN_LIVE_BODY_BYTES = 1024;

const ELIGIBLE_CONDUCTOR_KIND = "build_app";

type TenantRow = { id: string };

type EligibleConductorRow = {
  id: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
};

type HostingRow = {
  external_ref: Record<string, unknown> | null;
  status: string;
};

type ExistingSuggestionRow = {
  status: string;
  created_at: string;
};

export function buildCannedSuggestion(args: {
  live_days: number;
}): string {
  const raw = Number.isFinite(args.live_days) ? Math.floor(args.live_days) : 1;
  const days = raw >= 1 ? raw : 1;
  if (days === 1) {
    return "Your app has been live for 1 day. Want to polish the hero copy and tighten the call-to-action?";
  }
  return `Your app has been live for ${days} days. Want to polish the hero copy and tighten the call-to-action?`;
}

export function shouldSkipDueToExisting(args: {
  rows: ExistingSuggestionRow[];
  now: Date;
  cooldown_ms: number;
}): boolean {
  for (const r of args.rows) {
    if (r.status === "pending") return true;
    if (r.status === "accepted") {
      return true;
    }
    if (r.status === "dismissed") {
      const age = args.now.getTime() - new Date(r.created_at).getTime();
      if (age < args.cooldown_ms) return true;
    }
  }
  return false;
}

export function pickHostingUrl(rows: HostingRow[]): string | null {
  const hosting = rows.find(
    (r) =>
      r.status === "ready" &&
      typeof (r.external_ref as { url?: string } | null)?.url === "string",
  );
  if (!hosting) return null;
  const url = (hosting.external_ref as { url: string }).url;
  return url.length > 0 ? url : null;
}

async function probeLiveContent(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (res.status < 200 || res.status >= 300) return false;
    const reader = res.body?.getReader();
    if (!reader) {
      const cl = Number(res.headers.get("content-length") ?? "0");
      return cl === 0 || cl >= MIN_LIVE_BODY_BYTES;
    }
    let bytes = 0;
    while (bytes < MIN_LIVE_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
    }
    try {
      await reader.cancel();
    } catch {
    }
    return bytes >= MIN_LIVE_BODY_BYTES;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type ScanDeps = {
  isAutopilotEnabled: (tenant_id: string) => Promise<boolean>;
  loadEligibleConductorRun: (
    tenant_id: string,
    minLiveCutoffIso: string,
  ) => Promise<EligibleConductorRow | null>;
  loadHostingRows: (tenant_id: string) => Promise<HostingRow[]>;
  loadExistingSuggestions: (
    tenant_id: string,
    conductor_run_id: string,
  ) => Promise<ExistingSuggestionRow[]>;
  probeLiveness: (url: string) => Promise<boolean>;
  insertSuggestion: (row: {
    tenant_id: string;
    conductor_run_id: string;
    suggestion: string;
    evidence: Record<string, unknown>;
  }) => Promise<string>;
};

type ScanOutcome =
  | { status: "skipped_autopilot_disabled" }
  | { status: "skipped_no_eligible_run" }
  | { status: "skipped_no_live_url" }
  | { status: "skipped_not_live" }
  | { status: "skipped_cooldown" }
  | { status: "suggested"; suggestion_id: string; conductor_run_id: string }
  | { status: "error"; reason: string };

export async function scanOneTenant(
  tenant_id: string,
  now: Date,
  deps: ScanDeps,
): Promise<ScanOutcome> {
  const enabled = await deps.isAutopilotEnabled(tenant_id);
  if (!enabled) {
    return { status: "skipped_autopilot_disabled" };
  }

  const minLiveCutoff = new Date(now.getTime() - MIN_LIVE_AGE_MS).toISOString();
  let eligible: EligibleConductorRow | null;
  try {
    eligible = await deps.loadEligibleConductorRun(tenant_id, minLiveCutoff);
  } catch (e) {
    return {
      status: "error",
      reason: `conductor_runs read failed: ${(e as Error).message}`,
    };
  }
  if (!eligible) {
    return { status: "skipped_no_eligible_run" };
  }

  let hostingRows: HostingRow[];
  try {
    hostingRows = await deps.loadHostingRows(tenant_id);
  } catch (e) {
    return {
      status: "error",
      reason: `tenant_resources read failed: ${(e as Error).message}`,
    };
  }
  const liveUrl = pickHostingUrl(hostingRows);
  if (!liveUrl) {
    return { status: "skipped_no_live_url" };
  }

  let existing: ExistingSuggestionRow[];
  try {
    existing = await deps.loadExistingSuggestions(tenant_id, eligible.id);
  } catch (e) {
    return {
      status: "error",
      reason: `refine_suggestions probe failed: ${(e as Error).message}`,
    };
  }
  if (
    shouldSkipDueToExisting({
      rows: existing,
      now,
      cooldown_ms: REFINE_SUGGESTION_COOLDOWN_MS,
    })
  ) {
    return { status: "skipped_cooldown" };
  }

  const live = await deps.probeLiveness(liveUrl);
  if (!live) {
    return { status: "skipped_not_live" };
  }

  const liveAgeMs = now.getTime() - new Date(eligible.updated_at).getTime();
  const live_days = Math.max(1, Math.floor(liveAgeMs / (24 * 60 * 60 * 1000)));
  const suggestion = buildCannedSuggestion({ live_days });
  const evidence = {
    kind: "canned_weekly_v1",
    live_days,
    hosting_url: liveUrl,
    eligible_conductor_run_id: eligible.id,
    triggered_at: now.toISOString(),
  };

  let suggestion_id: string;
  try {
    suggestion_id = await deps.insertSuggestion({
      tenant_id,
      conductor_run_id: eligible.id,
      suggestion,
      evidence,
    });
  } catch (e) {
    return {
      status: "error",
      reason: `refine_suggestions insert failed: ${(e as Error).message}`,
    };
  }

  return {
    status: "suggested",
    suggestion_id,
    conductor_run_id: eligible.id,
  };
}

export function realScanDeps(): ScanDeps {
  return {
    isAutopilotEnabled: async () => true,
    async loadEligibleConductorRun(tenant_id, minLiveCutoffIso) {
      const { data, error } = await serviceClient()
        .from("conductor_runs")
        .select("id, tenant_id, created_at, updated_at")
        .eq("tenant_id", tenant_id)
        .eq("status", "done")
        .eq("kind", ELIGIBLE_CONDUCTOR_KIND)
        .lte("updated_at", minLiveCutoffIso)
        .is("goal_graph->0->payload->>site_id", null)
        .is("goal_graph->1->payload->>site_id", null)
        .is("goal_graph->2->payload->>site_id", null)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = ((data ?? []) as EligibleConductorRow[])[0];
      return row ?? null;
    },
    async loadHostingRows(tenant_id) {
      const { data, error } = await serviceClient()
        .from("tenant_resources")
        .select("external_ref, status")
        .eq("tenant_id", tenant_id)
        .eq("resource_kind", "hosting");
      if (error) throw new Error(error.message);
      return (data ?? []) as HostingRow[];
    },
    async loadExistingSuggestions(tenant_id, conductor_run_id) {
      const { data, error } = await serviceClient()
        .from("refine_suggestions")
        .select("status, created_at")
        .eq("tenant_id", tenant_id)
        .eq("conductor_run_id", conductor_run_id);
      if (error) throw new Error(error.message);
      return (data ?? []) as ExistingSuggestionRow[];
    },
    probeLiveness: (url) => probeLiveContent(url),
    async insertSuggestion(row) {
      const { data, error } = await serviceClient()
        .from("refine_suggestions")
        .insert({
          tenant_id: row.tenant_id,
          conductor_run_id: row.conductor_run_id,
          suggestion: row.suggestion,
          evidence: row.evidence,
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "no row");
      return (data as { id: string }).id;
    },
  };
}

export const refineSuggestionScanFn = inngest.createFunction(
  { id: "refine-suggestion-scan", concurrency: 1 },
  { cron: "0 10 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("refine-suggestion-scan")) {
      logger.info("refine-suggestion-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const svc = serviceClient();

    const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
    if (killErr) {
      logger.error(
        `refine-suggestion-scan: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`,
      );
      return { skipped: true, reason: "fleet_kill_check_failed" };
    }
    if (halted === true) {
      return { skipped: true, reason: "fleet_halted" };
    }

    const { data, error } = await svc
      .from("tenants")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(MAX_TENANTS_PER_SWEEP);
    if (error) {
      logger.error(`refine-suggestion-scan: tenant scan failed: ${error.message}`);
      return { suggested: 0, error: error.message };
    }
    const tenants = (data ?? []) as TenantRow[];

    const now = new Date();
    const deps = realScanDeps();

    let suggested = 0;
    let skipped_disabled = 0;
    let skipped_no_run = 0;
    let skipped_no_url = 0;
    let skipped_not_live = 0;
    let skipped_cooldown = 0;
    let errored = 0;
    const suggested_rows: Array<{
      tenant_id: string;
      suggestion_id: string;
      conductor_run_id: string;
    }> = [];

    for (const t of tenants) {
      try {
        const outcome = await scanOneTenant(t.id, now, deps);
        switch (outcome.status) {
          case "suggested":
            suggested += 1;
            suggested_rows.push({
              tenant_id: t.id,
              suggestion_id: outcome.suggestion_id,
              conductor_run_id: outcome.conductor_run_id,
            });
            break;
          case "skipped_autopilot_disabled":
            skipped_disabled += 1;
            break;
          case "skipped_no_eligible_run":
            skipped_no_run += 1;
            break;
          case "skipped_no_live_url":
            skipped_no_url += 1;
            break;
          case "skipped_not_live":
            skipped_not_live += 1;
            break;
          case "skipped_cooldown":
            skipped_cooldown += 1;
            break;
          case "error":
            errored += 1;
            logger.warn(
              `[refine-suggestion-scan] tenant ${t.id} errored: ${outcome.reason}`,
            );
            break;
        }
      } catch (e) {
        errored += 1;
        logger.warn(
          `[refine-suggestion-scan] tenant ${t.id} threw: ${(e as Error).message}`,
        );
      }
    }

    return {
      scanned: tenants.length,
      suggested,
      skipped_autopilot_disabled: skipped_disabled,
      skipped_no_eligible_run: skipped_no_run,
      skipped_no_live_url: skipped_no_url,
      skipped_not_live,
      skipped_cooldown,
      errored,
      suggested_rows,
    };
  },
);
