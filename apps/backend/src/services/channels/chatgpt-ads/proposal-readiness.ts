import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readFundingContext, type FundingContext } from "@/services/ads-wallet/funding-context";
import { previewChatgptAccount } from "@/services/ads-wallet/chatgpt-account-preview";
import { fundingLimit, CHATGPT_MIN_DAILY_MICROS } from "@/services/connectors/chatgpt-ads/campaign-settings";
import { campaignActionRequestId } from "@/services/connectors/chatgpt-ads/campaign-action-request-id";
import { CHATGPT_CREATE, CHATGPT_WALLET_SHORT_WORDS, growthCampaignBudget, growthCreateBody } from "@/services/connectors/chatgpt-ads/growth-actions";
import type { CardHeld } from "@/services/channels/channel-actions";

type Campaign = { start_time: number; end_time: number; daily_budget_micros?: number; lifetime_budget_micros?: number };
type Account = { fundingSource: string; currency: string };
export type ProposalRow = { id: string; title?: string | null; status: string; exec_status?: string | null; exec_class?: string | null; exec_payload?: unknown };

export function campaignFundingPreview(campaign: Campaign, account: Account | null, wallet: FundingContext | null, nowMs = Date.now()) {
  let required: number | null = null;
  const expired = campaign.end_time <= nowMs / 1000;
  if (!expired && account?.fundingSource === "wallet" && account.currency === "USD") {
    try {
      required = Math.ceil(fundingLimit({ ...campaign, created_at: Math.floor(nowMs / 1000), budget: growthCampaignBudget(campaign) }) / 10_000);
    } catch {  }
  }
  const available = wallet?.status === "read" ? wallet.available_cents : null;
  const shortfall = required !== null && available !== null ? Math.max(0, required - available) : null;
  return {
    funding_source: account?.fundingSource ?? "unknown",
    estimated_at: new Date(nowMs).toISOString(),
    currency: "USD",
    estimated_required_cents: required,
    estimated_shortfall_cents: shortfall,
    zavi_ads_wallet: wallet,
    status: expired ? "schedule_ended" : account?.fundingSource === "provider" ? "provider_billed" : shortfall === null ? "unknown" : shortfall > 0 ? "insufficient" : "covered",
    budget_type: campaign.lifetime_budget_micros != null ? "lifetime" : "daily",
    lifetime_cap_micros: campaign.lifetime_budget_micros ?? null,
    note: expired ? "The schedule has ended. Revise the proposal before approval."
      : account?.fundingSource === "provider" ? "Provider-billed account: prepaid wallet coverage does not apply. Provider funding and launch checks remain required."
      : campaign.lifetime_budget_micros != null ? "Coverage is the lifetime total. Available funds and launch checks are rechecked before activation."
      : "Daily budget is not a lifetime spend cap. Coverage is twice the daily budget per covered day plus two boundary days, not expected spend. Final funding and launch checks are rechecked before activation.",
  };
}

export function walletDailyPlan(wallet: FundingContext | null, nowMs = Date.now(), dailyMicros = CHATGPT_MIN_DAILY_MICROS, window?: Pick<Campaign, "start_time" | "end_time">) {
  if (wallet?.status !== "read" || !Number.isSafeInteger(dailyMicros) || dailyMicros < CHATGPT_MIN_DAILY_MICROS) return null;
  const days = Math.min(90, Math.floor(wallet.available_cents * 10_000 / (2 * dailyMicros)) - 2);
  if (days < 1) return null;
  const now = Math.floor(nowMs / 1000);
  const start = window?.start_time ?? now + 600;
  const coverageEnd = Math.min(start, now) + days * 86400;
  const end = window ? Math.min(window.end_time, coverageEnd, start + 90 * 86400) : coverageEnd - 60;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end <= now) return null;
  const campaign = { daily_budget_micros: dailyMicros, start_time: start, end_time: end };
  const funding = campaignFundingPreview(campaign, { fundingSource: "wallet", currency: "USD" }, wallet, nowMs);
  return funding.status === "covered" ? { ...campaign, estimated_required_cents: funding.estimated_required_cents, lifetime_cap_micros: null, approval_required: true } : null;
}

