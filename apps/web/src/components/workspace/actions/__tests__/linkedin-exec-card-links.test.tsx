// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChannelActionBody, ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { buildLinkedInBudgetCardBody, buildLinkedInDuplicateCardBody } from "../../../../../../backend/src/services/tools/linkedin-ads/_change-bodies";

const h = vi.hoisted(() => ({ payload: null as unknown }));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: h.payload, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelActionCard } from "../ChannelActionCard";
import { ChannelMetricsRow } from "../ChannelMetricsRow";
import { AdPublishingBlocker } from "../ads/AdPublishingBlocker";
import { setCampaignLinks, setChannelAccount } from "../campaignLinks";
import { linkedin_ads } from "../platforms/linkedin_ads";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const CARD_ACCOUNT = "508412345";
const OTHER_ACCOUNT = "559880687";
const BARE = "https://www.linkedin.com/campaignmanager/accounts";
const campaignsOf = (id: string) => `${BARE}/${id}/campaigns`;
const summaryOf = (id: string, campaign: string) => `${BARE}/${id}/campaigns/${campaign}/summary`;
const billingOf = (id: string) => `${BARE}/${id}/billing`;
const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const campaignRow = (account: string) => ({
  id: "900111",
  ad_account_id: account,
  funding_source: "provider",
  currency: "USD",
  name: "Q4 Launch",
  status: "PAUSED",
  campaign_group: null,
  daily_budget: 50,
  ad_delivery: null,
  ads_not_running: 0,
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  leads: 0,
  conversion_value: 0,
  cpa: null,
  url: campaignsOf(account),
});
const payload = (account: { id: string | null; account_count: number }, campaigns: unknown[] = []) => ({
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-10-07", to: "2026-11-05" },
  account: { name: "Main", campaign_count: campaigns.length, active_count: 0, currency: "USD", ...account },
  totals: zero,
  prev_totals: zero,
  campaigns,
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });
const dashboard = () =>
  render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors onActionsChanged={vi.fn()} />);
const card = (a: ChannelActionView) => render(<ChannelActionCard action={a} platform={linkedin_ads} handlers={handlers()} />);

const duplicateCard = (): ChannelActionView => {
  const { title, card: body } = buildLinkedInDuplicateCardBody({
    target: "campaign",
    source_id: "900111",
    account_id: CARD_ACCOUNT,
    source_name: "Q4 Launch",
    new_name: "Q4 Launch copy",
    group_id: "700222",
    campaign_id: null,
    copy_ads: true,
    source_last_modified_at: null,
    rationale: "The original is spending well; a copy lets Zavi test a second audience.",
  });
  return makeAction("create_ad", { id: "li-dup", channel_slug: "linkedin_ads", executable: true, title, body: body as unknown as ChannelActionBody });
};

const failedBudgetCard = (over: Partial<ChannelActionView> = {}): ChannelActionView => {
  const { title, card: body } = buildLinkedInBudgetCardBody({
    campaign_id: "900111",
    account_id: CARD_ACCOUNT,
    name: "Q4 Launch",
    kind: "daily",
    expected_current: { amount: "50.00", currency: "USD" },
    proposed: { amount: "75.00", currency: "USD" },
    rationale: "It hits its cap by noon every day.",
  });
  return makeAction("update_ad", {
    id: "li-budget",
    channel_slug: "linkedin_ads",
    executable: true,
    title,
    body: body as unknown as ChannelActionBody,
    exec_status: "failed",
    exec_bucket: "partial_risk",
    exec_code: "exec_partial",
    note: "LinkedIn did not answer in time.",
    ...over,
  });
};

const failedBundleCard = (): ChannelActionView =>
  makeAction("create_ad", {
    id: "li-bundle",
    channel_slug: "linkedin_ads",
    executable: true,
    title: "Sponsor the company post",
    body: { change_sentence: "Zavi creates the campaign paused.", exact_change: { rows: [{ item: "Campaign", before: "None", after: "Paused" }] } },
    exec_status: "failed",
    exec_bucket: "partial_risk",
    exec_code: "exec_partial",
    note: "Zavi could not finish this campaign.",
  });

beforeEach(() => {
  h.payload = null;
  setChannelAccount("linkedin_ads", null);
  setCampaignLinks("linkedin_ads", {});
});
afterEach(cleanup);

