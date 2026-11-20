import { CHANNELS } from "@zavi/shared";
import { readApprovalClass } from "@/agents/engineer/approval-class";
import { decisionCardTitle, decisionConsequence } from "@/services/approvals/decision-copy";
import { approveNeedsOwnerOrAdmin } from "@/services/approvals/approve-role-gate";
import { creditBalanceView, type BalanceRow } from "@/services/billing/balance-view";
import { buildPublicPricing } from "@/routes/public/pricing";
import { tierAgentMinFromBlob, tierAllows, requiredTierFor, isTier, type Tier } from "@/services/billing/tiers";
import { decisionHomeUrl } from "@/services/web-base";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { readConnectorList } from "@/services/connectors/metadata";
import { shopifyGraphql, ShopifyGraphqlError } from "./graphql";
import { shopifyBillingLockReason } from "./app-billing";
import type { ShopifyAppContext, ShopifyViewerRole } from "./app-context";

const DAY_MS = 86_400_000;
const ORDER_PAGE_SIZE = 250;
const ORDER_PAGE_CAP = 20;

type Metric = {
  value: number | null;
  unit: "usd" | "count";
  currency?: string | null;
  comparison: number | null;
  availability: "live" | "stale" | "unavailable" | "plan_locked";
  source: "shopify" | "zavi" | "ad_provider";
  measured_at: string | null;
  note: string | null;
  locked_tier?: Tier;
};

type SubRow = {
  plan: "free" | "team" | null;
  status: string | null;
  tier: string | null;
  source: string | null;
  current_period_end: string | null;
  comp_expires_at: string | null;
  stripe_subscription_id: string | null;
  shopify_subscription_id: string | null;
  grandfathered: boolean | null;
  credits_revoked_at: string | null;
  shopify_shop: string | null;
};

type DecisionRow = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
  home_channel: string | null;
  emitted_at: string;
};

type ShopifyOrder = {
  createdAt: string;
  currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
};

