
import { EmailToolError, EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, type CampaignResults, type EmailTool, type ProviderCall } from "@/services/connectors/email-campaign/providers";
import { sameDigest } from "@/services/connectors/email-campaign/credential";
import type { GaRunReportBody, GaRunReportResponse, GoogleAnalyticsCreds } from "@/services/tools/google-analytics/_client";
import { TIMEZONE_PROBE, validTimeZone, visitorsFrom, visitorsReportBody } from "./ga";
import type { StartInput, StartOutcome } from "./start";

export type ClaimedTask = {
  task_id: string;
  lease_token: string;
  tenant_id: string;
  source: "provider" | "ga";
  stage: "h1" | "d7";
  state: "pending" | "waiting";
  attempts: number;
  group_key: string;
  give_up_at: string;
  result_id: string;
  rail: "channel_actions" | "decisions";
  card_id: string;
  route: EmailTool | "zavi_list";
  provider_ref: string;
  account_ref: Record<string, unknown> | null;
  campaign_title: string | null;
  campaign_slug: string | null;
  started_at: string;
  finished_at: string;
  ga_property_id: string | null;
  ga_timezone: string | null;
};

export type Completion = {
  outcome: "done" | "retry" | "rate_limited" | "waiting" | "gave_up" | "disconnected";
  result?: Record<string, unknown>;
  next_due?: Date;
  error?: string;
  ga?: { property_id: string; timezone: string | null };
  note?: string;
};

export type ProviderAccess =
  | { kind: "none" }
  | { kind: "ok"; call: ProviderCall; sameCredential: boolean; cacheKey: string };

export type BulkCounts = {
  sent: number;
  delivered: number;
  opens: number;
  machine_opens: number;
  unsubscribes: number;
  hard_bounces?: number;
  delivered_seen_at: string | null;
};

export type CheckDeps = {
  claim: (limit: number, leaseSeconds: number) => Promise<ClaimedTask[]>;
  complete: (t: ClaimedTask, c: Completion) => Promise<void>;
  providerAccess: (tenantId: string, route: EmailTool, accountRef: Record<string, unknown> | null) => Promise<ProviderAccess>;
  bulkCounts: (tenantId: string, sendId: string) => Promise<BulkCounts | null>;
  gaCreds: (tenantId: string) => Promise<GoogleAnalyticsCreds | null>;
  gaReport: (creds: GoogleAnalyticsCreds, body: GaRunReportBody) => Promise<GaRunReportResponse>;
  missing: (since: Date, limit: number) => Promise<Array<{ tenant_id: string; rail: "channel_actions" | "decisions"; card_id: string; sent: number | null }>>;
  start: (input: StartInput) => Promise<StartOutcome>;
  holdRepair: (m: { tenant_id: string; rail: "channel_actions" | "decisions"; card_id: string }, reason: string) => Promise<void>;
  backlog: (stuckAfterHours: number) => Promise<{ due: number; oldest_due_at: string | null; newly_stuck: Array<{ tenant_id: string; source: string; stage: string; last_error: string | null }> }>;
  purgeEventIds: (batch: number) => Promise<number>;
  alertStuck: (t: { tenant_id: string; source: string; stage: string; last_error: string | null }) => Promise<void>;
  log: (level: "info" | "warn" | "error", code: string, message: string, tenantId?: string | null, meta?: Record<string, string | number>) => Promise<void>;
  now: () => Date;
};

export const PASS = {
  limit: 100,
  leaseSeconds: 600,
  budgetMs: 7 * 60_000,
  parallelGroups: 4,
  maxPerGroup: 15,
  repairBudgetMs: 90_000,
  repairSinceDays: 14,
  repairLimit: 100,
  stuckAfterHours: 72,
  purgeBatch: 5_000,
  gaWaitMs: 24 * 3_600_000,
  defaultRateWaitS: 120,
} as const;

export function backoffMs(attempts: number): number {
  const ladder = [10, 30, 120, 360, 720];
  return ladder[Math.min(Math.max(attempts, 0), ladder.length - 1)] * 60_000;
}

function errText(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[an email address]").slice(0, 280);
}

function rateLimitWaitS(e: unknown): number | null {
  if (e instanceof EmailToolError && e.status === 429) return e.retry_after_s ?? PASS.defaultRateWaitS;
  const m = /returned (\d{3})/.exec((e as Error)?.message ?? "");
  if (m && m[1] === "429") return PASS.defaultRateWaitS;
  return null;
}

