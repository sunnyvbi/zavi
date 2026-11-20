// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionSection } from "../ChannelActionSection";
import { ChannelActionCard } from "../ChannelActionCard";
import { outcomeLine } from "../AdFooter";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

const handlers: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() };
const gads = platformFor("google_ads");

const done = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "done-1", status: "acted", exec_status: "executed", executed_at: "2026-10-18T04:31:11Z", ...over });

describe("outcomeLine", () => {
  it("names the readout day and the goal before the verdict", () => {
    expect(outcomeLine({ readout_on: "2026-10-25", success_if: "Oct 18 to 24 spends at least $115 a day." })).toBe(
      "Autopilot test · checking results Oct 25. Goal: Oct 18 to 24 spends at least $115 a day.",
    );
  });
  it("carries the test's spend and stop while it runs", () => {
    const spend_line = "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there.";
    expect(outcomeLine({ readout_on: "2026-11-03", success_if: "10 bookings", spend_line })).toBe(
      `Autopilot test · checking results Nov 3. ${spend_line} Goal: 10 bookings.`,
    );
  });
  it("promises no day while the change is not live yet", () => {
    expect(outcomeLine({ readout_on: null, success_if: "10 sign-ups" })).toBe("Autopilot test · results are checked once this is live. Goal: 10 sign-ups.");
  });
  it("gives the verdict and the measured result once read", () => {
    expect(outcomeLine({ readout_on: "2026-10-25", success_if: "x", verdict: "did_not_work", result: "Cost per conversion rose to $91." })).toBe(
      "Autopilot test · Did not work. Cost per conversion rose to $91.",
    );
    expect(outcomeLine({ readout_on: "2026-10-25", success_if: "x", verdict: "not_measured" })).toBe("Autopilot test · Not measured.");
  });
});

describe("a done card", () => {
  it("says it is done, when, and what its test is waiting for", () => {
    render(<ChannelActionCard action={done({ outcome: { readout_on: "2026-10-25", success_if: "cost per conversion at or under $75" } })} platform={gads} handlers={handlers} />);
    expect(screen.getByRole("status").textContent).toMatch(/^(Paused|Updated|Live) in Google Ads/);
    expect(screen.getByTestId("exec-state").getAttribute("data-exec")).toBe("executed");
    const outcome = screen.getByTestId("exec-outcome");
    expect(outcome.getAttribute("data-verdict")).toBe("pending");
    expect(outcome.textContent).toContain("checking results Oct 25");
    expect(screen.queryByRole("button", { name: /^Pause keywords$/ })).toBeNull();
  });

  it("shows no test line when the change was not part of a test", () => {
    render(<ChannelActionCard action={done({ outcome: null })} platform={gads} handlers={handlers} />);
    expect(screen.queryByTestId("exec-outcome")).toBeNull();
  });
});

const open = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "open-1" });

describe("ChannelActionSection with done cards", () => {
  it("draws no closed done card, only the open work", () => {
    render(<ChannelActionSection actions={[open]} completed={[done()]} platform={gads} handlers={handlers} empty={null} />);
    expect(screen.queryByRole("region", { name: "Zavi did for you" })).toBeNull();
    expect(screen.queryByTestId("exec-state")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Ready for you" })).getByTestId("action-open-1")).toBeTruthy();
    expect([...document.querySelectorAll("[data-ad-section]")].map((el) => el.getAttribute("data-ad-section"))).toEqual(["ready"]);
  });

  it("does not draw a card as open work once it has closed", () => {
    const settling = { ...open, id: "done-1", exec_status: "dispatching" as const };
    render(<ChannelActionSection actions={[settling]} completed={[done()]} platform={gads} handlers={handlers} empty={<p>Nothing yet</p>} />);
    expect(screen.queryByTestId("action-done-1")).toBeNull();
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("keeps a change that ran and is still open with the open work", () => {
    const made = done({ id: "made-1", status: "pending" });
    render(<ChannelActionSection actions={[made]} completed={[made]} platform={gads} handlers={handlers} empty={null} />);
    expect(within(screen.getByRole("region", { name: "Ready for you" })).getByTestId("action-made-1")).toBeTruthy();
  });
});

describe("ChannelActionSection with only done cards", () => {
  it.each(["linkedin_ads", "google_ads", "meta_ads", "reddit_ads"])("%s shows the empty slot and its run button alone", (slug) => {
    const onRun = vi.fn();
    render(
      <ChannelActionSection
        actions={[]}
        completed={[done()]}
        platform={platformFor(slug)}
        handlers={handlers}
        emptyGroups
        empty={<button type="button" data-testid="run-slot" onClick={onRun}>Run it again</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run it again" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exec-state")).toBeNull();
    expect(Array.from(document.querySelectorAll("[data-ad-section]")).map((el) => el.textContent)).toEqual(["Fix firstNothing to fix right now.", "Ready for youNothing ready right now."]);
  });

  it("hides the empty slot while an open card exists", () => {
    render(<ChannelActionSection actions={[open]} completed={[done()]} platform={gads} handlers={handlers} empty={<p data-testid="run-slot">empty</p>} />);
    expect(screen.queryByTestId("run-slot")).toBeNull();
  });
});

describe("a LinkedIn post that went live", () => {
  const li = platformFor("linkedin_organic");
  const LIVE = "https://www.linkedin.com/feed/update/urn:li:share:7392";
  const posted = makeAction("text_post", {
    id: "lp1",
    channel_slug: "linkedin_organic",
    run_id: "run-li",
    title: "Review and edit your post on first paid ads tests",
    body: { step: { title: "Review and edit your post on first paid ads tests", body: "b", deliverable: { kind: "post", content: "Our first paid ads test is live." } } },
    status: "acted",
    card_kind: "post",
    primary_label: "Post on LinkedIn",
    done_label: "Posted",
    exec_status: "executed",
    executed_at: "2026-10-18T03:00:40Z",
    exec_receipt: { line: "Posted on LinkedIn.", url: LIVE },
  });

  it("links to the live post and offers no way to post it again", () => {
    const onPublish = vi.fn(async () => true);
    render(<ChannelActionCard action={posted} platform={li} handlers={{ ...handlers, onPublish }} />);
    expect(screen.getByTestId("exec-receipt").textContent).toBe("Posted on LinkedIn.");
    expect(screen.getByTestId("exec-receipt-link").getAttribute("href")).toBe(LIVE);
    expect(screen.queryByRole("button", { name: /post/i })).toBeNull();
    expect(onPublish).not.toHaveBeenCalled();
  });
});
