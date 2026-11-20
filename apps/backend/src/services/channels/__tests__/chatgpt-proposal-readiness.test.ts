import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FundingContext } from "@/services/ads-wallet/funding-context";
import { CHATGPT_WALLET_SHORT_WORDS } from "@/services/connectors/chatgpt-ads/growth-actions";
import { campaignActionRequestId } from "@/services/connectors/chatgpt-ads/campaign-action-request-id";
const m = vi.hoisted(() => ({ preview: vi.fn(), wallet: vi.fn(), read: vi.fn(), filters: vi.fn(), tenant: vi.fn(), single: vi.fn(), parse: vi.fn(), noFriction: vi.fn() }));
vi.mock("@/services/approvals/approval-envelope", () => ({ parseEnvelope: m.parse }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: m.noFriction }));
vi.mock("@/services/ads-wallet/chatgpt-account-preview", () => ({ previewChatgptAccount: m.preview }));
vi.mock("@/services/ads-wallet/funding-context", () => ({ readFundingContext: m.wallet }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: (id: string) => {
    m.tenant(id);
    const q: any = {};
    for (const key of ["from", "select", "eq", "in", "order", "limit"]) q[key] = (...args: unknown[]) => { m.filters(key, ...args); return q; };
    q.then = (resolve: (value: unknown) => unknown) => m.read().then(resolve);
    q.maybeSingle = () => m.single();
    return q;
  },
}));
import { campaignFundingPreview, walletDailyPlan, readProposalReadiness, decorateProposalFunding, chatgptWalletShortfall } from "../chatgpt-ads/proposal-readiness";
const now = Date.parse("2026-10-16T04:18:47Z");
afterEach(() => { vi.restoreAllMocks(); });
const funds: FundingContext = { status: "read", currency: "USD", balance_cents: 16882, available_cents: 16882, reserved_cents: 0, auto_refill_enabled: false, read_at: new Date(now).toISOString(), activation: "requires_campaign_review_and_reservation" };
const campaign = { name: "Test campaign", daily_budget_micros: 25e6, bidding_type: "clicks", start_time: 1792177200, end_time: 1792436400, targeting: { locations: { countries: ["US"] } } };
const row = { id: "card", title: "Create campaign", status: "pending", exec_status: null, exec_class: "chatgpt_ads.create_and_launch", exec_payload: {
  name: campaign.name, currency: "USD", origin: "agent", daily_budget_usd: 25,
  bundle: { summary: "An ad test", rationale: "Check the verified offer", campaign,
    group: { name: "Intent", strategy: "maximize_clicks", context_hints: ["Compare options"] },
    ads: [{ name: "Test ad", title: "Compare options", body: "Explore choices", target_url: "https://example.com", image_url: "https://example.com/ad.png" }],
  },
} };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  m.preview.mockResolvedValue({ account: { currency_code: "USD" }, fundingSource: "wallet" });
  m.wallet.mockResolvedValue(funds);
  m.read.mockResolvedValue({ data: [row], error: null });
  m.single.mockResolvedValue({ data: { approval_envelope: null }, error: null });
  m.parse.mockReturnValue({ tenant_id: "tenant", actor_user_id: "u" });
  m.noFriction.mockResolvedValue(true);
});
it("prices the actual three-day proposal at $300, not its $75 nominal budget", () => {
  expect(campaignFundingPreview(campaign, { fundingSource: "wallet", currency: "USD" }, funds, now)).toMatchObject({
    status: "insufficient", estimated_required_cents: 30000, estimated_shortfall_cents: 13118, lifetime_cap_micros: null,
  });
});

it("shortens coverage inside the supplied window while preserving a future start", () => {
  const start = Math.floor(now / 1000) + 3600;
  const end = start + 3 * 86400;
  const plan = walletDailyPlan(funds, now, 25e6, { start_time: start, end_time: end });
  expect(plan).toMatchObject({ start_time: start, end_time: Math.floor(now / 1000) + 86400, estimated_required_cents: 15000 });
  expect(plan!.end_time).toBeLessThan(end);
});