function failure(t: ClaimedTask, e: unknown, now: Date): Completion {
  const wait = rateLimitWaitS(e);
  if (wait !== null) return { outcome: "rate_limited", next_due: new Date(now.getTime() + wait * 1000), error: errText(e) };
  return { outcome: "retry", next_due: new Date(now.getTime() + backoffMs(t.attempts)), error: errText(e) };
}

function providerNumbers(r: CampaignResults): Record<string, unknown> {
  return {
    recipients: r.recipients,
    delivered: r.delivered,
    bounces: r.bounces,
    opens: r.opens,
    clicks: r.clicks,
    unsubscribes: r.unsubscribes,
    ...(r.received === undefined ? {} : { received: r.received }),
    ...(r.skipped === undefined ? {} : { skipped: r.skipped }),
  };
}

function noNumbersYet(r: CampaignResults): boolean {
  return [r.recipients, r.delivered, r.bounces, r.opens, r.clicks, r.unsubscribes, r.received ?? null, r.skipped ?? null].every((n) => n === null || n === 0);
}

function awaitingReport(r: CampaignResults): boolean {
  if (r.received === undefined && r.skipped === undefined) return false;
  const reported = [r.recipients, r.delivered, r.opens, r.clicks, r.unsubscribes].some((n) => n !== null);
  const skippedEveryone = r.received === 0 && (r.skipped ?? 0) > 0;
  return !reported && !skippedEveryone;
}

export function bulkNumbers(c: BulkCounts): Record<string, unknown> {
  const seen = c.delivered_seen_at !== null;
  return {
    recipients: c.sent,
    delivered: seen ? c.delivered : null,
    opens: seen ? c.opens : null,
    machine_opens: seen ? c.machine_opens : null,
    clicks: null,
    clicks_off: true,
    bounces: typeof c.hard_bounces === "number" ? c.hard_bounces : null,
    unsubscribes: c.unsubscribes,
  };
}

function stoppedAt(t: ClaimedTask): string {
  return t.stage === "h1" ? "before the 1-hour check" : "at 1 hour";
}

const release = (t: ClaimedTask, deps: CheckDeps) => deps.complete(t, { outcome: "rate_limited", next_due: deps.now() }).catch(() => undefined);

async function runProviderGroup(tasks: ClaimedTask[], deps: CheckDeps, late: () => boolean = () => false): Promise<void> {
  const now = deps.now();
  const first = tasks[0];
  if (first.route === "zavi_list") {
    for (const t of tasks) {
      if (late()) {
        await release(t, deps);
        continue;
      }
      try {
        const c = await deps.bulkCounts(t.tenant_id, t.provider_ref);
        await deps.complete(t, c ? { outcome: "done", result: bulkNumbers(c) } : { outcome: "gave_up", error: "send not found", note: "This send is no longer in Zavi." });
      } catch (e) {
        await deps.complete(t, failure(t, e, now));
      }
    }
    return;
  }
  const route = first.route;
  const label = EMAIL_TOOL_LABEL[route];
  const accessByAccountRef = new Map<string, ProviderAccess>();
  const accessFor = async (t: ClaimedTask): Promise<ProviderAccess> => {
    const key = JSON.stringify([t.tenant_id, t.account_ref ?? null]);
    const hit = accessByAccountRef.get(key);
    if (hit) return hit;
    const a = await deps.providerAccess(t.tenant_id, route, t.account_ref);
    accessByAccountRef.set(key, a);
    return a;
  };

  const ready: Array<{ t: ClaimedTask; call: ProviderCall; cacheKey: string }> = [];
  for (const t of tasks) {
    if (late()) {
      await release(t, deps);
      continue;
    }
    try {
      const access = await accessFor(t);
      if (access.kind === "none") {
        await deps.complete(t, { outcome: "disconnected", error: "not connected", note: `${label} was disconnected; numbers stopped ${stoppedAt(t)}.` });
        continue;
      }
      if (!access.sameCredential) {
        const c = await EMAIL_PROVIDERS[route].getCampaign(access.call, t.provider_ref);
        if (!c || (t.campaign_title && c.title !== t.campaign_title)) {
          await deps.complete(t, { outcome: "disconnected", error: "different account", note: `${label} is connected to a different account now; numbers stopped ${stoppedAt(t)}.` });
          continue;
        }
      }
      ready.push({ t, call: access.call, cacheKey: access.cacheKey });
    } catch (e) {
      await deps.complete(t, failure(t, e, now));
    }
  }
  if (ready.length === 0) return;

  const provider = EMAIL_PROVIDERS[route];
  if (provider.resultsMany) {
    if (late()) {
      for (const r of ready) await release(r.t, deps);
      return;
    }
    const { call, cacheKey } = ready[0];
    let many: Map<string, CampaignResults>;
    try {
      many = await provider.resultsMany(call, ready.map((r) => r.t.provider_ref), cacheKey);
    } catch (e) {
      for (const r of ready) await deps.complete(r.t, failure(r.t, e, now));
      return;
    }
    for (const r of ready) {
      const res = many.get(r.t.provider_ref);
      const noNumbers = failure(r.t, new Error(`${label} reported no numbers for this campaign yet`), now);
      if (!res) await deps.complete(r.t, noNumbers);
      else await deps.complete(r.t, awaitingReport(res) ? { ...noNumbers, result: providerNumbers(res) } : { outcome: "done", result: providerNumbers(res) });
    }
    return;
  }
  for (const r of ready) {
    if (late()) {
      await release(r.t, deps);
      continue;
    }
    try {
      const res = await provider.results(r.call, r.t.provider_ref);
      await deps.complete(r.t, noNumbersYet(res) ? { ...failure(r.t, new Error(`${label} reported no numbers for this campaign yet`), now), result: { reported_empty: true } } : { outcome: "done", result: providerNumbers(res) });
    } catch (e) {
      if (e instanceof EmailToolError && e.status === 404) {
        await deps.complete(r.t, { outcome: "gave_up", error: "campaign not found", note: `This email is no longer in ${label}; numbers stopped ${stoppedAt(r.t)}.` });
      } else {
        await deps.complete(r.t, failure(r.t, e, now));
      }
    }
  }
}

