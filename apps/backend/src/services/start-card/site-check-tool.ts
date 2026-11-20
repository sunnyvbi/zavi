
import { z } from "zod";
import { getBoolSetting } from "@/services/settings";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { checkAffordMedia, type AffordCheck } from "@/services/media-router/charge";
import { costToCredits } from "@/services/agents/credits";
import { addRunSideCost } from "@/services/agents/run-side-costs";
import { recordLateToolCharge } from "@/services/billing/tool-charges";
import { logEvent } from "@/services/logging/logEvent";
import { admitSite, type AdmitRefusal } from "./admission";
import { DEDUPE_WINDOW_MS, enqueueCardRun } from "./queue";
import { cancelCard } from "./pipeline";
import {
  claimCard,
  findRecentCardForDomain,
  getCardById,
  transitionDelivery,
  type CardDeliveryTarget,
  type StartCardRow,
} from "./store";
import {
  SITE_CHECK_COST_SOURCE,
  SITE_CHECK_RESERVE_USD,
  SITE_CHECK_RUN_CAP,
  siteCheckCostKey,
  tenantChargeUsd,
} from "./site-check-funding";
import { cardUrl, scoredSearchTerm, scoresOf, type CheckScore } from "./site-check-result";

export const SITE_CHECK_WAIT_MS = 90_000;
const POLL_MS = 3_000;

export const runSiteCheckInput = z.object({
  url: z.string().min(1).max(2048).describe("The website to check, e.g. acme.com or https://acme.com"),
});

export type SiteCheckCtx = {
  tenant_id: string;
  run_id?: string;
  tool_use_id?: string;
  trigger?: string;
  chat_thread_id?: string;
  slack_routing?: { channel_id: string; thread_ts: string; team_id?: string };
  writes_suppressed?: boolean;
};

export type SiteCheckRefusal =
  | AdmitRefusal
  | "not_available"
  | "insufficient_credits"
  | "credits_unavailable"
  | "run_cap"
  | "check_failed"
  | "server_error"
  | "billing_uncertain";

export type SiteCheckResult =
  | {
      status: "done" | "deduped";
      domain: string;
      card_url: string;
      card_status: "running" | "done" | "failed";
      search_term: string | null;
      total: number | null;
      out_of: number | null;
      scores: CheckScore[];
      credits_charged: number;
      message: string;
    }
  | { status: "pending"; domain: string; card_url: string; credits_reserved: number; message: string }
  | { status: "refused"; reason: SiteCheckRefusal; message: string; card_url?: string };

export type SiteCheckDeps = {
  toolEnabled: () => Promise<boolean>;
  cardsEnabled: () => Promise<boolean>;
  admit: typeof admitSite;
  findRecent: typeof findRecentCardForDomain;
  afford: (tenantId: string, usd: number) => Promise<AffordCheck>;
  claim: typeof claimCard;
  enqueue: (cardId: string) => Promise<void>;
  cancel: typeof cancelCard;
  getCard: typeof getCardById;
  transition: typeof transitionDelivery;
  addSideCost: typeof addRunSideCost;
  recordLate: typeof recordLateToolCharge;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export async function isSiteCheckToolEnabled(opts: { strict?: boolean } = {}): Promise<boolean> {
  const onError = !opts.strict;
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> | null }>();
    if (error) return onError;
    return (data?.blob ?? {}).site_check_tool_enabled !== false;
  } catch {
    return onError;
  }
}

async function readRunStop(tenantId: string, runId: string): Promise<{ status: string; stop_requested: boolean } | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("status, stop_requested")
    .eq("id", runId)
    .maybeSingle<{ status: string; stop_requested: boolean | null }>();
  if (error) throw new Error(`site-check: run read failed: ${error.message}`);
  return data ? { status: data.status, stop_requested: data.stop_requested === true } : null;
}

export type TenantCardGateDeps = {
  toolEnabled: () => Promise<boolean>;
  readRun: typeof readRunStop;
};
export const defaultTenantCardGateDeps: TenantCardGateDeps = {
  toolEnabled: () => isSiteCheckToolEnabled({ strict: true }),
  readRun: readRunStop,
};

export async function tenantCardStartBlock(
  row: Pick<StartCardRow, "funding_kind" | "funding_tenant_id" | "requested_by_run_id">,
  deps: TenantCardGateDeps = defaultTenantCardGateDeps,
): Promise<null | "tool_disabled" | "run_stopped"> {
  if (row.funding_kind !== "tenant_credits") return null;
  if (!(await deps.toolEnabled())) return "tool_disabled";
  if (!row.funding_tenant_id || !row.requested_by_run_id) return "run_stopped";
  const run = await deps.readRun(row.funding_tenant_id, row.requested_by_run_id);
  if (!run || run.stop_requested || run.status === "cancelled") return "run_stopped";
  return null;
}

