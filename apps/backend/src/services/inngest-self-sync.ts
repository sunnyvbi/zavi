
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { resolveIssuerUrl } from "@/services/config/env-targets";

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;
type LogFn = typeof logEvent;

export interface SelfSyncDeps {
  fetchFn?: FetchFn;
  sleepFn?: SleepFn;
  logFn?: LogFn;
  signingKey?: string | undefined;
  syncUrl?: string | undefined;
}

export interface SelfSyncResult {
  ok: boolean;
  attempts: number;
  skipped?: boolean;
}

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export async function selfSyncInngestOnBoot(
  port: number,
  deps: SelfSyncDeps = {},
): Promise<SelfSyncResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  const logFn = deps.logFn ?? pageSelfSyncFailure;
  const signingKey =
    deps.signingKey !== undefined ? deps.signingKey : process.env.INNGEST_SIGNING_KEY;

  if (!signingKey) {
    return { ok: true, attempts: 0, skipped: true };
  }

  const url = deps.syncUrl ?? resolveSelfSyncUrl(port);

  const settleMs = parseInt(process.env.INNGEST_SELF_SYNC_SETTLE_MS || "15000", 10);
  const gapMs = parseInt(process.env.INNGEST_SELF_SYNC_GAP_MS || "5000", 10);
  const maxAttempts = 4;

  await sleepFn(settleMs);

  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url, { method: "PUT" });
      if (res.ok) {
        await sleepFn(gapMs);
        try {
          await fetchFn(url, { method: "PUT" });
        } catch {
        }
        return { ok: true, attempts: attempt };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < maxAttempts) await sleepFn(attempt * gapMs);
  }

  await logFn({
    level: "error",
    source: "inngest-self-sync",
    code: "inngest.self_sync.failed",
    message: `boot self-sync of /api/inngest FAILED after ${maxAttempts} attempts (${lastErr}) — Inngest may not route Slack/cron events; recover with: curl -X PUT ${url}`,
  });
  return { ok: false, attempts: maxAttempts };
}

const pageSelfSyncFailure: LogFn = async (entry) => {
  const url = process.env.INNGEST_SELF_SYNC_URL || "this host";
  await alert({
    source: entry.source,
    code: entry.code,
    msg: entry.message ?? "boot self-sync of /api/inngest failed",
    email: {
      dedupeKey: `inngest-self-sync:${url}:${Math.floor(Date.now() / 3_600_000)}`,
      subjectDetail: "jobs may not run: boot self-sync failed",
      detail:
        "Check the Inngest dashboard (Apps -> praxis) app URL first. It should be " +
        "https://jobs.zaviagent.com/api/inngest. Only if it is wrong, re-sync once on purpose.",
    },
  });
};

function resolveSelfSyncUrl(port: number): string {
  if (process.env.INNGEST_SELF_SYNC_URL) {
    return process.env.INNGEST_SELF_SYNC_URL;
  }

  if (process.env.NODE_ENV === "production") {
    const origin = resolveIssuerUrl().replace(/\/+$/, "");
    return `${origin}/api/inngest`;
  }

  return `http://localhost:${port}/api/inngest`;
}
