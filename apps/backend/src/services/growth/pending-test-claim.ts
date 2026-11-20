import { dailyHoldEndsOn } from "@/services/growth/ad-plan-shape";

import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { budgetMargin, readActiveAdBudget, reserveAdSpend, type ActiveAdBudget, type AdSpendHold } from "@/services/decisions/ad-budget";
import { launchHoldUsd } from "@/services/connectors/tiktok-ads/launch-schema";
import { isPartialRiskExecCode } from "@zavi/shared";
import {
  PENDING_CHANNEL_LABEL,
  PENDING_TEST_DAYS,
  PENDING_TEST_MAX_DAYS,
  isLivePending,
  readPendingTests,
  recordPendingTest,
  type PendingChannel,
  type PendingTestRow,
} from "./pending-tests";

type ToolCtx = Parameters<ToolSpec["execute"]>[0];

export const PENDING_TEST_REPLAY = "pending_test_replay" as const;

const OLD_FIX = "raise the ad budget on the Growth page, or propose a smaller daily budget.";

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function budgetShortFix(
  ctx: ToolCtx,
  t: { channel: PendingChannel; daily_budget_usd: number; hold_usd: number; proposal: Record<string, unknown> },
  now: Date = new Date(),
  record: typeof recordPendingTest = recordPendingTest,
): Promise<string> {
  const c = ctx as ToolCtx & { redo?: boolean; [PENDING_TEST_REPLAY]?: boolean };
  if (c.writes_suppressed || c.redo || c[PENDING_TEST_REPLAY]) return OLD_FIX;
  try {
    const r = await record(ctx.tenant_id, t, now);
    const label = PENDING_CHANNEL_LABEL[t.channel];
    if (r.status === "gave_up") {
      return `a ${label} launch waited ${PENDING_TEST_MAX_DAYS} days for ad budget room and was given up. To launch it: raise the ad budget on the Growth page, or propose a smaller daily budget.`;
    }
    if (r.status === "claim_open") {
      return `a ${label} launch is already waiting${r.action_id ? ` (card ${r.action_id})` : ""}: it must be approved, rejected or expire before another one is kept. Do not propose this again now.`;
    }
    return (
      `nothing to do now. Zavi kept this launch as a pending ${label} test (checked weekly from ${r.expires_at.slice(0, 10)}, kept for up to ${PENDING_TEST_MAX_DAYS} days while ${label} has launched nothing): ` +
      `it keeps ${usd(t.hold_usd)} of the ad budget free from its own Meta and Google increases, cuts clearly worse Meta and Google ads to make that room, ` +
      `and files this card for approval as soon as the budget has that much left. ` +
      `Do not propose it again. To start sooner: raise the ad budget on the Growth page, or propose a smaller daily budget.`
    );
  } catch (e) {
    console.warn(`[pending-test] not recorded for ${ctx.tenant_id} (${t.channel}): ${(e as Error).message}`);
    return OLD_FIX;
  }
}

export async function assertNoWaitingTest(
  ctx: ToolCtx,
  channel: PendingChannel,
  now: Date = new Date(),
  read: (tenant_id: string) => Promise<PendingTestRow[]> = readPendingTests,
  card: (tenant_id: string, action_id: string) => Promise<CardState | null> = readCard,
): Promise<void> {
  if ((ctx as ToolCtx & { [PENDING_TEST_REPLAY]?: boolean })[PENDING_TEST_REPLAY]) return;
  const label = PENDING_CHANNEL_LABEL[channel];
  let rows: PendingTestRow[];
  try {
    rows = await read(ctx.tenant_id);
  } catch {
    throw new ExpectedToolError(`${channel}_pending_test_unreadable`, `Zavi could not check whether a ${label} launch is already waiting for ad budget room, so nothing was proposed. Try again in a minute.`);
  }
  const mine = rows.filter((r) => r.channel_slug === channel);
  let w = mine.find((r) => r.status === "claimed" || isLivePending(r, now));
  for (const r of mine) {
    if (w) break;
    if (!r.action_id) continue;
    let c: CardState | null;
    try {
      c = await card(ctx.tenant_id, r.action_id);
    } catch {
      throw new ExpectedToolError(`${channel}_pending_test_unreadable`, `Zavi could not check whether a ${label} launch is already waiting for approval, so nothing was proposed. Try again in a minute.`);
    }
    if (c && !cardIsOver(c)) w = r;
  }
  if (!w) return;
  throw new ExpectedToolError(
    `${channel}_test_waiting`,
    `A ${label} launch is already waiting${w.action_id ? ` (card ${w.action_id})` : " for ad budget room"}; Zavi files and holds that one, so nothing was proposed. Do not propose another until it is approved, rejected or expires.`,
  );
}

