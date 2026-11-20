// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "@/components/ui/toast";
import type { CardApproval, CardTimelineEvent, ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { resetExecFailureToasts } from "../ActionFooter";
import { AdsPresentation } from "../ads/AdsPresentation";
import { CardHistoryDrawer } from "../CardHistoryDrawer";
import { StatusBanner } from "../StatusBanner";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

vi.mock("../managed-campaigns/api", async (orig) => ({
  ...(await orig<typeof import("../managed-campaigns/api")>()),
  campaignFetch: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id }: { id: string }) => <div data-testid="email-card" data-id={id} />,
}));

const NOW = new Date("2026-10-19T22:10:00Z");
const APPROVED_AT = "2026-10-19T22:06:00Z";
const APPLIED_AT = "2026-10-19T22:07:00Z";
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetExecFailureToasts();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const handlers = (over: Partial<ActionHandlers> = {}): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn(), ...over });
const you: CardApproval = { by: "you", name: null, at: APPROVED_AT };
const timeline: CardTimelineEvent[] = [
  { kind: "proposed", at: "2026-10-19T14:31:00Z" },
  { kind: "approved", at: APPROVED_AT, by: "you" },
  { kind: "sent", at: APPROVED_AT },
  { kind: "executed", at: APPLIED_AT },
];

const meta = platformFor("meta_ads");
const metaBudget = (over: Partial<ChannelActionView> = {}) =>
  makeAction("update_ad", {
    ...FIXTURES.update_ad,
    id: "meta-budget",
    channel_slug: "meta_ads",
    title: "Raise the daily budget from $120 to $149",
    executable: true,
    approval: you,
    ...over,
  });

function renderAd(action: ChannelActionView, h: ActionHandlers = handlers()) {
  return render(
    <AdsPresentation value={{ action, handlers: h, platform: meta }}>
      <ChannelActionCard action={action} handlers={h} platform={meta} />
    </AdsPresentation>,
  );
}

const banner = () => screen.getByTestId("exec-state");
const title = () => screen.getByTestId("exec-title").textContent;

it("a completed TikTok change confirms execution without claiming current delivery", () => {
  render(<StatusBanner a={metaBudget({ channel_slug: "tiktok_ads", exec_status: "executed" })} platformName="TikTok Ads" />);
  expect(title()).toBe("Applied in TikTok Ads.");
});

