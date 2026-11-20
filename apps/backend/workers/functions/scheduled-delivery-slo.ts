
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import {
  computeDeliveryReport,
  DEFAULT_DELIVERY_THRESHOLD,
  type SchedRunRow,
} from "@/services/logging/scheduled-delivery-eval";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 3 * 60 * 60 * 1000;
const SCAN_CAP = 10_000;

type SloResult = {
  window_start: string;
  window_end: string;
  scanned: number;
  global_terminal: number;
  global_delivered: number;
  global_rate: number;
  alarmed_agents: number;
  global_alarmed: boolean;
};

export async function runScheduledDeliverySlo(nowMs = Date.now()): Promise<SloResult> {
  const sb = serviceClient();
  const window_end = new Date(nowMs - SETTLE_MS).toISOString();
  const window_start = new Date(nowMs - SETTLE_MS - WINDOW_MS).toISOString();

  const { data, error } = await sb
    .from("agent_runs")
    .select("agent_slug, status")
    .eq("trigger", "cron")
    .gte("enqueued_at", window_start)
    .lt("enqueued_at", window_end)
    .limit(SCAN_CAP);

  if (error) {
    await alert({
      source: "scheduled-delivery-slo",
      code: "scan_failed",
      msg: `cron agent_runs scan failed: ${error.message}`,
    });
    return {
      window_start,
      window_end,
      scanned: 0,
      global_terminal: 0,
      global_delivered: 0,
      global_rate: 1,
      alarmed_agents: 0,
      global_alarmed: false,
    };
  }

  const rows = (data ?? []) as SchedRunRow[];
  const report = computeDeliveryReport(rows);

  for (const a of report.alarmedAgents) {
    await alert({
      source: "scheduled-delivery-slo",
      code: "scheduled_delivery_low",
      msg:
        `scheduled-delivery ${a.agent_slug} ${(a.rate * 100).toFixed(0)}% < ` +
        `${(DEFAULT_DELIVERY_THRESHOLD * 100).toFixed(0)}% over last 24h ` +
        `(delivered=${a.delivered} missed=${a.missed} terminal=${a.terminal})`,
    });
  }

  if (report.globalAlarmed) {
    await alert({
      source: "scheduled-delivery-slo",
      code: "scheduled_delivery_low_global",
      msg:
        `GLOBAL scheduled-delivery ${(report.global.rate * 100).toFixed(0)}% < ` +
        `${(DEFAULT_DELIVERY_THRESHOLD * 100).toFixed(0)}% over last 24h ` +
        `(delivered=${report.global.delivered} missed=${report.global.missed} terminal=${report.global.terminal})`,
    });
  }

  return {
    window_start,
    window_end,
    scanned: rows.length,
    global_terminal: report.global.terminal,
    global_delivered: report.global.delivered,
    global_rate: report.global.rate,
    alarmed_agents: report.alarmedAgents.length,
    global_alarmed: report.globalAlarmed,
  };
}

export const scheduledDeliverySloFn = inngest.createFunction(
  {
    id: "scheduled-delivery-slo",
    retries: 1,
    concurrency: 1,
  },
  { cron: "0 13 * * *" },
  async ({ logger }) => {
    const res = await runScheduledDeliverySlo();
    logger.info(
      `scheduled-delivery-slo: scanned=${res.scanned} global_terminal=${res.global_terminal} ` +
        `global_delivered=${res.global_delivered} global_rate=${res.global_rate.toFixed(3)} ` +
        `alarmed_agents=${res.alarmed_agents} global_alarmed=${res.global_alarmed}`,
    );
    return res;
  },
);