export type RefileResult =
  | { kind: "filed"; action_id: string }
  | { kind: "wait"; why: string }
  | { kind: "gone"; why: string };

export function cardIsOver(c: CardState): boolean {
  if (c.exec_status === "executed") return true;
  if (c.exec_status === "queued" || c.exec_status === "dispatching") return false;
  if (c.exec_status === "failed") return !isPartialRiskExecCode(c.code) || (c.code === "exec_partial" && c.exec_class === TIKTOK_LAUNCH_CLASS);
  return DONE_CARD.has(c.status);
}

const RETRYABLE = new Set([
  "tiktok_ads_budget_short",
  "tiktok_ads_budget_unreadable",
  "tiktok_ads_video_unreadable",
  "tiktok_ads_launch_in_flight",
  "tiktok_ads_launch_state_unreadable",
  "reddit_ads_budget_short",
  "reddit_ads_prepare_unreadable",
  "channel_stamp_unreadable",
]);

const legacyRail = async (): Promise<string> => {
  throw new ExpectedToolError("pending_test_no_rail", "This channel has no card rail for a pending test.");
};

async function replay(row: PendingTestRow, now: Date): Promise<RefileResult> {
  const { ensureCgoOrderRun } = await import("./cgo-ad-orders");
  const run_id = await ensureCgoOrderRun(row.tenant_id, row.channel_slug, now);
  const base = { tenant_id: row.tenant_id, run_id, emit_decision: legacyRail };
  let tool: ToolSpec | undefined;
  let emit: ((c: string, b: unknown) => Promise<string>) | undefined;
  if (row.channel_slug === "tiktok_ads") {
    const { resolveTiktokAdsEmit } = await import("@/services/tools/tiktok-ads/_exec-action");
    tool = (await import("@/services/tools/tiktok-ads/launch")).tiktokAdsProposeLaunchTool;
    emit = await resolveTiktokAdsEmit(base);
  } else {
    const { resolveRedditAdsEmit } = await import("@/services/tools/reddit-ads/_exec-action");
    tool = (await import("@/services/tools/reddit-ads/lifecycle-tools")).redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign");
    emit = await resolveRedditAdsEmit(base);
  }
  if (!tool || !emit || emit === legacyRail) return { kind: "wait", why: "no card rail for this channel" };
  try {
    const ctx: ToolCtx = { ...base, emit_decision: emit, log: () => undefined };
    const started = Date.now() - CLOCK_SKEW_MS;
    const out = (await tool.execute(Object.assign(ctx, { [PENDING_TEST_REPLAY]: true }), row.proposal)) as { action_id?: unknown };
    const id = typeof out?.action_id === "string" ? out.action_id : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return { kind: "wait", why: "the proposal filed no card" };
    const filed = await readFiledCard(row.tenant_id, id);
    if (!filedByReplay(filed, { run_id, started, row })) return { kind: "wait", why: `the card writer returned card ${id}, which this replay did not file` };
    return { kind: "filed", action_id: id };
  } catch (e) {
    if (e instanceof ExpectedToolError && !RETRYABLE.has(e.code)) return { kind: "gone", why: `${e.code}: ${e.message.slice(0, 200)}` };
    return { kind: "wait", why: (e as Error).message.slice(0, 200) };
  }
}

const CLOCK_SKEW_MS = 5_000;

export type FiledCard = { run_id: string | null; exec_class: string | null; exec_payload: Record<string, unknown> | null; proposed_at: string | null };

async function readFiledCard(tenant_id: string, action_id: string): Promise<FiledCard | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("run_id,exec_class,exec_payload,proposed_at")
    .eq("id", action_id)
    .maybeSingle<FiledCard>();
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  return data ?? null;
}