describe("LinkedIn Ads change cards never point at the bare account list", () => {
  it.each([CARD_ACCOUNT, OTHER_ACCOUNT])("a copy card on the shared card links nowhere outside its own account (dashboard on %s)", (dashboardAccount) => {
    h.payload = payload({ id: dashboardAccount === CARD_ACCOUNT ? null : dashboardAccount, account_count: dashboardAccount === CARD_ACCOUNT ? 2 : 1 }, [campaignRow(CARD_ACCOUNT)]);
    dashboard();
    card(duplicateCard());
    expect(screen.getAllByText(/Q4 Launch copy/).length).toBeGreaterThan(0);
    const all = screen.queryAllByRole("link").map((l) => l.getAttribute("href"));
    expect(all).not.toContain(BARE);
  });
});

describe("LinkedIn Ads: a change that stopped partway opens the right account to check", () => {
  it("a budget change on the founder's own account opens that campaign's own page", () => {
    h.payload = payload({ id: null, account_count: 2 });
    dashboard();
    card(failedBudgetCard());
    const a = screen.getByTestId("exec-partial-link");
    expect(a.textContent).toBe("Open Campaign Manager");
    expect(a.getAttribute("href")).toBe(summaryOf(CARD_ACCOUNT, "900111"));
  });

  it("the card's account wins over the dashboard's account", () => {
    h.payload = payload({ id: OTHER_ACCOUNT, account_count: 1 });
    dashboard();
    card(failedBudgetCard());
    expect(screen.getByTestId("exec-partial-link").getAttribute("href")).toBe(summaryOf(CARD_ACCOUNT, "900111"));
  });

  it("a campaign create whose body names no account opens the one account the channel uses", () => {
    h.payload = payload({ id: OTHER_ACCOUNT, account_count: 1 });
    dashboard();
    card(failedBundleCard());
    expect(screen.getByTestId("exec-partial-link").getAttribute("href")).toBe(campaignsOf(OTHER_ACCOUNT));
  });

  it("with no account anywhere it still opens the account list", () => {
    card(failedBundleCard());
    expect(screen.getByTestId("exec-partial-link").getAttribute("href")).toBe(BARE);
  });

  it("a shared-wallet card still offers no Campaign Manager link at all", () => {
    h.payload = payload({ id: OTHER_ACCOUNT, account_count: 1 });
    dashboard();
    card(failedBudgetCard({ exec_managed: true }));
    expect(screen.queryByTestId("exec-partial-link")).toBeNull();
  });
});

describe("LinkedIn Ads: Fix it on a billing refusal opens the card's ad account", () => {
  const billingFailure = (): ChannelActionView =>
    failedBudgetCard({ exec_bucket: "needs_founder", exec_code: null, exec_fix: "billing", exec_fix_text: "fix billing in LinkedIn Ads" });

  it("links to the billing page of the card's account, not the campaign list or the account list", () => {
    render(<AdPublishingBlocker action={billingFailure()} platform={linkedin_ads} />);
    expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe(billingOf(CARD_ACCOUNT));
  });

  it("falls back to the dashboard's account when the card names none", () => {
    h.payload = payload({ id: OTHER_ACCOUNT, account_count: 1 });
    dashboard();
    const a = { ...billingFailure(), body: { change_sentence: "x" } };
    render(<AdPublishingBlocker action={a} platform={linkedin_ads} />);
    expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe(billingOf(OTHER_ACCOUNT));
  });
});

describe("LinkedIn Ads: a card links where LinkedIn can, and says where to look where it cannot", () => {
  it("a forged link on a card is never used as the Campaign Manager link", () => {
    const a = failedBudgetCard();
    const forged = { ...a, body: { ...(a.body as object), link: "https://evil.example/campaignmanager/accounts/1/campaigns/2/summary" } as unknown as ChannelActionBody };
    card(forged);
    const href = screen.getByTestId("exec-partial-link").getAttribute("href");
    expect(href).toBe(BARE);
    expect(href).not.toContain("evil");
  });

  it("a copy card, which has no campaign of its own yet, tells the founder where the paused copy will be", () => {
    card(duplicateCard());
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(screen.getAllByText(/Where to find it in LinkedIn/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Find the paused copy "Q4 Launch copy" there once created');
  });
});