it("keeps a shorter original end rather than using all available days", () => {
  const start = Math.floor(now / 1000) + 3600;
  const end = start + 3600;
  expect(walletDailyPlan(funds, now, 25e6, { start_time: start, end_time: end })).toMatchObject({ start_time: start, end_time: end });
});

it("refuses windows outside coverage or already ended", () => {
  const seconds = Math.floor(now / 1000);
  expect(walletDailyPlan(funds, now, 25e6, { start_time: seconds + 86400, end_time: seconds + 2 * 86400 })).toBeNull();
  expect(walletDailyPlan(funds, now, 25e6, { start_time: seconds - 7200, end_time: seconds - 3600 })).toBeNull();
});
it("uses a lifetime total only for a genuine lifetime-budget campaign", () => {
  expect(campaignFundingPreview({ start_time: campaign.start_time, end_time: campaign.end_time, lifetime_budget_micros: 75e6 }, { fundingSource: "wallet", currency: "USD" }, funds, now)).toMatchObject({ status: "covered", estimated_required_cents: 7500, lifetime_cap_micros: 75e6 });
});
it.each([null, { fundingSource: "wallet", currency: "EUR" }])("never invents coverage when the selected account is unknown or non-USD", account => {
  expect(campaignFundingPreview(campaign, account, funds, now)).toMatchObject({ status: "unknown", estimated_required_cents: null, estimated_shortfall_cents: null });
});
it("keeps a missing wallet unknown and provider billing separate", () => {
  expect(campaignFundingPreview(campaign, { fundingSource: "wallet", currency: "USD" }, { status: "unavailable", reason: "offline" }, now)).toMatchObject({ status: "unknown", estimated_shortfall_cents: null });
  expect(campaignFundingPreview(campaign, { fundingSource: "provider", currency: "USD" }, funds, now)).toMatchObject({ status: "provider_billed", estimated_required_cents: null });
  expect(campaignFundingPreview(campaign, { fundingSource: "wallet", currency: "USD" }, funds, campaign.end_time * 1000)).toMatchObject({ status: "schedule_ended", estimated_required_cents: null });
});
it("sizes automatic bidding to existing coverage, including the future start and boundary buffer", () => {
  const plan = walletDailyPlan(funds, now)!;
  expect(plan).toMatchObject({ daily_budget_micros: 25e6, estimated_required_cents: 15000, approval_required: true });
  expect(plan.end_time - plan.start_time).toBe(86400 - 660);
  expect(campaignFundingPreview(plan, { fundingSource: "wallet", currency: "USD" }, funds, now + 60_000).status).toBe("covered");
  expect(walletDailyPlan({ ...funds, available_cents: 14999 }, now)).toBeNull();
  expect(walletDailyPlan({ ...funds, available_cents: 15000 }, now)).not.toBeNull();
});
it("reads only the tenant's open create proposals and reports the true shortfall", async () => {
  const result = await readProposalReadiness("tenant-a");
  expect(m.tenant).toHaveBeenCalledWith("tenant-a");
  expect(m.filters).toHaveBeenCalledWith("eq", "channel_slug", "chatgpt_ads");
  expect(m.filters).toHaveBeenCalledWith("in", "status", ["pending", "snoozed"]);
  expect(result).toMatchObject({ status: "read", complete: true, open_proposals: [{ id: "card", funding: { status: "insufficient", estimated_shortfall_cents: 13118 } }] });
  expect(JSON.stringify(result)).not.toContain("exec_payload");
  expect(result.open_proposals[0].bundle?.ads[0].image_url).toBe("https://example.com/ad.png");
  expect(result.open_proposals[0].wallet_fit).toMatchObject({ estimated_required_cents: 15000 });
});
it("does not call a failed or truncated read an empty complete queue", async () => {
  m.read.mockResolvedValueOnce({ data: null, error: { message: "private error" } });
  expect(await readProposalReadiness("tenant-a")).toMatchObject({ status: "unavailable", complete: false });
  m.read.mockResolvedValueOnce({ data: Array.from({ length: 21 }, (_, i) => ({ ...row, id: String(i) })), error: null });
  const result = await readProposalReadiness("tenant-a");
  expect(result.complete).toBe(false);
  expect(result.open_proposals).toHaveLength(20);
});
it("does not price a partly executed card as a fresh unreserved create", async () => {
  const result = await readProposalReadiness("tenant-a", [{ ...row, exec_status: "failed" }]);
  expect(result.open_proposals[0].funding).toBeNull();
  expect(result.open_proposals[0].bundle).toBeNull();
  expect(result.open_proposals[0].wallet_fit).toBeNull();
});
it("repairs existing cards on read, shows coverage upfront and preserves the stored action", async () => {
  const body = { change_sentence: "Create at $25/day", step: { body: "A claimed $75 cap" }, exact_change: { rows: [{ item: "Daily budget", before: "", after: "$25/day" }] } };
  const actions = [{ id: "card", body }];
  const [view] = await decorateProposalFunding("tenant-a", actions, [row]);
  expect(view.body.step).toMatchObject({ responsibility: "client", body: "Create at $25/day" });
  expect(view.body.exact_change.rows).toEqual(expect.arrayContaining([{ item: "Required wallet coverage", before: "", after: "$300.00" }, { item: "Funding shortfall", before: "", after: "$131.18" }]));
  expect(actions[0].body).toBe(body);
  expect(body.step).not.toHaveProperty("responsibility");
  m.preview.mockRejectedValueOnce(new Error("Account unavailable"));
  const [unavailable] = await decorateProposalFunding("tenant-a", [view], [row]);
  expect(unavailable.body.exact_change.rows.some(r => r.after === "$131.18" || r.after === "$300.00")).toBe(false);
  expect(unavailable.body.exact_change.rows).toContainEqual({ item: "Wallet coverage", before: "", after: "Funding could not be verified. Review again before launch." });
});

