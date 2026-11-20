
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { getBoolSetting } from "@/services/settings";
import { isCronStopped } from "@/services/agents/cron-stopped";
import { metaAdsCreds, fbGet, metaActionValue } from "@/services/tools/meta-ads/_client";
import { metaPixelHealthTool } from "@/services/tools/meta-ads/pixel_health";
import {
  detectAdsAnomaly,
  renderPulseIntent,
  type PulseWindowMetrics,
} from "./perfmkt-pulse-detect";

type TenantRow = { id: string };

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sevenDayWindows(): {
  current: { since: string; until: string };
  prior: { since: string; until: string };
} {
  const today = new Date();
  const d7 = new Date(today);
  d7.setUTCDate(d7.getUTCDate() - 7);
  const d14 = new Date(today);
  d14.setUTCDate(d14.getUTCDate() - 14);
  return {
    current: { since: ymd(d7), until: ymd(today) },
    prior: { since: ymd(d14), until: ymd(d7) },
  };
}

type AccountInsightRow = {
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
};

async function readAccountWindow(
  tenant_id: string,
  ad_account_id: string,
  window: { since: string; until: string },
): Promise<PulseWindowMetrics> {
  const params: Record<string, string | number | undefined> = {
    level: "account",
    time_range: JSON.stringify({ since: window.since, until: window.until }),
    time_increment: "all_days",
    fields: "spend,actions,action_values",
  };
  const j = (await fbGet(tenant_id, `${ad_account_id}/insights`, params)) as {
    data?: AccountInsightRow[];
  };
  const row = (j.data ?? [])[0] ?? {};
  const spend = Number(row.spend ?? 0);
  const purchases = metaActionValue(row.actions, "purchase");
  const checkouts = metaActionValue(row.actions, "initiate_checkout");
  const regs =
    metaActionValue(row.actions, "complete_registration") ||
    metaActionValue(row.actions, "offsite_conversion.fb_pixel_complete_registration");
  const conversions = purchases + checkouts + regs;
  const purchase_value_usd = metaActionValue(row.action_values, "purchase");
  return { spend_usd: spend, conversions, purchase_value_usd };
}

export type PulseTenantOutcome =
  | { status: "skipped"; reason: string }
  | { status: "quiet" }
  | { status: "enqueued"; run_id: string; breach_metrics: string[] };

export async function pulseOneTenant(
  tenant: TenantRow,
  deps: {
    isAutopilotOn: (tenant_id: string) => Promise<boolean>;
    isPulseEnabled: (tenant_id: string) => Promise<boolean>;
    getCreds: (tenant_id: string) => Promise<{ ad_account_id: string }>;
    readWindow: (
      tenant_id: string,
      ad_account_id: string,
      window: { since: string; until: string },
    ) => Promise<PulseWindowMetrics>;
    readPixelStatus: (
      tenant_id: string,
    ) => Promise<"healthy" | "degraded" | "web_only" | "no_pixel" | "unknown">;
    enqueue: (args: {
      tenant_id: string;
      intent: string;
      breaches: ReturnType<typeof detectAdsAnomaly>["breaches"];
    }) => Promise<{ run_id: string }>;
  },
): Promise<PulseTenantOutcome> {
  if (isCronStopped("performance-marketer")) {
    return { status: "skipped", reason: "cron_stopped" };
  }
  if (!(await deps.isAutopilotOn(tenant.id))) {
    return { status: "skipped", reason: "autopilot_off" };
  }
  if (!(await deps.isPulseEnabled(tenant.id))) {
    return { status: "skipped", reason: "pulse_disabled" };
  }
  let ad_account_id: string;
  try {
    ({ ad_account_id } = await deps.getCreds(tenant.id));
  } catch {
    return { status: "skipped", reason: "meta_not_connected" };
  }

  const { current, prior } = sevenDayWindows();
  const [currentMetrics, priorMetrics, pixelStatus] = await Promise.all([
    deps.readWindow(tenant.id, ad_account_id, current),
    deps.readWindow(tenant.id, ad_account_id, prior),
    deps.readPixelStatus(tenant.id),
  ]);

  const result = detectAdsAnomaly({
    current: currentMetrics,
    prior: priorMetrics,
    pixel_overall_status: pixelStatus,
  });

  if (!result.breached) {
    return { status: "quiet" };
  }

  const intent = renderPulseIntent(result.breaches);
  const { run_id } = await deps.enqueue({
    tenant_id: tenant.id,
    intent,
    breaches: result.breaches,
  });
  return {
    status: "enqueued",
    run_id,
    breach_metrics: result.breaches.map((b) => `${b.metric}/${b.direction}`),
  };
}

async function readPixelStatus(
  tenant_id: string,
): Promise<"healthy" | "degraded" | "web_only" | "no_pixel" | "unknown"> {
  try {
    const out = (await metaPixelHealthTool.execute(
      { tenant_id, log: () => {} },
      { lookback_days: 7 },
    )) as { overall_status?: string };
    const s = out.overall_status;
    if (s === "healthy" || s === "degraded" || s === "web_only" || s === "no_pixel") return s;
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const perfmktPulseFn = inngest.createFunction(
  { id: "perfmkt-pulse" },
  { cron: "0 7 * * *" },
  async ({ step, logger }) => {
    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      const { data, error } = await svc.from("tenants").select("id");
      if (error) throw new Error(`tenant scan failed: ${error.message}`);
      return (data ?? []) as TenantRow[];
    });

    let enqueued = 0;
    let quiet = 0;
    let skipped_autopilot_off = 0;
    let skipped_pulse_disabled = 0;
    let skipped_not_connected = 0;
    let errored = 0;
    const enqueued_runs: Array<{ tenant_id: string; run_id: string; breaches: string[] }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = await pulseOneTenant(tenant, {
          isAutopilotOn: async () => true,
          isPulseEnabled: (tid) => getBoolSetting("perfmkt_pulse_enabled", tid),
          getCreds: async (tid) => {
            const c = await metaAdsCreds(tid);
            return { ad_account_id: c.ad_account_id };
          },
          readWindow: readAccountWindow,
          readPixelStatus,
          enqueue: async ({ tenant_id, intent, breaches }) =>
            enqueueAgentRun({
              tenant_id,
              agent_slug: "performance-marketer",
              trigger: "cron",
              payload: {
                pulse_intent: intent,
                pulse_breaches: breaches,
                source: "perfmkt-pulse",
              },
            }),
        });

        switch (outcome.status) {
          case "enqueued":
            enqueued += 1;
            enqueued_runs.push({
              tenant_id: tenant.id,
              run_id: outcome.run_id,
              breaches: outcome.breach_metrics,
            });
            break;
          case "quiet":
            quiet += 1;
            break;
          case "skipped":
            if (outcome.reason === "autopilot_off") skipped_autopilot_off += 1;
            else if (outcome.reason === "pulse_disabled") skipped_pulse_disabled += 1;
            else if (outcome.reason === "meta_not_connected") skipped_not_connected += 1;
            break;
        }
      } catch (e) {
        errored += 1;
        logger.warn(`[perfmkt-pulse] tenant ${tenant.id} skipped: ${(e as Error).message}`);
      }
    }

    return {
      scanned: tenants.length,
      enqueued,
      quiet,
      skipped_autopilot_off,
      skipped_pulse_disabled,
      skipped_not_connected,
      errored,
      enqueued_runs,
    };
  },
);
