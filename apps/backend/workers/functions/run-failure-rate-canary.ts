
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import {
  computeFailureRateReport,
  DEFAULT_RATE_THRESHOLD,
  type RunRow,
} from "@/services/logging/failure-rate-eval";

const WINDOW_MS = 60 * 60 * 1000;
const SCAN_CAP = 5_000;

type ScanResult = {
  window_start: string;
  scanned: number;
  global_terminal: number;
  global_failed: number;
  global_rate: number;
  alarmed_tenants: number;
  global_alarmed: boolean;
};

export async function runFailureRateCanary(nowMs = Date.now()): Promise<ScanResult> {
  const sb = serviceClient();
  const window_start = new Date(nowMs - WINDOW_MS).toISOString();

  const { data, error } = await sb
    .from("agent_runs")
    .select("tenant_id, status")
    .gte("enqueued_at", window_start)
    .limit(SCAN_CAP);

  if (error) {
    await alert({
      source: "run-failure-rate-canary",
      code: "scan_failed",
      msg: `agent_runs scan failed: ${error.message}`,
    });
    return {
      window_start,
      scanned: 0,
      global_terminal: 0,
      global_failed: 0,
      global_rate: 0,
      alarmed_tenants: 0,
      global_alarmed: false,
    };
  }

  const rows = (data ?? []) as RunRow[];
  const report = computeFailureRateReport(rows);

  for (const t of report.alarmedTenants) {
    await alert({
      source: "run-failure-rate-canary",
      code: "run_failure_rate",
      tenant_id: t.tenant_id,
      msg:
        `run failure rate ${(t.rate * 100).toFixed(0)}% >= ${(DEFAULT_RATE_THRESHOLD * 100).toFixed(0)}% ` +
        `over last 1h (failed=${t.failed} parse_failed=${t.parse_failed} terminal=${t.terminal})`,
    });
  }

  if (report.globalAlarmed) {
    await alert({
      source: "run-failure-rate-canary",
      code: "run_failure_rate_global",
      msg:
        `GLOBAL run failure rate ${(report.global.rate * 100).toFixed(0)}% >= ${(DEFAULT_RATE_THRESHOLD * 100).toFixed(0)}% ` +
        `over last 1h (failed=${report.global.failed} parse_failed=${report.global.parse_failed} terminal=${report.global.terminal})`,
    });
  }

  return {
    window_start,
    scanned: rows.length,
    global_terminal: report.global.terminal,
    global_failed: report.global.failed,
    global_rate: report.global.rate,
    alarmed_tenants: report.alarmedTenants.length,
    global_alarmed: report.globalAlarmed,
  };
}

export const runFailureRateCanaryFn = inngest.createFunction(
  {
    id: "run-failure-rate-canary",
    retries: 1,
    concurrency: 1,
  },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const res = await runFailureRateCanary();
    logger.info(
      `run-failure-rate-canary: scanned=${res.scanned} global_terminal=${res.global_terminal} ` +
        `global_failed=${res.global_failed} global_rate=${res.global_rate.toFixed(3)} ` +
        `alarmed_tenants=${res.alarmed_tenants} global_alarmed=${res.global_alarmed}`,
    );
    return res;
  },
);