export async function readProposalReadiness(tenantId: string, rows?: ProposalRow[], wallet?: FundingContext, requestId?: string) {
  try {
    const [selected, funds, read] = await Promise.all([
      previewChatgptAccount(tenantId, requestId).catch(() => null),
      wallet ? Promise.resolve(wallet) : readFundingContext(tenantId),
      rows ? Promise.resolve({ data: rows, error: null }) : tenantClient(asTenantId(tenantId)).from("channel_actions")
        .select("id, title, status, exec_status, exec_class, exec_payload")
        .eq("channel_slug", "chatgpt_ads").eq("exec_class", CHATGPT_CREATE)
        .in("status", ["pending", "snoozed"]).order("proposed_at", { ascending: false }).limit(21),
    ]);
    if (read.error || !Array.isArray(read.data)) throw new Error("Proposal read unavailable");
    const account = selected ? { fundingSource: selected.fundingSource, currency: selected.account.currency_code ?? "" } : null;
    const now = Date.now();
    const proposals = (read.data as ProposalRow[]).slice(0, rows ? undefined : 20).filter(r => r.exec_class === CHATGPT_CREATE).map(row => {
      const parsed = growthCreateBody.safeParse(row.exec_payload);
      const campaign = parsed.success ? parsed.data.bundle.campaign : null;
      return {
        id: row.id, title: row.title, status: row.status, exec_status: row.exec_status ?? null,
        campaign: campaign ? { name: campaign.name, start_time: campaign.start_time, end_time: campaign.end_time, daily_budget_micros: campaign.daily_budget_micros ?? null, lifetime_budget_micros: campaign.lifetime_budget_micros ?? null } : null,
        bundle: parsed.success && !row.exec_status ? parsed.data.bundle : null,
        wallet_only: parsed.success && parsed.data.top_up_authorized === false,
        wallet_fit: campaign && parsed.success && parsed.data.currency === "USD" && !row.exec_status && campaign.daily_budget_micros != null && account?.fundingSource === "wallet" && account.currency === "USD"
          ? walletDailyPlan(funds, now, campaign.daily_budget_micros, campaign) : null,
        funding: campaign && !row.exec_status ? campaignFundingPreview(campaign, parsed.success && parsed.data.currency === account?.currency ? account : null, funds, now) : null,
      };
    });
    return {
      status: "read" as const, read_at: new Date(now).toISOString(), complete: !!rows || read.data.length <= 20,
      open_proposals: proposals,
      wallet_daily_plan: account?.fundingSource === "wallet" && account.currency === "USD" ? walletDailyPlan(funds, now) : null,
      activation: "approval_and_fresh_execution_checks_required",
    };
  } catch {
    return { status: "unavailable" as const, complete: false, open_proposals: [], wallet_daily_plan: null, activation: "Proposal status and funding could not be verified." };
  }
}

export async function chatgptWalletShortfall(tenantId: string, row: ProposalRow): Promise<{ required_cents: number; available_cents: number; shortfall_cents: number } | null> {
  if (row.exec_class !== CHATGPT_CREATE || !["pending", "snoozed"].includes(row.status)) return null;
  if (row.exec_status != null && row.exec_status !== "failed") return null;
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions").select("approval_envelope, proposed_at").eq("id", row.id).eq("tenant_id", tenantId).maybeSingle();
    if (error || !data) return null;
    const walletOnly = (row.exec_payload as { top_up_authorized?: unknown } | null)?.top_up_authorized === false;
    const stored = data as { approval_envelope?: unknown; proposed_at?: string | null };
    if (!walletOnly && (await envelopeWouldFund(tenantId, stored.approval_envelope, stored.proposed_at))) return null;
    const state = await readProposalReadiness(tenantId, [{ ...row, exec_status: null }], undefined, campaignActionRequestId(row.id, "growth-campaign"));
    const f = state.open_proposals.find(p => p.id === row.id)?.funding;
    const available = f?.zavi_ads_wallet?.status === "read" ? f.zavi_ads_wallet.available_cents : null;
    if (f?.status !== "insufficient" || f.estimated_required_cents == null || available == null || !f.estimated_shortfall_cents) return null;
    return { required_cents: f.estimated_required_cents, available_cents: available, shortfall_cents: f.estimated_shortfall_cents };
  } catch {
    return null;
  }
}

