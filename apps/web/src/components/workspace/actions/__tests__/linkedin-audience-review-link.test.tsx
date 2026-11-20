// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const h = vi.hoisted(() => ({ payload: null as unknown }));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: h.payload, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelActionCard } from "../ChannelActionCard";
import { AdsPresentation } from "../ads/AdsPresentation";
import { Check } from "../bodies/Check";
import { AUDIENCE_READ_STEPS, AUDIENCE_REVIEW_STEPS } from "../audienceReview";
import { primaryOf as cardPrimary } from "../card/cardPrimary";
import { ChannelMetricsRow } from "../ChannelMetricsRow";
import { setChannelAccount } from "../campaignLinks";
import { linkedin_ads } from "../platforms/linkedin_ads";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const ACCOUNT = "559880687";
const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = (account: { id?: string | null; account_count: number }) => ({
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-29", to: "2026-10-28" },
  account: { name: "Main", campaign_count: 0, active_count: 0, currency: "USD", ...account },
  totals: zero,
  prev_totals: zero,
  campaigns: [],
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const audienceCard = (): ChannelActionView =>
  makeAction("check", {
    channel_slug: "linkedin_ads",
    title: "Save two LinkedIn audiences for if the verdict flips",
    body: { step: { title: "Save two LinkedIn audiences for if the verdict flips", body: "Two audiences typed for Campaign Manager.", target: { kind: "audience", ref: "Ops leads, 50-500" } } },
    card_kind: "task",
    primary_label: "Review audience",
    done_label: "I reviewed it",
    how_to: ["Open Campaign Manager audiences.", "Save both audiences."],
  });

const insightTagCard = (): ChannelActionView =>
  makeAction("check", {
    channel_slug: "linkedin_ads",
    title: "Check whether the LinkedIn Insight Tag is on the site",
    body: { step: { title: "Check whether the LinkedIn Insight Tag is on the site", body: "Why.", target: { kind: "tracking", ref: "Insight Tag" } } },
    card_kind: "task",
    primary_label: "Verify",
    done_label: "It works",
    how_to: ["Open the site.", "Look for the tag."],
  });

const dashboard = () =>
  render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors onActionsChanged={vi.fn()} />);
const card = (a: ChannelActionView, hs: ActionHandlers = handlers()) => render(<ChannelActionCard action={a} platform={linkedin_ads} handlers={hs} />);
const hrefOf = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href") ?? "";

const opensCampaignCreation = (href: string) => {
  const u = new URL(href);
  return u.pathname === "/campaignmanager" || u.pathname === "/campaignmanager/" || /\/campaigns(\/|$)|\/new(\/|$)|create/i.test(u.pathname);
};

beforeEach(() => {
  h.payload = null;
  setChannelAccount("linkedin_ads", null);
});
afterEach(cleanup);

describe("LinkedIn Ads: an audience review opens the account's audiences page", () => {
  it("Review audience opens the Saved audiences tab for the connected account, not Campaign Manager's root", () => {
    h.payload = payload({ id: ACCOUNT, account_count: 1 });
    dashboard();
    card(audienceCard());
    const href = hrefOf(/Review audience/);
    expect(href).toBe(`https://www.linkedin.com/campaignmanager/accounts/${ACCOUNT}/audiences/saved`);
    expect(opensCampaignCreation(href)).toBe(false);
  });

  it("a card on screen before the account is read moves to the audiences page once the read lands", () => {
    card(audienceCard());
    expect(hrefOf(/Review audience/)).toBe("https://www.linkedin.com/campaignmanager/accounts");
    h.payload = payload({ id: ACCOUNT, account_count: 1 });
    act(() => {
      dashboard();
    });
    expect(hrefOf(/Review audience/)).toBe(`https://www.linkedin.com/campaignmanager/accounts/${ACCOUNT}/audiences/saved`);
  });

  it("with no single account to name, the card opens the account list, never the root that starts a campaign", () => {
    h.payload = payload({ id: null, account_count: 2 });
    dashboard();
    card(audienceCard());
    const href = hrefOf(/Review audience/);
    expect(href).toBe("https://www.linkedin.com/campaignmanager/accounts");
    expect(opensCampaignCreation(href)).toBe(false);
  });

  it("an account id that is not LinkedIn's numeric id is not spliced into the link", () => {
    h.payload = payload({ id: "../campaigns/new", account_count: 1 });
    dashboard();
    card(audienceCard());
    expect(hrefOf(/Review audience/)).toBe("https://www.linkedin.com/campaignmanager/accounts");
  });

  it("Verify on the Insight Tag card opens the account's Insight Tag page", () => {
    h.payload = payload({ id: ACCOUNT, account_count: 1 });
    dashboard();
    card(insightTagCard());
    const href = hrefOf(/Verify/);
    expect(href).toBe(`https://www.linkedin.com/campaignmanager/accounts/${ACCOUNT}/insight-tag`);
    expect(opensCampaignCreation(href)).toBe(false);
  });

  it("Verify with no single account falls back to the account list", () => {
    h.payload = payload({ id: null, account_count: 2 });
    dashboard();
    card(insightTagCard());
    expect(hrefOf(/Verify/)).toBe("https://www.linkedin.com/campaignmanager/accounts");
  });

  it("Verify with a non-numeric account id does not splice it into the link", () => {
    h.payload = payload({ id: "../campaigns/new", account_count: 1 });
    dashboard();
    card(insightTagCard());
    expect(hrefOf(/Verify/)).toBe("https://www.linkedin.com/campaignmanager/accounts");
  });

  it("the audience link is unchanged next to the Insight Tag link", () => {
    h.payload = payload({ id: ACCOUNT, account_count: 1 });
    dashboard();
    card(audienceCard());
    expect(hrefOf(/Review audience/)).toBe(`https://www.linkedin.com/campaignmanager/accounts/${ACCOUNT}/audiences/saved`);
  });

  it("the partial-exec link points at the account list too", () => {
    expect(opensCampaignCreation(linkedin_ads.execPartial!.href)).toBe(false);
    expect(opensCampaignCreation(linkedin_ads.manageUrl!)).toBe(false);
  });
});

const FOUNDER_ACCOUNT = "558561881";
const FOUNDER_SHEET = [
  "AUDIENCE 1: hearing-care professionals LinkedIn can find by job and industry",
  "Locations:      [fill in: the countries you serve]",
  "Industries:     Hospitals and Health Care; Medical Practices",
  "Job titles:     Audiologist; Hearing Aid Specialist",
  "Audience Expansion: OFF    LinkedIn Audience Network: OFF",
  "Size: read the estimate Campaign Manager shows. We cannot see it.",
  "",
  "AUDIENCE 2: people who visited your site (retargeting, needs the Insight Tag firing first)",
  "Source:        Website visitors, from the Insight Tag",
  "Window:        [fill in: the visit window you want]",
  "Audience Expansion: OFF    LinkedIn Audience Network: OFF",
].join("\n");

const founderCard = (step: Record<string, unknown> = {}): ChannelActionView =>
  makeAction("check", {
    id: "aud-founder",
    channel_slug: "linkedin_ads",
    title: "Two audiences to test once tracking works",
    executable: false,
    card_kind: "task",
    primary_label: "Review it",
    done_label: "I reviewed it",
    how_to: ["Read the size estimate Campaign Manager shows, we cannot see it.", "Check LinkedIn ads policy on health-related ads before building."],
    body: {
      step: {
        title: "Two audiences to test once tracking works",
        body: "Save two audiences in Campaign Manager for when the verdict flips.",
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "list", label: "Two LinkedIn audiences, typed for Campaign Manager", content: FOUNDER_SHEET },
        ...step,
      },
    },
  });