describe("an ad card (Meta Ads budget) shows its state inline, with no strip", () => {
  const state = () => screen.getByTestId("exec-state");

  it("queued: the footer says it is being made, the body dims and nothing can be pressed", () => {
    renderAd(metaBudget({ exec_status: "queued" }));
    expect(state().getAttribute("data-exec")).toBe("queued");
    expect(state().textContent).toBe("Zavi is making this change now.");
    expect(screen.queryByTestId("exec-steps")).toBeNull();
    expect(screen.getByTestId("split-left").className).toContain("opacity-60");
    expect(screen.queryByRole("button", { name: /Approve|Try again/ })).toBeNull();
  });

  it("dispatching: no strip sits above the card body", () => {
    renderAd(metaBudget({ exec_status: "dispatching", exec_started_at: minutesAgo(1) }));
    const card = screen.getByTestId("action-meta-budget");
    expect(card.firstElementChild?.getAttribute("data-testid")).toBe("split-grid");
  });

  it("slow after 20 minutes since the worker picked it up: says so, no Try again", () => {
    renderAd(metaBudget({ exec_status: "dispatching", exec_started_at: minutesAgo(25) }));
    expect(state().textContent).toBe("Taking longer than usual. Zavi is still on it.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("queued uses the approve time as its clock", () => {
    renderAd(metaBudget({ exec_status: "queued", approval: { ...you, at: minutesAgo(25) } }));
    expect(state().textContent).toBe("Taking longer than usual. Zavi is still on it.");
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
  });

  it("queued over 30 minutes after the approval was never picked up: says nothing was sent and offers Close", () => {
    const onSetStatus = vi.fn(async () => true);
    renderAd(metaBudget({ exec_status: "queued", approval: { ...you, at: minutesAgo(45) } }), handlers({ onSetStatus }));
    expect(state().textContent).toBe("Zavi never started this change, so nothing was sent. Close this card.");
    expect(screen.getByTestId("split-left").className).not.toContain("opacity-60");
    expect(screen.queryByRole("button", { name: /Approve|Try again/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    expect(onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "meta-budget" }), "rejected", expect.objectContaining({ keep: true }));
  });

  it("a change a worker is making is never closable, however long it takes", () => {
    renderAd(metaBudget({ exec_status: "dispatching", exec_started_at: minutesAgo(90), approval: { ...you, at: minutesAgo(95) } }));
    expect(state().textContent).toBe("Taking longer than usual. Zavi is still on it.");
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
  });

  it("the banner (non-inline) says the same for a stranded card", () => {
    render(<StatusBanner a={metaBudget({ exec_status: "queued", approval: { ...you, at: minutesAgo(45) } })} platformName="Meta Ads" />);
    expect(banner().getAttribute("data-exec")).toBe("stranded");
    expect(banner().textContent).toBe("Zavi never started this change, so nothing was sent. Close this card.");
  });

  it("with no clock at all it is never called slow", () => {
    renderAd(metaBudget({ exec_status: "dispatching", approval: null, exec_started_at: null }));
    expect(state().textContent).toBe("Zavi is making this change now.");
  });

  it("Approve locks at once, and a second approve is impossible", async () => {
    let answer: (ok: boolean) => void = () => {};
    const onApprove = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    renderAd(metaBudget({ approval: null }), handlers({ onApprove }));
    const approve = screen.getAllByRole("button", { name: /Approve|Apply|Raise/ }).find((button) => button.hasAttribute("data-approve"));
    if (!approve) throw new Error("Missing approve control");
    fireEvent.click(approve);
    expect(state().getAttribute("data-exec")).toBe("approving");
    expect(state().textContent).toBe("Approving…");
    const again = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-approve"));
    expect(again.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => answer(false));
    expect(screen.queryByTestId("exec-state")).toBeNull();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("executed: one green line with who approved, and the test line under it", () => {
    renderAd(
      metaBudget({
        exec_status: "executed",
        status: "acted",
        executed_at: APPLIED_AT,
        exec_receipt: { line: "Meta confirmed $149/day", url: "https://business.facebook.com/adsmanager" },
        outcome: { readout_on: "2026-10-27", success_if: "cost per purchase at or under $75" },
        timeline,
      }),
    );
    expect(state().getAttribute("data-exec")).toBe("executed");
    expect(screen.getByRole("status").textContent).toBe(`Updated in Meta Ads · You approved at ${time(APPROVED_AT)}`);
    expect(screen.getByTestId("exec-outcome").textContent).toContain("checking results Oct 27");
    expect(screen.queryByTestId("exec-title")).toBeNull();
    expect(screen.getByTestId("split-left").className).not.toContain("opacity-60");
  });

  it("executed with no approver says only that it changed", () => {
    renderAd(metaBudget({ exec_status: "executed", status: "acted", approval: null, executed_at: null }));
    expect(screen.getByRole("status").textContent).toBe("Updated in Meta Ads");
  });

  it.each([
    [{ by: "autopilot", name: null }, "Autopilot approved"],
    [{ by: "teammate", name: "Sam" }, "Sam approved"],
    [{ by: "teammate", name: null }, "A teammate approved"],
    [{ by: "zavi_team", name: null }, "The Zavi team approved"],
  ] as const)("names the approver %o", (who, words) => {
    renderAd(metaBudget({ exec_status: "executed", status: "acted", approval: { ...who, at: APPROVED_AT } }));
    expect(screen.getByRole("status").textContent).toBe(`Updated in Meta Ads · ${words} at ${time(APPROVED_AT)}`);
  });

  it("names the day when it was not today", () => {
    renderAd(metaBudget({ exec_status: "executed", status: "acted", approval: { by: "autopilot", name: null, at: "2026-10-12T22:06:00Z" } }));
    expect(screen.getByRole("status").textContent).toMatch(/^Updated in Meta Ads · Autopilot approved at Oct 1[23], /);
  });
});

describe("a failed ad card, by bucket", () => {
  const failed = (over: Partial<ChannelActionView>) =>
    metaBudget({ exec_status: "failed", timeline: [...timeline.slice(0, 3), { kind: "failed", at: APPLIED_AT }], ...over });
  const tryAgain = () => screen.queryByRole("button", { name: /^Try again$/ });
  const never = /Nothing was changed|Check it before trying again/;

  it("temporary: red title, Try again, approver and History", () => {
    vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ exec_bucket: "temporary", note: null }));
    expect(banner().getAttribute("data-exec")).toBe("failed");
    expect(title()).toBe("Meta Ads did not take the change.");
    expect(tryAgain()).not.toBeNull();
    expect(screen.getByTestId("exec-approver").textContent).toBe(`You approved at ${time(APPROVED_AT)}·History`);
    expect(banner().textContent).not.toMatch(never);
  });

  it("needs_founder (ad budget): the fix, the budget link, Try again", () => {
    vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ exec_bucket: "needs_founder", exec_fix: "ad_budget", exec_fix_text: "raise your ad budget on the Growth page, or approve a smaller change", note: "Nothing was sent to Meta Ads." }));
    expect(title()).toBe("Budget limit reached.");
    expect(screen.getByTestId("exec-fix").textContent).toBe("This needs you: raise your ad budget on the Growth page, or approve a smaller change.");
    expect(screen.getByTestId("exec-ad-budget")).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  it("blocked_on_us (refused, closed): red, no retry, no controls, no toast on page load", () => {
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ status: "stale", exec_bucket: "blocked_on_us", note: "Meta Ads refused this change." }));
    expect(banner().getAttribute("data-exec")).toBe("failed");
    expect(screen.getByText("Meta Ads refused this change. We've been alerted; nothing for you to do.")).toBeTruthy();
    expect(screen.getByTestId("exec-history")).toBeTruthy();
    expect(tryAgain()).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions|Reject|Ask Zavi/ })).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it("a refused card the founder watched run still toasts once when it lands in the done list", () => {
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    const running = metaBudget({ exec_status: "dispatching", exec_started_at: minutesAgo(1) });
    renderAd(running);
    cleanup();
    renderAd(failed({ status: "stale", exec_bucket: "blocked_on_us" }));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("partial_risk: no Try again, never 'Nothing was changed'", () => {
    vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ exec_bucket: "partial_risk", exec_code: "meta_ads_mutate_incomplete", note: "Meta did not confirm the change." }));
    expect(tryAgain()).toBeNull();
    expect(banner().textContent).toContain("will not run this again");
    expect(banner().textContent).not.toMatch(never);
  });

  it("exec_outcome_unknown with no bucket: no Try again", () => {
    vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ exec_bucket: null, exec_code: "exec_outcome_unknown" }));
    expect(tryAgain()).toBeNull();
    expect(banner().textContent).not.toMatch(never);
  });

  it("no bucket (an older server): today's words, Try again", () => {
    vi.spyOn(toast, "add").mockImplementation(() => "t");
    renderAd(failed({ exec_bucket: null, note: null }));
    expect(banner().textContent).toContain("Check the account before approving again");
    expect(tryAgain()).not.toBeNull();
  });
});

