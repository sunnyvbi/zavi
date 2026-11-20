
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import { looksLikeInfraUnreachable, sanitizeErrorMessage } from "@/services/logging/sanitize";
import {
  computeDeliveryFailureReport,
  bucketKey,
  DELIVERY_FAILURE_LOG_CODES,
  DEFAULT_STALE_PENDING_MS,
  type OutboxRow,
  type StaleRow,
  type FailureLogRow,
} from "@/services/logging/slack-delivery-eval";

const WINDOW_MS = 15 * 60 * 1000;
const REPAGE_BUCKET_MS = 60 * 60 * 1000;
const SCAN_CAP = 5_000;

export type DeliveryCanaryResult = {
  window_start: string;
  outbox_scanned: number;
  failure_logs_scanned: number;
  global_terminal: number;
  global_failed: number;
  global_rate: number;
  alarmed_tenants: number;
  global_alarmed: boolean;
  spike_alarmed: boolean;
  stale_pending: number;
  stale_alarmed: boolean;
  paged: number;
};

export async function runSlackDeliveryFailureCanary(
  nowMs = Date.now(),
): Promise<DeliveryCanaryResult> {
  const sb = serviceClient();
  const window_start = new Date(nowMs - WINDOW_MS).toISOString();
  const stale_cutoff = new Date(nowMs - DEFAULT_STALE_PENDING_MS).toISOString();

  const { data: terminalData, error: terminalErr } = await sb
    .from("slack_outbox")
    .select("tenant_id, status")
    .in("status", ["sent", "failed"])
    .gte("enqueued_at", window_start)
    .limit(SCAN_CAP);

  const { data: staleData, error: staleErr } = await sb
    .from("slack_outbox")
    .select("tenant_id")
    .in("status", ["pending", "sending"])
    .lt("enqueued_at", stale_cutoff)
    .limit(SCAN_CAP);

  const { data: logData, error: logErr } = await sb
    .from("praxis_logs")
    .select("tenant_id")
    .in("code", [...DELIVERY_FAILURE_LOG_CODES])
    .gte("created_at", window_start)
    .limit(SCAN_CAP);

  const outboxErr = terminalErr ?? staleErr;

  if (outboxErr || logErr) {
    const err = outboxErr ?? logErr;
    const dbDown = looksLikeInfraUnreachable(err);
    const detail = sanitizeErrorMessage(err?.message ?? "unknown");
    await alert({
      source: "slack-delivery-failure-canary",
      code: dbDown ? "db_unreachable" : "scan_failed",
      msg: dbDown
        ? `DATA LAYER UNREACHABLE from this scan: ${detail}. The canary could not read delivery state, and the error signature is a transport/gateway failure rather than a query fault — so this most likely is NOT a Slack problem. Check the Supabase project (compute health / Disk IO budget) BEFORE investigating Slack tokens or channels. NOTE: this one failed scan does not by itself prove the whole database is down; confirm with /health and the Supabase dashboard.`
        : `delivery scan FAILED: ${detail}. The delivery canary is BLIND — it cannot confirm Slack delivery is healthy.`,
      email: {
        dedupeKey: `slack_delivery:${dbDown ? "db_unreachable" : "scan_failed"}:${bucketKey(nowMs, REPAGE_BUCKET_MS)}`,
      },
    });
    return {
      window_start,
      outbox_scanned: 0,
      failure_logs_scanned: 0,
      global_terminal: 0,
      global_failed: 0,
      global_rate: 0,
      alarmed_tenants: 0,
      global_alarmed: false,
      spike_alarmed: false,
      stale_pending: 0,
      stale_alarmed: false,
      paged: 1,
    };
  }

  const terminalRows = (terminalData ?? []) as OutboxRow[];
  const staleRows = (staleData ?? []) as StaleRow[];
  const failureLogRows = (logData ?? []) as FailureLogRow[];

  const report = computeDeliveryFailureReport({
    terminal: terminalRows,
    stale: staleRows,
    replyFailures: failureLogRows,
  });

  const repage = bucketKey(nowMs, REPAGE_BUCKET_MS);
  let paged = 0;

  const fleetWide = report.globalAlarmed || report.spikeAlarmed || report.staleAlarmed;

  if (fleetWide) {
    const reasons: string[] = [];
    if (report.spikeAlarmed || report.globalAlarmed) {
      reasons.push(
        `${report.global.failed} failed of ${report.global.terminal} terminal deliveries` +
          (report.global.terminal > 0 ? ` (${(report.global.rate * 100).toFixed(0)}%)` : ""),
      );
    }
    if (report.staleAlarmed) {
      reasons.push(
        `${report.stalePending} message(s) stuck UNDELIVERED for >${
          DEFAULT_STALE_PENDING_MS / 60000
        }min (the outbox drainer may be dead — nothing is terminalizing)`,
      );
    }
    await alert({
      source: "slack-delivery-failure-canary",
      code: "slack_delivery_failed_global",
      msg:
        `GLOBAL Slack delivery FAILING: ${reasons.join("; ")}. ` +
        `Tenants affected: ${report.affectedTenants}. ` +
        `Agent asks/approvals are NOT reaching customers.`,
      email: { dedupeKey: `slack_delivery:global:${repage}` },
    });
    paged++;
  } else {
    for (const t of report.alarmedTenants) {
      await alert({
        source: "slack-delivery-failure-canary",
        code: "slack_delivery_failed_tenant",
        tenant_id: t.tenant_id,
        msg:
          `Slack delivery FAILING for tenant ${t.tenant_id}: ` +
          `${t.failed} failed` +
          (t.terminal > 0
            ? ` of ${t.terminal} terminal (${(t.rate * 100).toFixed(0)}%)`
            : ` (reply-path only — no delivery succeeded to compare against)`) +
          ` in the last 15min. Agent messages are not reaching this customer.`,
        email: { dedupeKey: `slack_delivery:tenant:${t.tenant_id}:${repage}` },
      });
      paged++;
    }
  }

  return {
    window_start,
    outbox_scanned: terminalRows.length,
    failure_logs_scanned: failureLogRows.length,
    global_terminal: report.global.terminal,
    global_failed: report.global.failed,
    global_rate: report.global.rate,
    alarmed_tenants: fleetWide ? 0 : report.alarmedTenants.length,
    global_alarmed: report.globalAlarmed,
    spike_alarmed: report.spikeAlarmed,
    stale_pending: report.stalePending,
    stale_alarmed: report.staleAlarmed,
    paged,
  };
}

export const slackDeliveryFailureCanaryFn = inngest.createFunction(
  {
    id: "slack-delivery-failure-canary",
    name: "Slack delivery-failure canary — 5min",
    retries: 1,
    concurrency: 1,
  },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const r = await runSlackDeliveryFailureCanary();
    logger.info(
      `slack-delivery-failure-canary: outbox=${r.outbox_scanned} logs=${r.failure_logs_scanned} ` +
        `failed=${r.global_failed}/${r.global_terminal} rate=${r.global_rate.toFixed(3)} ` +
        `stale=${r.stale_pending} alarmed_tenants=${r.alarmed_tenants} ` +
        `global=${r.global_alarmed} spike=${r.spike_alarmed} stale_alarmed=${r.stale_alarmed} ` +
        `paged=${r.paged}`,
    );
    return r;
  },
);