it("approve preflight: a short wallet with no envelope reports the shortfall, read for this tenant and card", async () => {
  expect(await chatgptWalletShortfall("tenant", row)).toEqual({ required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 });
  expect(m.tenant).toHaveBeenCalledWith("tenant");
  expect(m.filters).toHaveBeenCalledWith("eq", "id", "card");
  expect(m.filters).toHaveBeenCalledWith("eq", "tenant_id", "tenant");
});

it("approve preflight: an envelope that would fund, a covered wallet, or anything unreadable never blocks", async () => {
  m.single.mockResolvedValueOnce({ data: { approval_envelope: { id: "env" } }, error: null });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
  m.wallet.mockResolvedValueOnce({ ...funds, available_cents: 50000, balance_cents: 50000 });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
  m.wallet.mockResolvedValueOnce({ status: "unavailable" });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
  m.wallet.mockRejectedValueOnce(new Error("down"));
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
  m.single.mockResolvedValueOnce({ data: null, error: { message: "down" } });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
  m.preview.mockResolvedValueOnce({ account: { currency_code: "USD" }, fundingSource: "provider" });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
});

it("approve preflight: an envelope that would not fund (unparseable, another tenant's, no-friction off) is no envelope", async () => {
  const short = { required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 };
  const withEnvelope = () => m.single.mockResolvedValueOnce({ data: { approval_envelope: { id: "env" } }, error: null });
  withEnvelope(); m.parse.mockReturnValueOnce(null);
  expect(await chatgptWalletShortfall("tenant", row)).toEqual(short);
  withEnvelope(); m.parse.mockReturnValueOnce({ tenant_id: "other", actor_user_id: "u" });
  expect(await chatgptWalletShortfall("tenant", row)).toEqual(short);
  withEnvelope(); m.noFriction.mockResolvedValueOnce(false);
  expect(await chatgptWalletShortfall("tenant", row)).toEqual(short);
});