describe("non-ad cards wear the same banner", () => {
  it("a failed email send on the email card: red banner with the fix", () => {
    const email = platformFor("email_marketing");
    const a = makeAction("send_message", {
      id: "email-1",
      channel_slug: "email_marketing",
      executable: true,
      email_card: true,
      exec_status: "failed",
      exec_bucket: "needs_founder",
      exec_fix_text: "reconnect Mailchimp in Settings",
      approval: { by: "autopilot", name: null, at: APPROVED_AT },
      timeline,
    });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(screen.getByTestId("email-card")).toBeTruthy();
    expect(banner().getAttribute("data-exec")).toBe("failed");
    expect(title()).toBe("This email was not sent.");
    expect(screen.getByTestId("exec-fix").textContent).toBe("This needs you: reconnect Mailchimp in Settings.");
    expect(screen.getByTestId("exec-approver").textContent).toContain("Autopilot approved at");
  });

  it("a generated video, executed and still open: the channel's done words, the approver, the download", () => {
    const video = platformFor("generated_video");
    const url = "https://storage.example/v.mp4";
    const a = makeAction("video_post", {
      id: "vid-done",
      channel_slug: "generated_video",
      executable: true,
      card_kind: "executes",
      exec_status: "executed",
      executed_at: APPLIED_AT,
      approval: you,
      body: { step: { title: "Demo", body: "A demo.", blocking: false, effort: "minutes", evidence: [] }, media: { kind: "video", url, alt: "", download_url: url, ai_generated: true } } as ChannelActionView["body"],
    });
    render(<ChannelActionCard action={a} platform={video} handlers={handlers()} />);
    expect(banner().getAttribute("data-exec")).toBe("executed");
    expect(title()).toBe("Your video is ready. You were charged only now that it arrived.");
    expect(screen.getByTestId("exec-approver").textContent).toBe(`You approved at ${time(APPROVED_AT)} · applied ${time(APPLIED_AT)}`);
    expect(screen.getByTestId("video-download")).toBeTruthy();
  });

  it("a site pull request waiting in Approvals keeps its plain line: no steps, no bar, no dim, never slow", () => {
    const seo = platformFor("seo");
    const a = makeAction("fix", {
      id: "pr-1",
      channel_slug: "seo",
      executable: true,
      card_kind: "executes",
      exec_status: "dispatching",
      exec_waiting: "approvals",
      exec_started_at: minutesAgo(90),
      approval: you,
    });
    render(<ChannelActionCard action={a} platform={seo} handlers={handlers()} />);
    expect(banner().getAttribute("data-exec")).toBe("waiting");
    expect(banner().textContent).toContain("waiting for your approval lower on this page");
    expect(screen.queryByTestId("exec-steps")).toBeNull();
    expect(banner().getAttribute("data-slow")).toBeNull();
    expect(screen.getByTestId("split-left").className).not.toContain("opacity-60");
  });
});

describe("History approver after a Try again", () => {
  it("names the latest approver only on the latest approval", () => {
    const a = makeAction("pause_ad", {
      ...FIXTURES.pause_ad,
      executable: true,
      status: "acted",
      exec_status: "executed",
      executed_at: "2026-10-20T05:06:41Z",
      approval: { by: "you", name: null, at: "2026-10-20T05:06:36Z" },
      timeline: [
        { kind: "approved", at: "2026-10-19T05:00:00Z" },
        { kind: "failed", at: "2026-10-19T05:00:05Z" },
        { kind: "approved", at: "2026-10-20T05:06:36Z" },
        { kind: "executed", at: "2026-10-20T05:06:41Z" },
      ],
    });
    render(<CardHistoryDrawer a={a} events={a.timeline!} platformName="Meta Ads" onClose={() => {}} />);
    const text = screen.getByTestId("card-history").textContent ?? "";
    expect(text).toMatch(/Someone\s*approved it/);
    expect((text.match(/You approved it/g) ?? []).length).toBe(1);
  });
});