async function runGaGroup(tasks: ClaimedTask[], deps: CheckDeps, late: () => boolean = () => false): Promise<void> {
  const now = deps.now();
  let creds: GoogleAnalyticsCreds | null;
  try {
    creds = await deps.gaCreds(tasks[0].tenant_id);
  } catch (e) {
    for (const t of tasks) await deps.complete(t, failure(t, e, now));
    return;
  }
  if (!creds) {
    for (const t of tasks) {
      await deps.complete(t, { outcome: "waiting", result: { visitors: null, ga_status: "not_connected" }, next_due: new Date(now.getTime() + PASS.gaWaitMs) });
    }
    return;
  }
  let probedZone: string | null | undefined;
  for (const t of tasks) {
    if (late()) {
      await release(t, deps);
      continue;
    }
    try {
      if (t.ga_property_id && t.ga_property_id !== creds.property_id) {
        await deps.complete(t, { outcome: "done", result: {}, ga: { property_id: creds.property_id, timezone: null } });
        continue;
      }
      let zone = validTimeZone(t.ga_timezone) ? t.ga_timezone : null;
      if (!zone) {
        if (probedZone === undefined) probedZone = (await deps.gaReport(creds, TIMEZONE_PROBE)).metadata?.timeZone ?? null;
        zone = validTimeZone(probedZone) ? probedZone : "UTC";
      }
      if (!t.campaign_slug) {
        await deps.complete(t, { outcome: "gave_up", result: { visitors: null, ga_status: "not_tagged" } });
        continue;
      }
      const body = visitorsReportBody({ slug: t.campaign_slug, startedAt: new Date(t.started_at), finishedAt: new Date(t.finished_at), timeZone: zone });
      const visitors = visitorsFrom(await deps.gaReport(creds, body));
      await deps.complete(t, { outcome: "done", result: { visitors, ga_status: "ok" }, ga: { property_id: creds.property_id, timezone: zone } });
    } catch (e) {
      await deps.complete(t, failure(t, e, now));
    }
  }
}

