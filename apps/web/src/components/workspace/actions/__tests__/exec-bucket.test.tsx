// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { execFailureToast } from "../ActionFooter";
import { StatusBanner } from "../StatusBanner";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });
type Over = Partial<Pick<ChannelActionView, "exec_bucket" | "exec_fix_text" | "exec_fix" | "exec_code" | "exec_checkout_url" | "note">>;
let n = 0;
const failed = (over: Over) =>
  makeAction("pause_ad", {
    ...FIXTURES.pause_ad,
    id: `failed-${++n}`,
    exec_status: "failed",
    note: "raw",
    body: { ...FIXTURES.pause_ad.body, action_label: "Pause" },
    ...over,
  });

describe("the red banner by bucket", () => {
  it("needs_founder keeps the fix on the card and says to approve again once it is done", () => {
    const a = failed({ exec_bucket: "needs_founder", exec_fix_text: "reconnect Google Ads in Settings", note: null });
    render(<StatusBanner a={a} platformName="Google Ads" />);
    expect(screen.getByTestId("exec-fix").textContent).toBe("This needs you: reconnect Google Ads in Settings.");
    expect(execFailureToast(a, "Google Ads").description).toBe("Once that's done, approve it again.");
  });
  it("an ad budget refusal says the budget limit was reached and links to the budget, never that the platform refused or to just try again", () => {
    const a = failed({ exec_bucket: "needs_founder", exec_fix: "ad_budget", exec_fix_text: "raise your ad budget on the Growth page, or approve a smaller change", note: "Nothing was sent to Meta Ads." });
    render(<StatusBanner a={a} platformName="Meta Ads" />);
    expect(execFailureToast(a, "Meta Ads")).toEqual({ title: "Budget limit reached", description: "Nothing was sent to Meta Ads." });
    const link = screen.getByTestId("exec-ad-budget");
    expect(link.textContent).toBe("Open ad budget settings");
    expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
    expect(screen.getByTestId("exec-fix").textContent).toBe("This needs you: raise your ad budget on the Growth page, or approve a smaller change.");
    const text = screen.getByTestId("exec-state").textContent ?? "";
    expect(text).not.toContain("did not take the change");
    expect(text).not.toContain("temporary problem");
  });
  it("other founder fixes get no ad budget link", () => {
    const a = failed({ exec_bucket: "needs_founder", exec_fix: "reconnect", exec_fix_text: "reconnect Meta Ads in Settings" });
    render(<StatusBanner a={a} platformName="Meta Ads" />);
    expect(screen.queryByTestId("exec-ad-budget")).toBeNull();
    expect(execFailureToast(a, "Meta Ads").title).toBe("Meta Ads did not take the change");
  });
  it("temporary shows only the title on the card and says try again in the toast", () => {
    const a = failed({ exec_bucket: "temporary", note: null });
    render(<StatusBanner a={a} platformName="Google Ads" />);
    expect(screen.getByTestId("exec-state").getAttribute("data-exec")).toBe("failed");
    expect(screen.getByTestId("exec-title").textContent).toBe("Google Ads did not take the change.");
    expect(screen.queryByTestId("exec-failed-body")).toBeNull();
    expect(execFailureToast(a, "Google Ads").description).toBe("A temporary problem at Google Ads. Try again.");
  });
  it("blocked says we were alerted and promises nothing", () => {
    render(<StatusBanner a={failed({ exec_bucket: "blocked_on_us" })} platformName="Google Ads" />);
    expect(screen.getByText("Google Ads refused this change. We've been alerted; nothing for you to do.")).toBeTruthy();
  });
  it("a ChatGPT launch Zavi archived says so and says to ask again, not that ChatGPT refused", () => {
    render(<StatusBanner a={failed({ exec_bucket: "blocked_on_us", exec_code: "chatgpt_ads_launch_undone" })} platformName="ChatGPT" />);
    const text = screen.getByTestId("exec-state").textContent ?? "";
    expect(text).toContain("Zavi archived this campaign after it could not launch");
    expect(text).toContain("Ask again");
    expect(text).not.toContain("refused");
  });
  it("blocked_on_us does not repeat the server's blocked note under its own hint", () => {
    render(
      <StatusBanner
        a={failed({ exec_bucket: "blocked_on_us", note: "Google Ads refused this change, so Zavi closed the card. We have been alerted." })}
        platformName="Google Ads"
      />,
    );
    expect(screen.queryByTestId("exec-reason")).toBeNull();
  });
  it("a partial_risk verdict reads like a partial-risk code", () => {
    render(<StatusBanner a={failed({ exec_bucket: "partial_risk", exec_code: "google_ads_mutate_incomplete" })} platformName="Google Ads" />);
    expect(screen.getByTestId("exec-state").textContent).toContain("will not run this again");
  });
  it("no bucket (an older server) keeps today's words on the card", () => {
    render(<StatusBanner a={failed({})} platformName="Google Ads" />);
    expect(screen.getByTestId("exec-state").textContent).toContain("Check the account before approving again");
  });
  it("the toast takes only the first sentence of the error", () => {
    const a = failed({ exec_bucket: "temporary", note: "The platform timed out. Nothing changed. Try again later." });
    expect(execFailureToast(a, "Google Ads")).toEqual({ title: "Google Ads did not take the change", description: "The platform timed out." });
  });
});