it("approve preflight: checks what the approve RPC accepts (pending or snoozed; never run or a failed retry)", async () => {
  const short = { required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 };
  expect(await chatgptWalletShortfall("tenant", { ...row, status: "snoozed" })).toEqual(short);
  expect(await chatgptWalletShortfall("tenant", { ...row, exec_status: "failed" })).toEqual(short);
  m.single.mockClear();
  for (const r of [{ ...row, exec_status: "queued" }, { ...row, exec_status: "executed" }, { ...row, status: "dismissed" }, { ...row, exec_class: "chatgpt_ads.set_status" }]) {
    expect(await chatgptWalletShortfall("tenant", r)).toBeNull();
  }
  expect(m.single).not.toHaveBeenCalled();
});

it("approve preflight: a wallet-only create is refused even with an envelope that would fund (launch never tops it up)", async () => {
  m.single.mockResolvedValueOnce({ data: { approval_envelope: { id: "env" } }, error: null });
  expect(await chatgptWalletShortfall("tenant", { ...row, exec_payload: { ...row.exec_payload, top_up_authorized: false } })).toEqual({ required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 });
  expect(m.parse).not.toHaveBeenCalled();
});

it("approve preflight: an envelope past its 48-hour funding window does not skip the check", async () => {
  m.single.mockResolvedValueOnce({ data: { approval_envelope: { id: "env" }, proposed_at: new Date(now - 49 * 3600_000).toISOString() }, error: null });
  expect(await chatgptWalletShortfall("tenant", row)).toEqual({ required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 });
  m.single.mockResolvedValueOnce({ data: { approval_envelope: { id: "env" }, proposed_at: new Date(now - 47 * 3600_000).toISOString() }, error: null });
  expect(await chatgptWalletShortfall("tenant", row)).toBeNull();
});

it("approve preflight: prices the account this card's launch already claimed, not just the current selection", async () => {
  await chatgptWalletShortfall("tenant", { ...row, exec_status: "failed" });
  expect(m.preview).toHaveBeenCalledWith("tenant", campaignActionRequestId("card", "growth-campaign"));
});

it("a held card's wallet line follows LIVE funding on the list: a top-up clears it, a short wallet keeps it", async () => {
  const wallet = { words: [CHATGPT_WALLET_SHORT_WORDS], evidence: null, wallet_short: true };
  const both = { words: [CHATGPT_WALLET_SHORT_WORDS, "Pausing is your call"], evidence: "e", wallet_short: true };
  const card = (held: unknown) => [{ id: "card", body: {}, held }] as Array<{ id: string; body: unknown; held: typeof wallet | null }>;
  expect((await decorateProposalFunding("tenant", card(wallet), [row]))[0].held).toEqual(wallet);
  m.wallet.mockResolvedValue({ ...funds, available_cents: 50000, balance_cents: 50000 });
  expect((await decorateProposalFunding("tenant", card(wallet), [row]))[0].held).toBeNull();
  expect((await decorateProposalFunding("tenant", card(both), [row]))[0].held).toEqual({ words: ["Pausing is your call"], evidence: "e", wallet_short: false });
  m.wallet.mockResolvedValue(funds);
  expect((await decorateProposalFunding("tenant", card({ words: ["Pausing is your call"], evidence: null, wallet_short: false }), [row]))[0].held).toMatchObject({ wallet_short: true });
  m.preview.mockRejectedValueOnce(new Error("Account unavailable"));
  expect((await decorateProposalFunding("tenant", card(wallet), [row]))[0].held).toEqual(wallet);
  expect((await decorateProposalFunding("tenant", card(null), [row]))[0].held).toBeNull();
});

it("removes stale funding rows labelled as original by an inline revision", async () => {
  const [view] = await decorateProposalFunding("t", [{ id: "card", body: { exact_change: { rows: [
    { item: "Original proposal · Required wallet coverage", before: "", after: "$999.00" },
    { item: "Original proposal · Funding shortfall", before: "", after: "$888.00" },
  ] } } }], [row]);
  expect(JSON.stringify(view)).not.toMatch(/999|888/);
});