async function pool<T>(items: T[], n: number, deadline: number, now: () => number, run: (x: T) => Promise<void>, skipped: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const x = items[i++];
      if (now() > deadline) await skipped(x);
      else await run(x);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export type PassReport = {
  claimed: number;
  groups: number;
  repaired: number;
  purged: number;
  backlog_due: number;
  oldest_due_age_min: number | null;
  stuck_alerted: number;
};

export async function runEmailResultsPass(deps: CheckDeps): Promise<PassReport> {
  const started = deps.now().getTime();
  const deadline = started + PASS.budgetMs;
  const clock = () => deps.now().getTime();

  let purged = 0;
  try {
    purged = await deps.purgeEventIds(PASS.purgeBatch);
  } catch (e) {
    await deps.log("warn", "email_results.purge_failed", errText(e));
  }

  let repaired = 0;
  try {
    const since = new Date(started - PASS.repairSinceDays * 86_400_000);
    for (const m of await deps.missing(since, PASS.repairLimit)) {
      if (clock() - started > PASS.repairBudgetMs) break;
      const hold = (reason: string) =>
        deps.holdRepair(m, reason).catch((e) => deps.log("warn", "email_results.repair_hold_failed", errText(e), m.tenant_id, { stage: m.rail }));
      try {
        const out = await deps.start({ tenant_id: m.tenant_id, rail: m.rail, card_id: m.card_id, sent: m.sent });
        if (out.started) {
          repaired++;
          await deps.log("warn", "email_results.repaired", "results row started by the repair sweep", m.tenant_id, { stage: m.rail });
        } else if (out.reason) {
          await hold(out.reason);
        }
      } catch (e) {
        await deps.log("error", "email_results.repair_failed", errText(e), m.tenant_id, { stage: m.rail });
        await hold(errText(e));
      }
    }
  } catch (e) {
    await deps.log("error", "email_results.repair_scan_failed", errText(e));
  }

  const tasks = await deps.claim(PASS.limit, PASS.leaseSeconds);
  const groups = new Map<string, ClaimedTask[]>();
  for (const t of tasks) {
    const key = `${t.source}|${t.tenant_id}|${t.group_key}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const list: ClaimedTask[][] = [];
  for (const g of groups.values()) {
    list.push(g.slice(0, PASS.maxPerGroup));
    for (const t of g.slice(PASS.maxPerGroup)) await release(t, deps);
  }
  const late = () => clock() > deadline;
  await pool(
    list,
    PASS.parallelGroups,
    deadline,
    clock,
    async (g) => {
      try {
        await (g[0].source === "ga" ? runGaGroup(g, deps, late) : runProviderGroup(g, deps, late));
      } catch (e) {
        await deps.log("error", "email_results.group_failed", errText(e), g[0].tenant_id, { stage: g[0].source });
      }
    },
    async (g) => {
      for (const t of g) await deps.complete(t, { outcome: "rate_limited", next_due: deps.now() }).catch(() => undefined);
    },
  );

  let backlog = { due: 0, oldest_due_at: null as string | null, newly_stuck: [] as Array<{ tenant_id: string; source: string; stage: string; last_error: string | null }> };
  try {
    backlog = await deps.backlog(PASS.stuckAfterHours);
    for (const s of backlog.newly_stuck) await deps.alertStuck(s).catch(() => undefined);
  } catch (e) {
    await deps.log("warn", "email_results.backlog_failed", errText(e));
  }
  const oldestAge = backlog.oldest_due_at ? Math.round((deps.now().getTime() - Date.parse(backlog.oldest_due_at)) / 60_000) : null;
  const report: PassReport = {
    claimed: tasks.length,
    groups: list.length,
    repaired,
    purged,
    backlog_due: backlog.due,
    oldest_due_age_min: oldestAge,
    stuck_alerted: backlog.newly_stuck.length,
  };
  await deps.log("info", "email_results.pass", `claimed ${report.claimed} in ${report.groups} groups; backlog ${report.backlog_due}, oldest ${oldestAge ?? 0} min`, null, {
    retry_count: report.claimed,
    ms: deps.now().getTime() - started,
  });
  return report;
}

export async function liveCheckDeps(): Promise<CheckDeps> {
  const { staffCrossTenantClient, tenantRpc, tenantClient, asTenantId } = await import("@/services/tenant-client");
  const { logEvent } = await import("@/services/logging/logEvent");
  const cross = () => staffCrossTenantClient("email results worker: claims due check-backs across tenants and reports the backlog");
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await cross().rpc(name, args);
    if (error) throw new Error(`${name} failed`);
    return data as T;
  };
  return {
    claim: async (limit, leaseSeconds) => (await rpc<ClaimedTask[] | null>("claim_email_result_tasks", { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? [],
    complete: async (t, c) => {
      const { data, error } = await tenantRpc(asTenantId(t.tenant_id), "complete_email_result_task", {
        p_task_id: t.task_id,
        p_lease_token: t.lease_token,
        p_outcome: c.outcome,
        p_result: c.result ?? {},
        p_next_due: c.next_due?.toISOString() ?? null,
        p_error: c.error ?? null,
        p_ga: c.ga ?? null,
        p_note: c.note ?? null,
      });
      if (error) throw new Error("complete_email_result_task failed");
      const out = data as { ok?: boolean; code?: string } | null;
      if (!out?.ok && out?.code !== "not_owner") throw new Error(`complete_email_result_task refused: ${out?.code ?? "unknown"}`);
    },
    providerAccess: async (tenantId, route, accountRef) => {
      if (route === "sendgrid") {
        const { resolveSendgridAccount, sendgridKeyNeedsPermissions } = await import("@/services/connectors/email-campaign/sendgrid-account");
        const { sendgridHttpCall } = await import("@/services/connectors/email-campaign/providers-sendgrid");
        const sg = await resolveSendgridAccount(tenantId);
        if (!sg) {
          if (await sendgridKeyNeedsPermissions(tenantId)) throw new Error("the saved SendGrid key is missing campaign permissions");
          return { kind: "none" };
        }
        const same = accountRef?.kind === "sendgrid_key" && typeof accountRef.key_digest === "string" && sameDigest(accountRef.key_digest, sg.key_digest);
        return { kind: "ok", call: sendgridHttpCall(sg.api_key, fetch, 10_000), sameCredential: same, cacheKey: `sendgrid:${sg.key_digest.slice(0, 32)}` };
      }
      const { resolveOwnedComposioAccount } = await import("@/services/connectors/composio/account");
      const { composioExecuteTool } = await import("@/services/connectors/composio/api");
      const acct = await resolveOwnedComposioAccount(tenantId, route);
      if (!acct) return { kind: "none" };
      const same = accountRef?.kind === "composio" && accountRef.connected_account_id === acct.connected_account_id && accountRef.auth_config_id === acct.auth_config_id;
      const call: ProviderCall = async (tool_slug, args) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10_000);
        try {
          return await composioExecuteTool({ tool_slug, user_id: acct.tenant_id, connected_account_id: acct.connected_account_id, arguments: args }, ctl.signal);
        } finally {
          clearTimeout(timer);
        }
      };
      return { kind: "ok", call, sameCredential: same, cacheKey: `${route}:${acct.connected_account_id}` };
    },
    bulkCounts: async (tenantId, sendId) => {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("email_bulk_sends")
        .select("sent, delivered, opens, machine_opens, unsubscribes, hard_bounces, delivered_seen_at")
        .eq("id", sendId)
        .maybeSingle();
      if (error) throw new Error("email_bulk_sends read failed");
      return (data as BulkCounts | null) ?? null;
    },
    gaCreds: async (tenantId) => {
      const { googleAnalyticsCreds } = await import("@/services/tools/google-analytics/_client");
      try {
        return await googleAnalyticsCreds(tenantId);
      } catch (e) {
        if ((e as { code?: string }).code === "google_analytics_not_connected") return null;
        throw e;
      }
    },
    gaReport: async (creds, body) => (await import("@/services/tools/google-analytics/_client")).runReportWith(creds, body, 10_000),
    missing: async (since, limit) =>
      (await rpc<Array<{ tenant_id: string; rail: "channel_actions" | "decisions"; card_id: string; sent: number | null }> | null>("email_results_missing", {
        p_since: since.toISOString(),
        p_limit: limit,
      })) ?? [],
    start: async (input) => (await import("./start")).startEmailSendResult(input),
    holdRepair: async (m, reason) => {
      await rpc("email_results_repair_hold", { p_tenant_id: m.tenant_id, p_rail: m.rail, p_card_id: m.card_id, p_reason: reason });
    },
    backlog: async (hours) => rpc("email_results_backlog", { p_stuck_after_hours: hours }),
    purgeEventIds: async (batch) => Number((await rpc<number>("email_bulk_purge_event_ids", { p_batch: batch })) ?? 0),
    alertStuck: async (s) => {
      const { alert } = await import("@/services/logging/alert");
      await alert({ msg: `email results check-back stuck 72h past due (${s.source} ${s.stage})`, source: "email-results-check", code: "email_results_stuck", tenant_id: s.tenant_id });
    },
    log: async (level, code, message, tenantId = null, meta = {}) => {
      await logEvent({ level, source: "email-results", code, message, tenant_id: tenantId, meta }).catch(() => undefined);
    },
    now: () => new Date(),
  };
}