export function filedByReplay(c: FiledCard | null, r: { run_id: string; started: number; row: PendingTestRow }): boolean {
  if (!c || c.run_id !== r.run_id || !c.exec_payload) return false;
  const at = c.proposed_at ? Date.parse(c.proposed_at) : NaN;
  if (!Number.isFinite(at) || at < r.started) return false;
  if (r.row.channel_slug === "tiktok_ads") {
    const daily = Number(c.exec_payload.daily_budget_usd);
    return c.exec_class === TIKTOK_LAUNCH_CLASS && Number.isFinite(daily) && Math.round(daily * 100) === Math.round(r.row.daily_budget_usd * 100);
  }
  return c.exec_class === "reddit_ads.launch_campaign" && typeof c.exec_payload.operation_key === "string" && c.exec_payload.operation_key === r.row.proposal.operation_key;
}

async function reserveFor(row: PendingTestRow, action_id: string): Promise<AdSpendHold> {
  if (row.channel_slug === "tiktok_ads") {
    const { TIKTOK_CREATE_LAUNCH_CLASS } = await import("@/services/connectors/tiktok-ads/held-schema");
    return reserveAdSpend(
      { id: action_id, tenant_id: row.tenant_id, exec_source: "channel_actions", decision_class: TIKTOK_CREATE_LAUNCH_CLASS, approved_by_source: null },
      { platform: "tiktok", op: "create", object_id: null, daily_delta_usd: row.daily_budget_usd, delivery_factor: 1.25, currency: "USD", paused: false, ...(typeof row.proposal.end_date === "string" ? { ends_on: dailyHoldEndsOn(row.proposal.end_date) } : {}) },
    );
  }
  const { preparedCampaign } = await import("@/services/connectors/reddit-ads/lifecycle");
  const key = String(row.proposal.operation_key ?? "");
  const { plan, manifest } = await preparedCampaign(row.tenant_id, key, action_id);
  return reserveAdSpend(
    { id: action_id, tenant_id: row.tenant_id, exec_source: "channel_actions", decision_class: "reddit_ads.launch_campaign", approved_by_source: null },
    { platform: "reddit", op: "resume", object_id: manifest.group.id, daily_delta_usd: plan.daily_budget_usd, currency: "USD" },
  );
}

export type CardState = { status: string; exec_status: string | null; code: string | null; exec_class?: string | null };

async function readCard(tenant_id: string, action_id: string): Promise<CardState | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("status,exec_status,exec_result,exec_class")
    .eq("id", action_id)
    .maybeSingle<{ status: string; exec_status: string | null; exec_result: { code?: unknown } | null; exec_class: string | null }>();
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  if (!data) return null;
  return { status: data.status, exec_status: data.exec_status, code: typeof data.exec_result?.code === "string" ? data.exec_result.code : null, exec_class: data.exec_class };
}

export type OpenCard = { action_id: string; status: string; exec_status: string | null; exec_payload: Record<string, unknown> | null };

export async function openChannelCards(tenant_id: string, channel: string, exec_class: string): Promise<OpenCard[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id,status,exec_status,exec_result,exec_class,exec_payload")
    .eq("channel_slug", channel)
    .eq("exec_class", exec_class)
    .in("status", ["pending", "snoozed", "acted"])
    .order("proposed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  type Row = { id: string; status: string; exec_status: string | null; exec_result: { code?: unknown } | null; exec_class: string | null; exec_payload: Record<string, unknown> | null };
  return ((data ?? []) as Row[])
    .filter((r) => !cardIsOver({ status: r.status, exec_status: r.exec_status, code: typeof r.exec_result?.code === "string" ? r.exec_result.code : null, exec_class: r.exec_class }))
    .map((r) => ({ action_id: r.id, status: r.status, exec_status: r.exec_status, exec_payload: r.exec_payload }));
}

async function releaseHold(tenant_id: string, idem_key: string, action_id: string): Promise<string> {
  const r = await tenantRpc(asTenantId(tenant_id), "release_pending_test_hold", { p_idem_key: idem_key, p_channel_action_id: action_id });
  if (r.error) throw new Error(r.error.message);
  return String((r.data as { status?: unknown } | null)?.status ?? "unknown");
}

async function updateRow(row: PendingTestRow, patch: Record<string, unknown>, now: Date): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(row.tenant_id))
    .from("ad_pending_tests")
    .update({ ...patch, revision: row.revision + 1, updated_at: now.toISOString() })
    .eq("id", row.id)
    .eq("revision", row.revision)
    .select("id");
  if (error) throw new Error(`ad_pending_tests update failed: ${error.message}`);
  return (data ?? []).length === 1;
}