async function envelopeWouldFund(tenantId: string, raw: unknown, proposedAt: string | null | undefined): Promise<boolean> {
  if (raw == null) return false;
  const { fundingWindow } = await import("@/services/ads-wallet/plan-funding");
  if (fundingWindow(Date.parse(proposedAt ?? "") || Date.now(), Date.now()) === null) return false;
  const { parseEnvelope } = await import("@/services/approvals/approval-envelope");
  const env = parseEnvelope(raw);
  if (!env || env.tenant_id !== tenantId) return false;
  const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
  return adsNoFrictionEnabled();
}

const usd = (cents: number | null | undefined) => cents == null ? "Unknown" : `$${(cents / 100).toFixed(2)}`;
const FUNDING_ROWS = new Set(["Wallet coverage", "Available wallet balance", "Required wallet coverage", "Funding shortfall", "Funding checked"]);
export function fundingRows(f: ReturnType<typeof campaignFundingPreview> | null) {
  return [
    { item: "Wallet coverage", before: "", after: f && f.status !== "unknown" ? f.note : "Funding could not be verified. Review again before launch." },
    ...(f?.funding_source === "wallet" ? [
      { item: "Available wallet balance", before: "", after: usd(f.zavi_ads_wallet?.status === "read" ? f.zavi_ads_wallet.available_cents : null) },
      { item: "Required wallet coverage", before: "", after: usd(f.estimated_required_cents) },
      { item: "Funding shortfall", before: "", after: usd(f.estimated_shortfall_cents) },
    ] : []),
    ...(f ? [{ item: "Funding checked", before: "", after: f.estimated_at }] : []),
  ];
}

export function heldWithLiveFunding(held: CardHeld | null | undefined, f: ReturnType<typeof campaignFundingPreview> | null | undefined): CardHeld | null | undefined {
  if (!held || !f) return held;
  if (f.status === "insufficient") return { ...held, wallet_short: true };
  if (f.status !== "covered") return held;
  const words = held.words.filter(w => w !== CHATGPT_WALLET_SHORT_WORDS);
  return words.length ? { ...held, words, wallet_short: false } : null;
}

export async function decorateProposalFunding<T extends { id: string; body: unknown; held?: CardHeld | null }>(tenantId: string, actions: T[], rows: ProposalRow[]): Promise<T[]> {
  const creates = rows.filter(r => r.exec_class === CHATGPT_CREATE && ["pending", "snoozed"].includes(r.status) && actions.some(a => a.id === r.id));
  if (!creates.length) return actions;
  const state = await readProposalReadiness(tenantId, creates);
  const byId = new Map(state.open_proposals.map(p => [p.id, p.funding]));
  return actions.map(a => {
    if (!creates.some(r => r.id === a.id)) return a;
    const body = (a.body ?? {}) as { change_sentence?: string; step?: Record<string, unknown>; exact_change?: { rows?: Array<{ item: string }> } };
    const live = byId.get(a.id) ?? null;
    const fresh = fundingRows(live);
    const held = "held" in a ? { held: heldWithLiveFunding(a.held, live) } : {};
    return { ...a, ...held, body: { ...body, step: { ...body.step, ...(body.change_sentence ? { body: body.change_sentence } : {}), responsibility: "client" }, exact_change: { rows: [...(body.exact_change?.rows ?? []).filter(r => !FUNDING_ROWS.has(r.item.replace(/^(?:Original proposal · )+/, ""))), ...fresh] } } };
  });
}