export const defaultSiteCheckDeps: SiteCheckDeps = {
  toolEnabled: () => isSiteCheckToolEnabled(),
  cardsEnabled: () => getBoolSetting("start_card_enabled"),
  admit: admitSite,
  findRecent: findRecentCardForDomain,
  afford: checkAffordMedia,
  claim: claimCard,
  enqueue: enqueueCardRun,
  cancel: cancelCard,
  getCard: getCardById,
  transition: transitionDelivery,
  addSideCost: addRunSideCost,
  recordLate: recordLateToolCharge,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const REFUSAL_MESSAGES: Record<SiteCheckRefusal, string> = {
  missing_url: "No website was given. Ask the founder which site to check.",
  url_too_long: "That address is too long to check.",
  invalid_url: "That doesn't look like a website address (try something like acme.com).",
  unsupported_scheme: "That doesn't look like a website address (try something like acme.com).",
  unsafe_url: "That address can't be checked: only public websites can.",
  unreachable: "That website couldn't be found. Check the address with the founder.",
  not_available: "The site check isn't available right now. Tell the founder they can run it at /start.",
  insufficient_credits:
    "This workspace doesn't have enough credits for a site check (it needs about 195). Nothing was run or charged. Tell the founder to top up, or they can run it at /start.",
  credits_unavailable: "The credit balance couldn't be read, so no check was started and nothing was charged. Try again in a minute.",
  run_cap: "This conversation already ran a site check, which is the limit for one run. Tell the founder they can check another site at /start.",
  check_failed: "The site check couldn't finish, so nothing was charged. You can try once more.",
  server_error: "Something went wrong starting the check. Nothing was charged.",
  billing_uncertain: "The check ran; the charge is being confirmed and will show in Usage shortly.",
};

function refuse(reason: SiteCheckRefusal, card_url?: string): SiteCheckResult {
  return { status: "refused", reason, message: REFUSAL_MESSAGES[reason], ...(card_url ? { card_url } : {}) };
}

export function deliveryTargetFor(ctx: SiteCheckCtx): CardDeliveryTarget {
  if (ctx.trigger === "slack" && ctx.slack_routing?.channel_id && ctx.slack_routing.thread_ts) {
    return {
      kind: "slack",
      channel_id: ctx.slack_routing.channel_id,
      thread_ts: ctx.slack_routing.thread_ts,
      team_id: ctx.slack_routing.team_id ?? null,
    };
  }
  if (ctx.chat_thread_id) return { kind: "chat", thread_id: ctx.chat_thread_id };
  return { kind: "none" };
}

function finishedResult(row: StartCardRow, status: "done" | "deduped", charged: number): SiteCheckResult {
  const cardStatus = row.status === "done" || row.status === "running" ? row.status : "failed";
  const url = cardUrl(row.public_id);
  const message =
    status === "deduped"
      ? cardStatus === "running"
        ? `This site was already being checked in the last 24 hours, so no new check was run and nothing was charged. It's still finishing; share the link: ${url}`
        : `This site was already checked in the last 24 hours, so that card is reused and nothing was charged.`
      : `The check finished. Give the founder the score, the search term and the link.`;
  return {
    status,
    domain: row.domain,
    card_url: url,
    card_status: cardStatus,
    search_term: scoredSearchTerm(row),
    total: row.score?.total ?? null,
    out_of: row.score?.out_of ?? null,
    scores: row.score ? scoresOf(row.score) : [],
    credits_charged: charged,
    message,
  };
}

async function waitForCard(cardId: string, deps: SiteCheckDeps): Promise<StartCardRow | null> {
  const deadline = deps.now() + SITE_CHECK_WAIT_MS;
  for (;;) {
    const row = await deps.getCard(cardId);
    if (!row) return null;
    if (row.status !== "running" || deps.now() >= deadline) return row;
    await deps.sleep(Math.min(POLL_MS, Math.max(0, deadline - deps.now())));
  }
}

async function billAndReturn(row: StartCardRow, ctx: Required<Pick<SiteCheckCtx, "tenant_id" | "run_id" | "tool_use_id">>, deps: SiteCheckDeps): Promise<SiteCheckResult> {
  const won = await deps.transition(row.id, "waiting", "returned");
  const current = won ? "returned" : (await deps.getCard(row.id))?.delivery_state;
  let charged = 0;
  if (current === "returned") {
    const usd = tenantChargeUsd(row);
    let r: Awaited<ReturnType<SiteCheckDeps["addSideCost"]>>;
    try {
      r = await deps.addSideCost({
        tenantId: ctx.tenant_id,
        runId: ctx.run_id,
        usd,
        source: SITE_CHECK_COST_SOURCE,
        key: siteCheckCostKey(ctx.tool_use_id),
      });
    } catch (e) {
      if (won) await deps.transition(row.id, "returned", "waiting").catch(() => false);
      throw e;
    }
    if (r === "added" || r === "already") charged = costToCredits(usd);
  }
  if (row.status !== "done") return refuse("check_failed", cardUrl(row.public_id));
  return finishedResult(row, "done", charged);
}

export async function runSiteCheck(ctx: SiteCheckCtx, args: unknown, deps: SiteCheckDeps = defaultSiteCheckDeps): Promise<SiteCheckResult> {
  const parsed = runSiteCheckInput.safeParse(args ?? {});
  if (!parsed.success) return refuse("invalid_url");

  if (!(await deps.toolEnabled()) || !(await deps.cardsEnabled())) return refuse("not_available");
  if (ctx.writes_suppressed || !ctx.run_id || !ctx.tool_use_id) return refuse("not_available");
  const call = { tenant_id: ctx.tenant_id, run_id: ctx.run_id, tool_use_id: ctx.tool_use_id };

  const admitted = await deps.admit(parsed.data.url);
  if (!admitted.ok) return refuse("code" in admitted ? admitted.code : "invalid_url");
  const site = admitted.site;
  const sinceIso = new Date(deps.now() - DEDUPE_WINDOW_MS).toISOString();
  let ownsCard = false;

  try {
    const recent = await deps.findRecent(site.domain, sinceIso);
    const ownCard = !!recent && recent.requested_by_run_id === ctx.run_id && recent.tool_call_id === ctx.tool_use_id;
    if (recent && !ownCard) {
      const row = recent.status === "running" ? ((await waitForCard(recent.id, deps)) ?? recent) : recent;
      return finishedResult(row, "deduped", 0);
    }

    if (!ownCard) {
      const afford = await deps.afford(ctx.tenant_id, SITE_CHECK_RESERVE_USD);
      if (afford === "short") return refuse("insufficient_credits");
      if (afford !== "ok") return refuse("credits_unavailable");
    }

    const claimed = await deps.claim({
      domain: site.domain,
      since_iso: sinceIso,
      funding: {
        kind: "tenant_credits",
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        tool_call_id: ctx.tool_use_id,
        reserved_usd: SITE_CHECK_RESERVE_USD,
        delivery_target: deliveryTargetFor(ctx),
        run_cap: SITE_CHECK_RUN_CAP,
      },
    });
    if (claimed.outcome === "run_cap") return refuse("run_cap");
    if (claimed.outcome === "run_not_running") return refuse("not_available");
    if (claimed.outcome === "reused") {
      const row = await waitForCard(claimed.id, deps);
      if (!row) return refuse("server_error");
      return finishedResult(row, "deduped", 0);
    }
    if (!("id" in claimed)) return refuse("server_error");
    const card = claimed;
    ownsCard = true;

    if (card.status === "running") {
      try {
        await deps.enqueue(card.id);
      } catch (e) {
        console.error(`[site-check] enqueue failed: ${(e as Error).message?.slice(0, 200)}`);
        await deps.cancel(card.id, "enqueue_failed");
        await deps.transition(card.id, "waiting", "returned").catch(() => false);
        return refuse("check_failed", cardUrl(card.public_id));
      }
    }

    const row = await waitForCard(card.id, deps);
    if (!row) return refuse("billing_uncertain");
    if (row.delivery_state === "pending" || row.delivery_state === "delivered") {
      if (row.status === "running") return pendingResult(row, ctx);
      if (row.status !== "done") return refuse("check_failed", cardUrl(row.public_id));
      return finishedResult(row, "done", costToCredits(tenantChargeUsd(row)));
    }
    if (row.status !== "running") return await billAndReturn(row, call, deps);

    const late = await deps.recordLate({
      tenantId: ctx.tenant_id,
      runId: ctx.run_id,
      toolCallId: ctx.tool_use_id,
      cardId: row.id,
      reservedUsd: SITE_CHECK_RESERVE_USD,
    });
    if (late === "run_finished" || late === "no_run") {
      void logEvent({ level: "error", source: "start_card", code: `site_check_late_${late}`, tenant_id: ctx.tenant_id });
    }
    await deps.transition(row.id, "waiting", "pending");
    const after = await deps.getCard(row.id);
    if (after && after.status !== "running" && (await deps.transition(row.id, "pending", "delivered"))) {
      if (after.status !== "done") return refuse("check_failed", cardUrl(after.public_id));
      return finishedResult(after, "done", costToCredits(tenantChargeUsd(after)));
    }
    return pendingResult(row, ctx);
  } catch (e) {
    console.error(`[site-check] failed: ${(e as Error).message?.slice(0, 200)}`);
    return refuse(ownsCard ? "billing_uncertain" : "server_error");
  }
}

function pendingResult(row: StartCardRow, ctx: SiteCheckCtx): SiteCheckResult {
  const url = cardUrl(row.public_id);
  const target = deliveryTargetFor(ctx);
  const follow =
    target.kind === "none"
      ? "The result will not be posted here automatically, so give the founder the link."
      : "The full result will be posted in this same thread when it finishes, so tell the founder that and share the link.";
  return {
    status: "pending",
    domain: row.domain,
    card_url: url,
    credits_reserved: costToCredits(SITE_CHECK_RESERVE_USD),
    message: `The check is still running (they take about 1-2 minutes). ${follow} It costs what the check actually spends, at most ${costToCredits(SITE_CHECK_RESERVE_USD)} credits.`,
  };
}