export type ClaimDeps = {
  readTests: (tenant_id: string) => Promise<PendingTestRow[]>;
  readBudget: (tenant_id: string) => Promise<ActiveAdBudget | null>;
  refile: (row: PendingTestRow, now: Date) => Promise<RefileResult>;
  reserve: (row: PendingTestRow, action_id: string) => Promise<AdSpendHold>;
  readCard: (tenant_id: string, action_id: string) => Promise<CardState | null>;
  release: (tenant_id: string, idem_key: string, action_id: string) => Promise<string>;
  update: (row: PendingTestRow, patch: Record<string, unknown>, now: Date) => Promise<boolean>;
  log: (tenant_id: string, code: string, message: string) => void;
  launchedSince?: (tenant_id: string, channel: PendingChannel, since: string) => Promise<boolean>;
};

const REDDIT_LAUNCH_CLASS = "reddit_ads.launch_campaign";

async function launchedSince(tenant_id: string, channel: PendingChannel, since: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id")
    .eq("channel_slug", channel)
    .eq("exec_class", channel === "tiktok_ads" ? TIKTOK_LAUNCH_CLASS : REDDIT_LAUNCH_CLASS)
    .eq("exec_status", "executed")
    .gte("executed_at", since)
    .limit(1);
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export const defaultClaimDeps: ClaimDeps = {
  readTests: readPendingTests,
  readBudget: readActiveAdBudget,
  refile: replay,
  reserve: reserveFor,
  readCard,
  release: releaseHold,
  update: updateRow,
  launchedSince,
  log: (tenant_id, code, message) => {
    void import("@/services/logging/logEvent")
      .then(({ logEvent }) => logEvent({ level: "info", source: "pending-test", code, message: message.slice(0, 500), tenant_id }))
      .catch(() => undefined);
  },
};

async function adoptFiledCard(filed: PendingTestRow, action_id: string, now: Date, deps: ClaimDeps): Promise<PendingTestRow | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = (await deps.readTests(filed.tenant_id)).find((r) => r.id === filed.id);
    if (!live || live.status !== "pending" || live.action_id) return null;
    const back = {
      action_id,
      daily_budget_usd: filed.daily_budget_usd,
      hold_usd: filed.hold_usd,
      proposal: filed.proposal,
      created_at: filed.created_at,
      expires_at: filed.expires_at,
    };
    if (await deps.update(live, back, now)) return { ...live, ...back, revision: live.revision + 1 };
  }
  return null;
}

export function renewUntil(row: Pick<PendingTestRow, "created_at">, now: Date): string | null {
  const born = Date.parse(row.created_at);
  if (!Number.isFinite(born)) return null;
  const last = born + PENDING_TEST_MAX_DAYS * 86_400_000;
  if (now.getTime() >= last) return null;
  return new Date(Math.min(now.getTime() + PENDING_TEST_DAYS * 86_400_000, last)).toISOString();
}

export type ClaimOutcome = { claimed: number; filed: number; released: number; closed: number; waiting: number; failed: number; renewed: number };

export function claimIdemKey(channel: PendingChannel, action_id: string): string {
  return `${action_id}:${channel === "tiktok_ads" ? "create" : "resume"}`;
}

const TIKTOK_LAUNCH_CLASS = "tiktok_ads.create_launch";
const DONE_CARD = new Set(["rejected", "stale", "displaced", "redone"]);