const primaryOf = (root: HTMLElement) => root.querySelector<HTMLAnchorElement>('a[target="_blank"]');
const linkedinLinks = () => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((el) => /linkedin\.com/i.test(el.getAttribute("href") ?? ""));
const pressed = (steps: string[]) => steps.flatMap((s) => Array.from(s.matchAll(/\bPress ([^.]+)\./g), (m) => m[1]));
const stepsShown = () => {
  fireEvent.click(screen.getByRole("button", { name: /How it works/ }));
  return Array.from(document.querySelectorAll("ol li"), (li) => li.textContent ?? "");
};
const adsCard = (a: ChannelActionView, hs: ActionHandlers = handlers()) => {
  const props = { action: a, handlers: hs, platform: linkedin_ads };
  return render(
    <AdsPresentation value={props}>
      <ChannelActionCard {...props} />
    </AdsPresentation>,
  );
};

describe("LinkedIn Ads: the founder's audience list is a review card", () => {
  let open: MockInstance;
  beforeEach(() => {
    open = vi.spyOn(window, "open").mockImplementation(() => null);
  });
  afterEach(() => open.mockRestore());

  it.each([
    ["plain", card],
    ["ads presentation", adsCard],
  ])("must catch (%s): no control on the card goes to LinkedIn, with the account known, written on the card, or missing", (_name, mount) => {
    const cases: Array<[string | null, Record<string, unknown>]> = [
      [FOUNDER_ACCOUNT, {}],
      [null, { evidence: [`Account: https://www.linkedin.com/campaignmanager/accounts/${FOUNDER_ACCOUNT}/campaigns`] }],
      [null, {}],
      [FOUNDER_ACCOUNT, { target: { kind: "audience", ref: "Ops leads" } }],
    ];
    for (const [account, step] of cases) {
      h.payload = account ? payload({ id: account, account_count: 1 }) : null;
      setChannelAccount("linkedin_ads", null);
      if (account) dashboard();
      const { container } = mount(founderCard(step));
      expect(primaryOf(container)).toBeNull();
      expect(linkedinLinks()).toEqual([]);
      expect(screen.queryByText(/Open Campaign Manager/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      expect(linkedinLinks()).toEqual([]);
      expect(screen.queryByRole("menuitem", { name: /Campaign Manager|LinkedIn/i })).toBeNull();
      cleanup();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("must catch: every Press step names a button the card renders, and the stored click path is not shown", () => {
    h.payload = payload({ id: FOUNDER_ACCOUNT, account_count: 1 });
    dashboard();
    const cases: Array<[ActionHandlers, readonly string[], string]> = [
      [{ ...handlers(), onCreateAudiences: vi.fn() }, AUDIENCE_REVIEW_STEPS, "Create audience"],
      [handlers(), AUDIENCE_READ_STEPS, "I reviewed it"],
    ];
    for (const [hs, expected, button] of cases) {
      card({ ...founderCard(), primary_label: "Review it", how_to: ["In Campaign Manager open Plan > Audiences > Create, set facets, Save.", "Press Open Campaign Manager."] }, hs);
      const steps = stepsShown();
      expect(steps).toEqual([...expected]);
      expect(steps.join(" ")).not.toMatch(/Plan >|Campaign Manager/);
      const names = pressed(steps);
      expect(names).toEqual([button]);
      for (const name of names) expect(screen.getAllByRole("button", { name })).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "What it is" }));
      const about = document.querySelector('dialog[aria-label="Details"]')?.textContent ?? "";
      for (const step of expected) expect(about).toContain(step);
      expect(about).not.toMatch(/Plan > Audiences|Press Open Campaign Manager/);
      for (const name of pressed([about])) expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it.each([
    ["plain", card],
    ["ads presentation", adsCard],
  ])("must catch (%s): one press of Create audience sends the card's text once, marks nothing by hand, and shows what was saved", async (_name, mount) => {
    let finish: (v: { ok: true; line: string }) => void = () => {};
    const onCreateAudiences = vi.fn((_a: ChannelActionView, _content: string | null) => new Promise<{ ok: true; line: string }>((resolve) => { finish = resolve; }));
    const hs = { ...handlers(), onCreateAudiences };
    mount(founderCard(), hs);
    const button = screen.getByRole("button", { name: "Create audience" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(onCreateAudiences).toHaveBeenCalledTimes(1);
    expect(onCreateAudiences.mock.calls[0][1]).toBe(FOUNDER_SHEET);
    const working = screen.getByTestId("create-audience");
    expect(working.textContent).toBe("Creating…");
    expect(working.getAttribute("aria-busy")).toBe("true");
    expect(working.querySelector("[data-testid=primary-spinner]")).not.toBeNull();
    await act(async () => finish({ ok: true, line: 'Saved to LinkedIn on Main: "Zavi 1". Not saved, because a LinkedIn saved audience cannot hold them: Students.' }));
    const said = screen.getAllByRole("status").map((n) => n.textContent).join(" ");
    expect(said).toContain("Saved to LinkedIn");
    expect(said).not.toContain("Zavi 1");
    expect(document.body.textContent).not.toContain("Not saved, because");
    expect(screen.queryByRole("button", { name: "Create audience" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(hs.onSetStatus).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["plain", card],
    ["ads presentation", adsCard],
  ])("must catch (%s): a refusal shows LinkedIn's reason on the card and leaves Create audience there to press again", async (_name, mount) => {
    const said = 'Audience 2 was not saved. LinkedIn did not accept this saved audience. LinkedIn said: "too small".';
    const onCreateAudiences = vi.fn(async () => ({ ok: false as const, message: said }));
    const hs = { ...handlers(), onCreateAudiences };
    mount(founderCard(), hs);
    fireEvent.click(screen.getByRole("button", { name: "Create audience" }));
    await act(async () => {});
    expect(screen.getByTestId("primary-hint").textContent).toBe(said);
    expect(hs.onSetStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create audience" }));
    await act(async () => {});
    expect(onCreateAudiences).toHaveBeenCalledTimes(2);
  });

  it("must catch: a list fixed with Edit is what the card shows and what Create audience sends", async () => {
    const onCreateAudiences = vi.fn(async (_a: ChannelActionView, _content: string | null) => ({ ok: true as const, line: "Saved to LinkedIn." }));
    const proto = HTMLDialogElement.prototype;
    const real = { showModal: proto.showModal, close: proto.close };
    proto.showModal = function () { this.setAttribute("open", ""); };
    proto.close = function () { this.removeAttribute("open"); };
    onTestFinished(() => void Object.assign(proto, real));
    card(founderCard(), { ...handlers(), onCreateAudiences });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    const fixed = FOUNDER_SHEET.replace("Hospitals and Health Care; Medical Practices", "Dental Wizardry Clinics");
    const box = document.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(box, { target: { value: fixed } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(document.body.textContent).toContain("Dental Wizardry Clinics");
    expect(document.body.textContent).not.toContain("Medical Practices");
    fireEvent.click(screen.getByRole("button", { name: "Create audience" }));
    await act(async () => {});
    expect(onCreateAudiences.mock.calls[0][1]).toBe(fixed);
  });

  it("must catch: on a screen that cannot save to LinkedIn, one press of I reviewed it marks the card acted and opens nothing", async () => {
    const hs = handlers();
    card(founderCard(), hs);
    fireEvent.click(screen.getByRole("button", { name: "I reviewed it" }));
    await act(async () => {});
    expect(hs.onSetStatus).toHaveBeenCalledTimes(1);
    expect((hs.onSetStatus as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("acted");
    expect(open).not.toHaveBeenCalled();
  });

  it("the shared primary spec: a review card is one done button with no link, whatever the stored words", () => {
    const words = { network: "LinkedIn Ads", executed: () => "x", manageUrl: linkedin_ads.manageUrl, taskHref: "https://www.linkedin.com/campaignmanager/accounts/1/audiences/saved", taskLabel: "Open Campaign Manager" };
    for (const over of [{}, { primary_label: "Copy", card_kind: "copy_to_site" as const }, { primary_label: "Review audience", done_label: "I saved them" }]) {
      const spec = cardPrimary({ ...founderCard(), ...over }, handlers(), words);
      expect(spec).toMatchObject({ mode: "done", label: "I reviewed it", resolved: "I reviewed it" });
      expect(spec?.href ?? null).toBeNull();
      const create = cardPrimary({ ...founderCard(), ...over }, { ...handlers(), onCreateAudiences: vi.fn() }, words);
      expect(create).toMatchObject({ mode: "audience", label: "Create audience", undo: false, text: FOUNDER_SHEET });
      expect(create?.href ?? null).toBeNull();
    }
  });

  it("must-not-touch: a LinkedIn task with no audience list still opens the account, and keeps its Press step", () => {
    h.payload = payload({ id: FOUNDER_ACCOUNT, account_count: 1 });
    dashboard();
    const { container } = card(founderCard({ target: { kind: "other", ref: "verdict" }, deliverable: undefined }));
    const a = primaryOf(container)!;
    expect(a.getAttribute("href")).toBe(`https://www.linkedin.com/campaignmanager/accounts/${FOUNDER_ACCOUNT}/campaigns`);
    expect(a.textContent).toBe("Open Campaign Manager");
    expect(stepsShown()).toContain("Press Open Campaign Manager.");
  });

  it("must-not-touch: the same audience list on another paid channel, and a LinkedIn executable card, keep their own primary", () => {
    const words = { network: "x", executed: () => "x", manageUrl: "https://example.com/manage", taskHref: null, taskLabel: null };
    const meta = cardPrimary({ ...founderCard(), channel_slug: "meta_ads" }, handlers(), words);
    expect(meta).toMatchObject({ mode: "external", href: "https://example.com/manage", label: "Review it" });
    const exec = cardPrimary({ ...founderCard(), executable: true, action_type: "pause_ad", primary_label: "Pause" }, handlers(), words);
    expect(exec).toMatchObject({ mode: "approve", label: "Pause" });
    const sheet = { label: "Campaign", content: FOUNDER_SHEET };
    const brief = cardPrimary(founderCard({ deliverable: { kind: "brief", ...sheet } }), handlers(), words);
    expect(brief).toMatchObject({ mode: "external", label: "Review it" });
    const draft = founderCard({ deliverable: { kind: "list", ...sheet, presentation: { type: "campaign_draft" } } });
    expect(cardPrimary(draft, { ...handlers(), onReviewExecute: vi.fn() }, words)).toMatchObject({ mode: "review", label: "Review and create" });
    expect(cardPrimary(draft, handlers(), words)).toMatchObject({ mode: "external", label: "Review it" });
  });

  it("must catch: the split card body gives the audience list no LinkedIn link either, and keeps it on a task with no list", () => {
    h.payload = payload({ id: FOUNDER_ACCOUNT, account_count: 1 });
    dashboard();
    const first = render(<Check action={founderCard()} platform={linkedin_ads} handlers={handlers()} />);
    expect(screen.getAllByTestId("audience-block")).toHaveLength(2);
    expect(linkedinLinks()).toEqual([]);
    first.unmount();
    render(<Check action={founderCard({ target: { kind: "other", ref: "verdict" }, deliverable: undefined })} platform={linkedin_ads} handlers={handlers()} />);
    expect(linkedinLinks().map((el) => el.getAttribute("href"))).toContain(`https://www.linkedin.com/campaignmanager/accounts/${FOUNDER_ACCOUNT}/campaigns`);
  });

  it("a specific stored label is kept: Review audience is not renamed", () => {
    h.payload = payload({ id: ACCOUNT, account_count: 1 });
    dashboard();
    card(audienceCard());
    expect(screen.getByRole("link", { name: /Review audience/ })).toBeTruthy();
  });
});