describe("the ad footer by bucket", () => {
  const gads = platformFor("google_ads");
  it("blocked_on_us offers no Try again", () => {
    render(<ChannelActionCard action={failed({ exec_bucket: "blocked_on_us" })} platform={gads} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
    expect(screen.queryByTestId("exec-partial-link")).toBeNull();
  });
  it.each(["needs_founder", "temporary"] as const)("%s keeps Try again", (bucket) => {
    render(<ChannelActionCard action={failed({ exec_bucket: bucket, exec_fix_text: bucket === "needs_founder" ? "fix billing in Google Ads" : null })} platform={gads} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  });
  it("partial_risk offers no Try again", () => {
    render(<ChannelActionCard action={failed({ exec_bucket: "partial_risk" })} platform={gads} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
  });
});

describe("a creator hire that could not use the saved card", () => {
  it("shows the Stripe Checkout link the card's message points to", () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_abc";
    const a = failed({ exec_bucket: "temporary", exec_code: "creator_hire_checkout", exec_checkout_url: url, note: "Nothing was charged yet. Pay with the link on this card to hire the creator." });
    render(<StatusBanner a={a} platformName="UGC Videos" />);
    const link = screen.getByTestId("exec-checkout");
    expect(link.textContent).toBe("Pay with Stripe Checkout");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("exec-reason").textContent).toBe("Nothing was charged yet. Pay with the link on this card to hire the creator.");
  });

  it("shows no pay link on a failure that has none", () => {
    render(<StatusBanner a={failed({ exec_bucket: "temporary", note: "Timed out." })} platformName="UGC Videos" />);
    expect(screen.queryByTestId("exec-checkout")).toBeNull();
  });
});

describe("a LinkedIn campaign that only a new campaign can fix", () => {
  const li = platformFor("linkedin_ads");
  const liFailed = (exec_code: string) =>
    makeAction("create_ad", {
      ...FIXTURES.create_ad,
      id: `li-failed-${++n}`,
      channel_slug: "linkedin_ads",
      exec_status: "failed",
      exec_bucket: "blocked_on_us",
      exec_code,
      note: null,
    });
  it.each([
    ["linkedin_ads_post_author_refused", "LinkedIn will not run this post as an ad.", "Start a new campaign with a post from the page this ad account advertises for."],
    ["linkedin_ads_account_changed", "The ad account changed after review.", "Start a new campaign and review it again."],
  ])("%s offers no Try again and says to start a new campaign", (code, title, hint) => {
    const a = liFailed(code);
    render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    cleanup();
    render(<StatusBanner a={a} platformName="LinkedIn" />);
    expect(screen.getByTestId("exec-title").textContent).toBe(title);
    const text = screen.getByTestId("exec-state").textContent ?? "";
    expect(text).toContain(hint);
    expect(text).not.toContain("nothing for you to do");
    expect(text).not.toContain("Try again");
  });
});

describe("a LinkedIn campaign that stopped partway", () => {
  const li = platformFor("linkedin_ads");
  const partial = (over: Partial<ChannelActionView>) =>
    makeAction("create_ad", { ...FIXTURES.create_ad, id: `li-partial-${++n}`, channel_slug: "linkedin_ads", exec_status: "failed", exec_bucket: "partial_risk", exec_code: "exec_partial", note: "Zavi could not finish this campaign.", ...over });
  it("in Zavi's shared wallet account offers no Campaign Manager button the founder cannot open", () => {
    render(<ChannelActionCard action={partial({ exec_managed: true })} platform={li} handlers={handlers()} />);
    expect(screen.queryByTestId("exec-partial-link")).toBeNull();
    expect(screen.queryByText(/Open Campaign Manager/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
  });
  it("on the founder's own billing keeps the Campaign Manager button", () => {
    render(<ChannelActionCard action={partial({})} platform={li} handlers={handlers()} />);
    expect(screen.getByTestId("exec-partial-link").textContent).toBe("Open Campaign Manager");
  });
  it("whose post was deleted says so on the closed card instead of the other-page hint", () => {
    const note = "The post this campaign promotes is no longer on LinkedIn, so Zavi stopped and closed this card. Zavi archived the paused campaign and campaign group it had already made, so nothing can spend. Start a new campaign with a post that is still on LinkedIn.";
    const a = partial({ exec_bucket: "blocked_on_us", exec_code: "linkedin_ads_post_author_refused", note });
    render(<StatusBanner a={a} platformName="LinkedIn" />);
    const text = screen.getByTestId("exec-state").textContent ?? "";
    expect(text).toContain("no longer on LinkedIn");
    expect(text).not.toContain("a post from the page this ad account advertises for");
  });
});

describe("a LinkedIn create that hit a limit or lost the shared wallet permission", () => {
  it.each([
    ["linkedin_ads_daily_limit", "LinkedIn's daily limit is used up."],
    ["linkedin_ads_rate_limited", "LinkedIn asked Zavi to slow down."],
    ["linkedin_ads_wallet_consent_withdrawn", "Shared wallet permission was withdrawn."],
  ])("%s gets its own title, never that LinkedIn refused the change", (exec_code, title) => {
    const a = makeAction("create_ad", { ...FIXTURES.create_ad, id: `li-limit-${++n}`, channel_slug: "linkedin_ads", exec_status: "failed", exec_bucket: "temporary", exec_code, note: "x" });
    render(<StatusBanner a={a} platformName="LinkedIn" execCopy={platformFor("linkedin_ads").execCopy} />);
    expect(screen.getByTestId("exec-title").textContent).toBe(title);
  });
});