export function claimedVerdict(card: CardState | null, expired: boolean): "keep" | "launched" | "release" | "close_kept" {
  if (!card) return "release";
  if (card.exec_status === "executed") return "launched";
  if (card.exec_status === "queued" || card.exec_status === "dispatching") return "keep";
  if (card.exec_status === "failed") {
    if (card.code === "exec_partial" && card.exec_class === TIKTOK_LAUNCH_CLASS) return "release";
    return isPartialRiskExecCode(card.code) ? "close_kept" : "release";
  }
  if (DONE_CARD.has(card.status)) return "release";
  if (card.status === "acted") return "keep";
  return expired ? "release" : "keep";
}

export async function runPendingTestsForTenant(
  tenant_id: string,
  now: Date = new Date(),
  opts: { allowClaim?: boolean } = {},
  deps: ClaimDeps = defaultClaimDeps,
): Promise<ClaimOutcome> {
  const out: ClaimOutcome = { claimed: 0, filed: 0, released: 0, closed: 0, waiting: 0, failed: 0, renewed: 0 };
  let rows: PendingTestRow[];
  try {
    rows = (await deps.readTests(tenant_id)).filter((r) => r.status !== "closed");
  } catch (e) {
    deps.log(tenant_id, "pending_test.read_failed", (e as Error).message);
    out.failed += 1;
    return out;
  }
  if (rows.length === 0) return out;
  rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  let budget: ActiveAdBudget | null | undefined;
  let claimedThisRun = 0;

  for (const row of rows) {
    const label = PENDING_CHANNEL_LABEL[row.channel_slug];
    const expired = Date.parse(row.expires_at) <= now.getTime();
    try {
      if (row.status === "claimed") {
        const action_id = row.action_id as string;
        const verdict = claimedVerdict(await deps.readCard(tenant_id, action_id), expired);
        if (verdict === "keep") {
          out.waiting += 1;
          continue;
        }
        if (verdict === "release") {
          const s = await deps.release(tenant_id, row.hold_idem_key as string, action_id);
          if (s === "busy") {
            out.waiting += 1;
            continue;
          }
          if (s === "released") out.released += 1;
          deps.log(tenant_id, "pending_test.released", `${label} test ${row.id}: hold ${row.hold_idem_key} ${s} (${expired ? "expired" : "card closed or failed"})`);
        }
        const reason = verdict === "launched" ? "launched" : verdict === "close_kept" ? "launch_outcome_unknown" : expired ? "expired" : "card_closed";
        if (await deps.update(row, { status: "closed", closed_reason: reason }, now)) out.closed += 1;
        continue;
      }

      if (expired) {
        const until = renewUntil(row, now);
        if (until && !row.action_id && deps.launchedSince && !(await deps.launchedSince(tenant_id, row.channel_slug, row.created_at))) {
          if (await deps.update(row, { expires_at: until }, now)) {
            out.renewed += 1;
            deps.log(tenant_id, "pending_test.renewed", `${label} test ${row.id} renewed to ${until}: ${label} has launched nothing yet and the ad budget has not had room`);
          }
          out.waiting += 1;
          continue;
        }
        if (await deps.update(row, { status: "closed", closed_reason: "expired" }, now)) out.closed += 1;
        deps.log(
          tenant_id,
          "pending_test.expired",
          `${label} test ${row.id} expired before the ad budget had room${row.action_id ? `; its card ${row.action_id} stays open and reserves on approval` : `; nothing waits now, so the ${label} channel may propose a launch again`}`,
        );
        continue;
      }
      if (opts.allowClaim === false) {
        out.waiting += 1;
        continue;
      }
      if (budget === undefined) budget = await deps.readBudget(tenant_id);
      if (!budget) {
        out.waiting += 1;
        continue;
      }
      const hold = launchHoldUsd(row.daily_budget_usd, budget.days_left, budgetMargin(budget), undefined, row.channel_slug === "tiktok_ads" ? 1.25 : 1);
      const left = Math.round((budget.left_usd - claimedThisRun) * 100) / 100;
      if (hold > left) {
        out.waiting += 1;
        continue;
      }

      let action_id = row.action_id;
      let current = row;
      if (!action_id) {
        const r = await deps.refile(row, now);
        if (r.kind === "wait") {
          out.waiting += 1;
          deps.log(tenant_id, "pending_test.waiting", `${label} test ${row.id}: ${r.why}`);
          continue;
        }
        if (r.kind === "gone") {
          if (await deps.update(row, { status: "closed", closed_reason: r.why.slice(0, 200) }, now)) out.closed += 1;
          deps.log(tenant_id, "pending_test.gone", `${label} test ${row.id} given up: ${r.why}`);
          continue;
        }
        action_id = r.action_id;
        out.filed += 1;
        if (!(await deps.update(row, { action_id }, now))) {
          const adopted = await adoptFiledCard(row, action_id, now, deps);
          if (!adopted) {
            deps.log(tenant_id, "pending_test.changed", `${label} test ${row.id} changed while its card ${action_id} was filed and could not take it back; the card stays and reserves on approval`);
            continue;
          }
          current = adopted;
        } else current = { ...row, action_id, revision: row.revision + 1 };
      }

      const held = await deps.reserve(current, action_id);
      if (held.status !== "held") {
        out.waiting += 1;
        deps.log(tenant_id, "pending_test.hold_refused", `${label} test ${row.id}: card ${action_id} filed, hold not taken (${held.status === "refused" ? held.error : held.status})`);
        continue;
      }
      if (!(await deps.update(current, { status: "claimed", hold_idem_key: held.idem_key }, now))) {
        await deps.release(tenant_id, held.idem_key, action_id).catch(() => undefined);
        deps.log(tenant_id, "pending_test.changed", `${label} test ${row.id} changed while its hold was taken; hold given back`);
        continue;
      }
      claimedThisRun += hold;
      out.claimed += 1;
      deps.log(tenant_id, "pending_test.claimed", `${label} test ${row.id}: ${usd(hold)} held for card ${action_id} (${usd(row.daily_budget_usd)} a day)`);
    } catch (e) {
      out.failed += 1;
      deps.log(tenant_id, "pending_test.failed", `${label} test ${row.id}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function assertRedditLaunchRoom(ctx: ToolCtx, body: { operation_key: string; ad_account_id: string } & Record<string, unknown>, now: Date = new Date()): Promise<void> {
  const { preparedCampaign } = await import("@/services/connectors/reddit-ads/lifecycle");
  let daily: number;
  try {
    const prepared = await preparedCampaign(ctx.tenant_id, body.operation_key, "00000000-0000-0000-0000-000000000000");
    if (prepared.plan.ad_account_id !== body.ad_account_id) {
      throw new ExpectedToolError("reddit_ads_account_not_owned", `The campaign prepared under ${body.operation_key} belongs to another Reddit ad account, so nothing was proposed. Fix: launch it with ad_account_id ${prepared.plan.ad_account_id}.`);
    }
    daily = prepared.plan.daily_budget_usd;
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "reddit_ads_prepare_incomplete") {
      throw new ExpectedToolError(e.code, `${e.message} Nothing was proposed: a launch needs a campaign that reddit_ads__propose_prepare_campaign created and Zavi verified, all paused, under this operation_key. Fix: propose the preparation first (or reconcile it with reddit_ads__read_operation), then launch it on a later run.`);
    }
    if (e instanceof ExpectedToolError) throw e;
    throw new ExpectedToolError("reddit_ads_prepare_unreadable", `Zavi could not read the campaign prepared under ${body.operation_key}, so nothing was proposed. Try again in a minute.`);
  }
  let budget: ActiveAdBudget | null = null;
  try {
    budget = await readActiveAdBudget(ctx.tenant_id);
  } catch {
    budget = null;
  }
  if (!budget || !(daily > 0)) {
    await assertNoWaitingTest(ctx, "reddit_ads", now);
    return;
  }
  const hold = launchHoldUsd(daily, budget.days_left, budgetMargin(budget));
  if (hold <= budget.left_usd) {
    await assertNoWaitingTest(ctx, "reddit_ads", now);
    return;
  }
  const fix = await budgetShortFix(ctx, { channel: "reddit_ads", daily_budget_usd: daily, hold_usd: hold, proposal: body }, now);
  throw new ExpectedToolError(
    "reddit_ads_budget_short",
    `At ${usd(daily)} a day this launch holds ${usd(hold)} for the rest of the month, and the ad budget has ${usd(budget.left_usd)} left. Fix: ${fix}`,
    { fix },
  );
}