type OrdersPage = {
  orders: {
    nodes: ShopifyOrder[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type ShopifyWindowMetrics = {
  displayName: string | null;
  sales: Metric;
  orders: Metric;
  syncedAt: string | null;
};

const SHOPIFY_ONE_CLICK_APPROVAL_CLASSES: ReadonlySet<string> = new Set([
  "channel.recipe_step",
]);

type ShopifyActiveSubscription = {
  name: string;
  status: string;
  currentPeriodEnd: string | null;
};

const pct = (current: number, previous: number): number | null =>
  previous > 0 ? Math.round(((current - previous) / previous) * 100) : current > 0 ? 100 : null;

function hasReadScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope) || (scope.startsWith("read_") && scopes.includes(`write_${scope.slice(5)}`));
}

export function oneClickApprovalAllowed(args: {
  role: ShopifyViewerRole;
  decisionClass: string;
  body: unknown;
}): boolean {
  if (args.role === "viewer") return false;
  if (!SHOPIFY_ONE_CLICK_APPROVAL_CLASSES.has(args.decisionClass)) return false;
  if (readApprovalClass(args.body) === "ship_red") return false;
  return !approveNeedsOwnerOrAdmin(args.decisionClass, args.body);
}

export async function readShopifyWindowMetrics(context: ShopifyAppContext, now = new Date()): Promise<ShopifyWindowMetrics> {
  const measuredAt = now.toISOString();
  const unavailable = (unit: "usd" | "count", note: string): Metric => ({
    value: null, unit, comparison: null, availability: "unavailable", source: "shopify", measured_at: null, note,
  });

  let displayName: string | null = null;
  try {
    const shop = await shopifyGraphql<{ shop: { name: string } }>({
      shop: context.shop,
      accessToken: context.grant.access_token,
      query: `query ZaviShopIdentity { shop { name } }`,
    });
    displayName = shop.shop.name;
  } catch {
  }

  if (!hasReadScope(context.grant.user_scopes, "read_orders")) {
    const note = "This Shopify staff account does not have permission to read orders.";
    return { displayName, sales: unavailable("usd", note), orders: unavailable("count", note), syncedAt: null };
  }

  const currentStart = new Date(now.getTime() - 7 * DAY_MS);
  const previousStart = new Date(now.getTime() - 14 * DAY_MS);
  const queryText = `created_at:>=${previousStart.toISOString()}`;
  const all: ShopifyOrder[] = [];
  let after: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < ORDER_PAGE_CAP; page += 1) {
      const data: OrdersPage = await shopifyGraphql<OrdersPage>({
        shop: context.shop,
        accessToken: context.grant.access_token,
        query: `query ZaviAppHomeOrders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
            nodes { createdAt currentTotalPriceSet { shopMoney { amount currencyCode } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { first: ORDER_PAGE_SIZE, after, query: queryText },
      });
      all.push(...data.orders.nodes);
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
      if (page === ORDER_PAGE_CAP - 1) truncated = true;
    }
  } catch (error) {
    const note = error instanceof ShopifyGraphqlError && error.code === "access_denied"
      ? "This Shopify staff account cannot read order totals."
      : "Shopify order totals could not be refreshed.";
    return { displayName, sales: unavailable("usd", note), orders: unavailable("count", note), syncedAt: null };
  }

  if (truncated) {
    const note = `More than ${ORDER_PAGE_SIZE * ORDER_PAGE_CAP} orders matched; open Shopify Analytics for the complete total.`;
    return { displayName, sales: unavailable("usd", note), orders: unavailable("count", note), syncedAt: measuredAt };
  }

  let currentOrders = 0;
  let previousOrders = 0;
  let currentSales = 0;
  let previousSales = 0;
  const currencies = new Set<string>();
  for (const order of all) {
    const created = Date.parse(order.createdAt);
    if (!Number.isFinite(created) || created < previousStart.getTime() || created > now.getTime()) continue;
    const money = order.currentTotalPriceSet?.shopMoney;
    const amount = Number(money?.amount);
    if (money?.currencyCode) currencies.add(money.currencyCode);
    if (created >= currentStart.getTime()) {
      currentOrders += 1;
      if (Number.isFinite(amount)) currentSales += amount;
    } else {
      previousOrders += 1;
      if (Number.isFinite(amount)) previousSales += amount;
    }
  }
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const mixedCurrency = currencies.size > 1;
  const sales: Metric = mixedCurrency
    ? unavailable("usd", "Orders used more than one shop currency, so Zavi did not combine their totals.")
    : {
        value: Math.round(currentSales * 100) / 100,
        unit: "usd",
        currency,
        comparison: pct(currentSales, previousSales),
        availability: "live",
        source: "shopify",
        measured_at: measuredAt,
        note: null,
      };
  return {
    displayName,
    sales,
    orders: {
      value: currentOrders,
      unit: "count",
      comparison: currentOrders - previousOrders,
      availability: "live",
      source: "shopify",
      measured_at: measuredAt,
      note: null,
    },
    syncedAt: measuredAt,
  };
}

async function readShopifyActiveSubscription(context: ShopifyAppContext): Promise<ShopifyActiveSubscription | null> {
  try {
    const data = await shopifyGraphql<{
      currentAppInstallation: { activeSubscriptions: ShopifyActiveSubscription[] };
    }>({
      shop: context.shop,
      accessToken: context.grant.access_token,
      query: `query ZaviActiveSubscription {
        currentAppInstallation {
          activeSubscriptions { name status currentPeriodEnd }
        }
      }`,
    });
    return data.currentAppInstallation.activeSubscriptions[0] ?? null;
  } catch (error) {
    if (error instanceof ShopifyGraphqlError && error.code === "unauthorized") throw error;
    return null;
  }
}

function pricingView(blob: Record<string, unknown> | null) {
  const raw = buildPublicPricing(blob);
  return {
    tiers: raw.tiers.map((tier) => ({
      slug: tier.slug,
      name: tier.name,
      usd: tier.usd,
      sixMonthUsd: tier.six_month_usd,
      sixMonthPerMonthUsd: tier.six_month_per_month_usd,
      monthlyCredits: tier.monthly_credits,
      dailyCredits: tier.daily_credits,
      includes: tier.includes,
    })),
    freeDailyCredits: raw.free_daily_credits,
    topupPacks: raw.topup_packs,
    sixMonthAvailable: raw.six_month_available,
    sixMonthMonths: raw.six_month_months,
    sixMonthDiscountPct: raw.six_month_discount_pct,
  };
}

export async function buildShopifyAppHome(context: ShopifyAppContext) {
  const tid = asTenantId(context.tenant_id);
  const now = new Date();
  const currentStart = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const previousStart = new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const [
    shopMetrics,
    activeShopifySubscription,
    subResult,
    balanceResult,
    configResult,
    approvalsResult,
    runsResult,
    activeRunsResult,
    goalResult,
    channelRowsResult,
    metricRowsResult,
    connectors,
  ] = await Promise.all([
    readShopifyWindowMetrics(context, now),
    readShopifyActiveSubscription(context),
    tenantClient(tid).from("tenant_subscriptions")
      .select("plan, status, tier, source, current_period_end, comp_expires_at, stripe_subscription_id, shopify_subscription_id, grandfathered, credits_revoked_at, shopify_shop")
      .maybeSingle<SubRow>(),
    tenantClient(tid).from("tenant_credit_balances")
      .select("period_start, period_end, included_allowance, included_used, purchased_balance, reserved, daily_allowance, daily_used, daily_period_end")
      .maybeSingle<BalanceRow>(),
    globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle<{ blob: Record<string, unknown> | null }>(),
    tenantClient(tid).from("customer_visible_pending_decisions")
      .select("id, decision_class, handler, body, home_channel, emitted_at", { count: "exact" })
      .order("emitted_at", { ascending: false }).limit(5),
    tenantClient(tid).from("agent_runs")
      .select("finished_at, channel_slug").eq("status", "success").neq("agent_definition_hash", "seed-synthetic")
      .gte("finished_at", previousStart).limit(5000),
    tenantClient(tid).from("agent_runs").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]),
    tenantClient(tid).from("autopilot_goals").select("objective").eq("status", "active")
      .order("priority", { ascending: false }).limit(1).maybeSingle<{ objective: string }>(),
    tenantClient(tid).from("tenant_channels")
      .select("channel_slug, work_state, plan_selected, priority")
      .or("plan_selected.eq.true,work_state.in.(running,needs_review)")
      .order("priority", { ascending: true }).limit(8),
    tenantClient(tid).from("tenant_metric_snapshots")
      .select("metric_key, value, status, window_end")
      .in("metric_key", ["ads_spend_7d", "google_ads_spend_7d"])
      .order("window_end", { ascending: false }).limit(20),
    readConnectorList(context.tenant_id),
  ]);

  const dbError = subResult.error ?? balanceResult.error ?? configResult.error ?? approvalsResult.error ?? runsResult.error ?? activeRunsResult.error ?? goalResult.error ?? channelRowsResult.error ?? metricRowsResult.error;
  if (dbError) throw new Error(`shopify_app_home_read_failed:${dbError.message}`);
  const sub = (subResult.data ?? null) as SubRow | null;
  const blob = configResult.data?.blob ?? null;
  const pricing = pricingView(blob);
  const balance = creditBalanceView(sub, (balanceResult.data ?? null) as BalanceRow | null, blob, now);
  const tier: Tier = isTier(balance.tier) ? balance.tier : "free";
  const tierMap = tierAgentMinFromBlob(blob);
  const billingLock = shopifyBillingLockReason(sub, context.shop);

  const connectorSlugs = new Set(connectors.map((connector) => connector.slug));
  const rawChannels = (channelRowsResult.data ?? []) as Array<{ channel_slug: string; work_state: string; plan_selected: boolean }>;
  const wanted = new Set(rawChannels.map((row) => row.channel_slug));
  for (const slug of ["instagram_organic", "meta_ads", "email_marketing", "google_ads"]) wanted.add(slug);
  const channels = CHANNELS.filter((channel) => wanted.has(channel.slug)).slice(0, 6).map((channel) => {
    const required = requiredTierFor(channel.slug, tierMap);
    const linked = channel.connectors.some((connector) => connectorSlugs.has(connector) || connectorSlugs.has(`composio.${connector}`));
    const selected = rawChannels.some((row) => row.channel_slug === channel.slug && row.plan_selected);
    if (!tierAllows(tier, channel.slug, tierMap)) return { slug: channel.slug, label: channel.name, state: "plan_locked" as const, locked_tier: required };
    if (linked) return { slug: channel.slug, label: channel.name, state: "connected" as const };
    return { slug: channel.slug, label: channel.name, state: selected ? "draft_only" as const : "not_connected" as const };
  });

  const decisions = (approvalsResult.data ?? []) as DecisionRow[];
  const approvalRows = decisions.map((decision) => {
    const body = decision.body ?? {};
    const needsOwner = approveNeedsOwnerOrAdmin(decision.decision_class, body);
    return {
      id: decision.id,
      channel: decision.home_channel,
      title: decisionCardTitle(decision.decision_class, body),
      consequence: decisionConsequence(decision.handler, decision.decision_class, body).approve,
      one_click_approvable: oneClickApprovalAllowed({ role: context.role, decisionClass: decision.decision_class, body }),
      needs_owner_admin: needsOwner,
      review_url: decisionHomeUrl(decision, context.tenant_id),
      preview_url: null,
    };
  });

  const runRows = (runsResult.data ?? []) as Array<{ finished_at: string | null; channel_slug: string | null }>;
  const currentRuns = runRows.filter((row) => row.finished_at && row.finished_at >= currentStart);
  const previousRuns = runRows.filter((row) => row.finished_at && row.finished_at < currentStart);
  const byChannel = new Map<string, number>();
  for (const row of currentRuns) if (row.channel_slug) byChannel.set(row.channel_slug, (byChannel.get(row.channel_slug) ?? 0) + 1);
  const topActions = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([slug, count]) => `${count} ${CHANNELS.find((channel) => channel.slug === slug)?.name ?? slug}`).join(" · ");

  const latestSpend = new Map<string, { value: number; window_end: string }>();
  for (const row of (metricRowsResult.data ?? []) as Array<{ metric_key: string; value: number | string | null; status: string; window_end: string }>) {
    const value = Number(row.value);
    if (!latestSpend.has(row.metric_key) && row.status === "measured" && Number.isFinite(value)) latestSpend.set(row.metric_key, { value, window_end: row.window_end });
  }
  const spendValues = [...latestSpend.values()];
  const adSpend: Metric = !tierAllows(tier, "meta_ads", tierMap)
    ? { value: null, unit: "usd", comparison: null, availability: "plan_locked", source: "ad_provider", measured_at: null, note: "Needs a paid ads plan", locked_tier: requiredTierFor("meta_ads", tierMap) }
    : spendValues.length
      ? { value: Math.round(spendValues.reduce((sum, row) => sum + row.value, 0) * 100) / 100, unit: "usd", currency: "USD", comparison: null, availability: "live", source: "ad_provider", measured_at: spendValues.sort((a, b) => b.window_end.localeCompare(a.window_end))[0].window_end, note: [...latestSpend.keys()].map((key) => key.startsWith("google") ? "Google Ads" : "Meta Ads").join(" + ") }
      : { value: null, unit: "usd", comparison: null, availability: "unavailable", source: "ad_provider", measured_at: null, note: "No recent ad-platform snapshot" };

  const activeRuns = activeRunsResult.count ?? 0;
  const approvalCount = approvalsResult.count ?? approvalRows.length;
  const mode = approvalCount > 0 ? "needs_attention" : tier === "free" ? "drafting_only" : activeRuns > 0 ? "working" : "idle";
  const headline = goalResult.data?.objective
    ? `This week: ${goalResult.data.objective}`
    : tier === "free" ? "Zavi is planning and drafting for your store" : "Your growth workspace is ready";
  const source = sub?.comp_expires_at && new Date(sub.comp_expires_at).getTime() > now.getTime()
    ? "comp"
    : ["shopify", "stripe", "app_store", "play_store"].includes(String(sub?.source)) ? sub?.source : null;

  return {
    shop: {
      domain: context.shop,
      display_name: shopMetrics.displayName,
      connection: shopMetrics.syncedAt ? "connected" : "stale",
      last_synced_at: shopMetrics.syncedAt,
      scopes: context.grant.user_scopes,
    },
    workspace: { id: context.tenant_id, display_name: context.tenant_name, viewer_role: context.role },
    status: {
      mode,
      headline,
      detail: `${activeRuns} task${activeRuns === 1 ? "" : "s"} running · ${approvalCount} approval${approvalCount === 1 ? "" : "s"} waiting`,
      channels,
    },
    metrics: {
      window_days: 7 as const,
      sales: shopMetrics.sales,
      orders: shopMetrics.orders,
      zavi_actions: { value: currentRuns.length, unit: "count", comparison: currentRuns.length - previousRuns.length, availability: "live", source: "zavi", measured_at: now.toISOString(), note: topActions || null },
      ad_spend: adSpend,
      shopify_last_synced_at: shopMetrics.syncedAt,
    },
    approvals: { rows: approvalRows, remaining: Math.max(0, approvalCount - approvalRows.length) },
    billing: {
      tier,
      source,
      status: source === "shopify" ? activeShopifySubscription?.status.toLowerCase() ?? sub?.status ?? "active" : sub?.status ?? "active",
      period_end: source === "shopify" ? activeShopifySubscription?.currentPeriodEnd ?? sub?.current_period_end ?? null : sub?.current_period_end ?? null,
      credits_total: tier === "free" ? 0 : balance.credits_total,
      credits_used: tier === "free" ? 0 : balance.credits_used,
      credits_remaining: tier === "free" ? 0 : Math.max(0, balance.effective_available),
      daily_allowance: pricing.freeDailyCredits,
      daily_remaining: tier === "free" ? balance.included_remaining : balance.daily_remaining,
      manage_url: null,
      can_manage: context.role === "owner" || context.role === "admin",
      available_terms: ["monthly", "annual"] as const,
      billing_lock_reason: billingLock,
    },
    pricing,
  };
}
