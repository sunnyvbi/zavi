// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { headOfGrowthOf, type GrowthChannel } from "@/lib/workspace/useGrowthPlan";

const calls: Array<{ path: string; method?: string; body?: string }> = [];
let status = 200;
let reply: unknown = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, method: opts?.method, body: opts?.body });
    return { ok: status < 400, status, json: async () => reply } as unknown as Response;
  },
}));

import { HeadOfGrowthCard, claimOutcome } from "./HeadOfGrowth";

const onChanged = vi.fn(async () => {});
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const old = new Date(Date.now() - 40 * 86_400_000).toISOString();

beforeEach(() => {
  calls.length = 0;
  status = 200;
  reply = {};
  onChanged.mockClear();
  document.body.querySelectorAll("[role=status]").forEach((n) => n.remove());
});
afterEach(cleanup);

const offNote = (over: Record<string, unknown> = {}) =>
  headOfGrowthOf({
    autopilot: false,
    note: { saw: ["9 Reddit posts waited 9 days."], changed: [], would_change: ["Pause Reddit. Ignored."], need: ["Connect Google Analytics."], created_at: "x", next_review_at: "2026-10-02T14:00:00Z" },
    undoable: [],
    ...over,
  });

const channel = (over: Partial<GrowthChannel>): GrowthChannel =>
  ({
    slug: "reddit_organic",
    last_run_at: null,
    last_run_status: null,
    metric_keys: [],
    metric_availability: "none",
    autorun: false,
    autorun_set_by: "",
    plan_selected: false,
    cgo_reason: "Ignored for 9 days.",
    cgo_set_at: recent,
    ...over,
  }) as GrowthChannel;

describe("the Autopilot control", () => {
  it("off: the track says so, one line says what Autopilot does, the guarantee card is there", () => {
    render(<HeadOfGrowthCard hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    const sw = screen.getByRole("switch", { name: "Autopilot" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toContain("Autopilot off");
    expect(screen.getByText(/Autopilot lets Zavi run every channel your plan includes by itself, including ads within your ad budget and marketing email sends\. Set any channel to ask you first\./)).toBeTruthy();
    expect(screen.getByText("Autopilot Guarantee")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toMatch(/within 30 days and we undo the change and refund the credits it used/);
    expect(screen.getByText("Next note Oct 2")).toBeTruthy();
    expect(screen.getByText("Turn on Autopilot and I'll make these myself.")).toBeTruthy();
  });

  it("turning it on saves, celebrates once, and refreshes the page", async () => {
    render(<HeadOfGrowthCard hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("Welcome to Autopilot")).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ path: "/api/workspace/growth/autopilot", method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("turning it off does not celebrate", async () => {
    render(<HeadOfGrowthCard hog={offNote({ autopilot: true })} unavailable={false} channels={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByText("Welcome to Autopilot")).toBeNull();
  });

  it("a failed save puts the switch back and says so", async () => {
    status = 500;
    render(<HeadOfGrowthCard hog={offNote({ autopilot: true })} unavailable={false} channels={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("'How it works' shows its tooltip on hover", () => {
    render(<HeadOfGrowthCard hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    const btn = screen.getByText("How it works");
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip.className).toContain("invisible");
    fireEvent.mouseEnter(btn.parentElement!);
    expect(tip.className).not.toContain("invisible");
  });
});

describe("the Autopilot Guarantee: 'This was a mistake'", () => {
  const onNote = (undoable: unknown[] = []) =>
    headOfGrowthOf({
      autopilot: true,
      note: {
        saw: [],
        changed: ['Goal "Get 20 signups": target 20 to 12. Behind pace.', "Paused Reddit. Ignored for 9 days.", "Something older"],
        would_change: [],
        need: [],
        created_at: "x",
        next_review_at: "y",
      },
      undoable,
    });

  it("a goal change within 30 days: undone, and the refund shown", async () => {
    reply = { ok: true, refund: { status: "refunded", credits: 412 }, claim_sent: true };
    render(
      <HeadOfGrowthCard
        hog={onNote([{ goal_id: "g1", why: "Behind pace.", at: recent, prev_objective: "Get 20 signups" }])}
        unavailable={false}
        channels={[]}
        onChanged={onChanged}
      />,
    );
    const buttons = screen.getAllByText("This was a mistake");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(await screen.findByText("Undone. We refunded 412 credits to your wallet.")).toBeTruthy();
    expect(calls[0]).toMatchObject({ path: "/api/workspace/growth/autopilot-mistake", method: "POST", body: JSON.stringify({ kind: "goal", goal_id: "g1" }) });
  });

  it("a channel Autopilot paused gets the button too", async () => {
    reply = { ok: true, claim_sent: true };
    render(<HeadOfGrowthCard hog={onNote()} unavailable={false} channels={[channel({})]} onChanged={onChanged} />);
    fireEvent.click(screen.getByText("This was a mistake"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toBe(JSON.stringify({ kind: "channel", channel_slug: "reddit_organic" }));
  });

  it("no button on a change older than 30 days, or one it cannot tie to a goal or channel", () => {
    render(
      <HeadOfGrowthCard
        hog={onNote([{ goal_id: "g1", why: "x", at: old, prev_objective: "Get 20 signups" }])}
        unavailable={false}
        channels={[channel({ cgo_set_at: old })]}
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByText("This was a mistake")).toBeNull();
  });

  it("a member sees the changes but no mistake button", () => {
    render(
      <HeadOfGrowthCard
        hog={onNote([{ goal_id: "g1", why: "x", at: recent, prev_objective: "Get 20 signups" }])}
        unavailable={false}
        channels={[channel({})]}
        canClaim={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText(/Paused Reddit/)).toBeTruthy();
    expect(screen.queryByText("This was a mistake")).toBeNull();
  });

  it("two goals that once read the same: that line gets no button", () => {
    render(
      <HeadOfGrowthCard
        hog={onNote([
          { goal_id: "g1", why: "x", at: recent, prev_objective: "Get 20 signups" },
          { goal_id: "g2", why: "y", at: recent, prev_objective: "Get 20 signups" },
        ])}
        unavailable={false}
        channels={[]}
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByText("This was a mistake")).toBeNull();
  });

  it("if the claim could not be filed, the founder is told how to get the refund", async () => {
    reply = { ok: true, claim_sent: false };
    render(
      <HeadOfGrowthCard
        hog={onNote([{ goal_id: "g1", why: "x", at: recent, prev_objective: "Get 20 signups" }])}
        unavailable={false}
        channels={[]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByText("This was a mistake"));
    expect(await screen.findByText(/email support@zaviagent.com and we'll refund it/)).toBeTruthy();
  });
});

describe("what the founder reads after a claim", () => {
  it("names the refund, or says how it will happen", () => {
    expect(claimOutcome({ refund: { status: "refunded", credits: 1200 } })).toBe("Undone. We refunded 1,200 credits to your wallet.");
    expect(claimOutcome({ refund: { status: "already_refunded", credits: 400 } })).toBe("Undone. The credits for that check-in were already refunded.");
    expect(claimOutcome({ refund: { status: "nothing_charged", credits: 0 } })).toBe("Undone. That change didn't use any credits.");
    expect(claimOutcome({ refund: { status: "refunded", credits: 300, forfeited: 100 } })).toBe(
      "Undone. We refunded 300 credits to your wallet. Credits from a daily or monthly allowance that has reset since don't come back.",
    );
    expect(claimOutcome({ refund: { status: "expired", credits: 0, forfeited: 100 } })).toBe(
      "Undone. The credits it used came from a daily or monthly allowance that has reset since, so there is nothing to refund.",
    );
    expect(claimOutcome({ refund: { status: "untracked", credits: 0 }, claim_sent: true })).toBe(
      "Undone. We're checking which credits it used and will refund what's owed within 1 business day.",
    );
    expect(claimOutcome({ refund: { status: "untracked", credits: 0 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
    expect(claimOutcome({ refund: { status: "refunded", credits: 70, untracked: 50 }, claim_sent: true })).toBe(
      "Undone. We refunded 70 credits to your wallet. We're checking the rest and will refund what's owed within 1 business day.",
    );
    expect(claimOutcome({ refund: { status: "refunded", credits: 70, untracked: 50 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
    expect(claimOutcome({ refund: { status: "already_claimed", credits: 0 } })).toBe(
      "Undone. That check-in's credits were already handled by an earlier claim.",
    );
    expect(claimOutcome({ refund: { status: "failed", credits: 0 }, claim_sent: true })).toBe(
      "Undone. We'll refund the credits it used to your wallet within 1 business day.",
    );
    expect(claimOutcome({ refund: { status: "no_run", credits: 0 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
  });
});

describe("the note", () => {
  it("no note yet: says when one comes", () => {
    render(<HeadOfGrowthCard hog={headOfGrowthOf(undefined)} unavailable={false} channels={[]} onChanged={onChanged} />);
    expect(screen.getByText(/My first note comes after/)).toBeTruthy();
  });

  it("headOfGrowthOf: an older backend reads as autopilot off, no note", () => {
    expect(headOfGrowthOf(undefined)).toEqual({ autopilot: false, note: null, undoable: [] });
  });
});

describe("the Growth story's two parts", () => {
  const longNote = () =>
    headOfGrowthOf({
      autopilot: false,
      note: {
        saw: ["One.", "Two.", "Three.", "Four."],
        changed: [],
        would_change: [],
        need: ["Connect Google Analytics."],
        created_at: "x",
        next_review_at: "2026-10-02T14:00:00Z",
      },
      undoable: [],
    });

  it("switch: the small Autopilot switch, its caption and the money-back link, no note", async () => {
    render(<HeadOfGrowthCard part="switch" hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    const sw = screen.getByRole("switch", { name: "Autopilot" });
    expect(sw.textContent).toBe("Autopilot off");
    expect(screen.getByText(/Autopilot lets Zavi run every channel your plan includes by itself/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Money-back guarantee" })).toBeTruthy();
    expect(screen.queryByText("9 Reddit posts waited 9 days.")).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/workspace/growth/autopilot")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === "/api/workspace/growth/autopilot")!.body!)).toEqual({ enabled: true });
  });

  it("switch: a member sees who can change it and cannot flip it (it lets Zavi run every channel)", () => {
    render(<HeadOfGrowthCard part="switch" hog={offNote()} unavailable={false} channels={[]} canSwitch={false} onChanged={onChanged} />);
    const sw = screen.getByRole("switch", { name: "Autopilot" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("Only owners and admins can change Autopilot.")).toBeTruthy();
    fireEvent.click(sw);
    expect(calls).toHaveLength(0);
  });

  it("switch: a refusal from the server says who can change it, and the switch goes back", async () => {
    status = 403;
    render(<HeadOfGrowthCard part="switch" hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("switch", { name: "Autopilot" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Only owners and admins can change Autopilot."));
    expect(screen.getByRole("switch", { name: "Autopilot" }).getAttribute("aria-checked")).toBe("false");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("note: every line of the note, no nested toggle, no switch", () => {
    render(<HeadOfGrowthCard part="note" hog={longNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    expect(screen.getByText("Four.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show more$|^Show less$/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("note: keeps This was a mistake on a change Autopilot made", () => {
    const hog = headOfGrowthOf({
      autopilot: true,
      note: { saw: [], changed: ["Paused Reddit. Ignored for 9 days."], would_change: [], need: [], created_at: "x", next_review_at: "" },
      undoable: [],
    });
    render(<HeadOfGrowthCard part="note" hog={hog} unavailable={false} channels={[channel({})]} onChanged={onChanged} />);
    expect(screen.getByRole("button", { name: "This was a mistake" })).toBeTruthy();
  });
});

describe("a note built from items", () => {
  const sectioned = (undoable: unknown[] = [], extra: Record<string, unknown> = {}) =>
    headOfGrowthOf({
      autopilot: true,
      note: {
        saw: [],
        changed: ["legacy line never drawn"],
        would_change: [],
        need: [],
        questions: [],
        created_at: "x",
        next_review_at: "2026-10-03T16:00:00Z",
        headline: "Google spent $468 and counted 0 sign-ups.",
        sections: [
          {
            key: "needs_you",
            title: "Needs you",
            rows: [
              { line: "Keep Reddit? Reply by Oct 3.", url: null, question_ordinal: 1 },
              { line: "Count sign-ups. $468 spent with 0 counted sign-ups.", url: "/workspace?tab=channels&channel=google_ads&action=a1" },
            ],
            more: { count: 3, url: "/workspace?tab=growth-strategy", line: "3 more on your Growth page." },
          },
          {
            key: "changed",
            title: "What I changed",
            rows: [
              { line: 'Goal "Get 20 signups": target 20 to 12.', url: null, undo: { kind: "goal", goal_id: "g1" } },
              { line: "Paused Reddit.", url: null, undo: { kind: "channel", channel_slug: "reddit_organic" } },
              { line: "Rejected: Old card.", url: null },
            ],
            more: null,
          },
          { key: "working_on", title: "Working on", rows: [{ line: "Google Ads: Holding budgets.", url: null }], more: null },
          { key: "blocked", title: "Blocked on us", rows: [{ line: "Create YT. Google Ads refused this change. We've been alerted; nothing for you to do.", url: null }], more: null },
        ],
        ...extra,
      },
      undoable,
    });

  it("headline, the four section titles in order, the Open link and the overflow row; question rows are not repeated", () => {
    render(<HeadOfGrowthCard hog={sectioned()} unavailable={false} channels={[]} onChanged={onChanged} part="note" />);
    expect(screen.getByText("Google spent $468 and counted 0 sign-ups.")).toBeTruthy();
    const titles = ["Needs you", "What I changed", "Working on", "Blocked on us"].map((t) => screen.getByText(t));
    for (let i = 1; i < titles.length; i++) expect(titles[i - 1].compareDocumentPosition(titles[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const opens = screen.getAllByRole("link", { name: "Open" }).map((a) => a.getAttribute("href"));
    expect(opens).toEqual(["/workspace?tab=channels&channel=google_ads&action=a1", "/workspace?tab=growth-strategy"]);
    expect(screen.getByText("3 more on your Growth page.")).toBeTruthy();
    expect(screen.queryByText(/Keep Reddit\?/)).toBeNull();
    expect(screen.queryByText("legacy line never drawn")).toBeNull();
  });

  it("undo buttons come from each row's own target, gated by the 30-day window, and post that target", async () => {
    reply = { ok: true, claim_sent: true };
    render(
      <HeadOfGrowthCard
        hog={sectioned([{ goal_id: "g1", why: "", at: recent, prev_objective: "a different name entirely" }])}
        unavailable={false}
        channels={[channel({ cgo_set_at: old })]}
        onChanged={onChanged}
        part="note"
      />,
    );
    const buttons = screen.getAllByText("This was a mistake", { selector: "button" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toBe(JSON.stringify({ kind: "goal", goal_id: "g1" }));
  });

  it("the refund guidance shows only when some row has an undo", () => {
    render(<HeadOfGrowthCard hog={sectioned()} unavailable={false} channels={[]} onChanged={onChanged} part="note" />);
    expect(screen.getByText(/Wrong call\? Mark it/)).toBeTruthy();
    cleanup();
    const noUndo = sectioned([], {
      sections: [{ key: "blocked", title: "Blocked on us", rows: [{ line: "Create YT.", url: null }], more: null }],
    });
    render(<HeadOfGrowthCard hog={noUndo} unavailable={false} channels={[]} onChanged={onChanged} part="note" />);
    expect(screen.queryByText(/Wrong call\? Mark it/)).toBeNull();
    expect(screen.getByText("Blocked on us")).toBeTruthy();
  });

  it("a grouped row draws its cards as a list under one link to the channel page", () => {
    const grouped = sectioned([], {
      sections: [{
        key: "needs_you",
        title: "Needs you",
        rows: [{ line: "3 AI videos are waiting on you", url: "/workspace?tab=channels&channel=generated_video", url_label: "Open videos", sub: ["Video 1 · made, not posted yet", "Video 2 · script only, not made yet", "Video 3 · script only, not made yet", 7] }],
        more: null,
      }],
    });
    expect(grouped.note?.sections?.[0].rows[0].sub).toEqual(["Video 1 · made, not posted yet", "Video 2 · script only, not made yet", "Video 3 · script only, not made yet"]);
    render(<HeadOfGrowthCard hog={grouped} unavailable={false} channels={[]} onChanged={onChanged} part="note" />);
    expect(screen.getAllByRole("link", { name: "Open videos" }).map((a) => a.getAttribute("href"))).toEqual(["/workspace?tab=channels&channel=generated_video"]);
    expect(screen.getByText("Video 1 · made, not posted yet")).toBeTruthy();
    expect(screen.getByText("Video 3 · script only, not made yet")).toBeTruthy();
  });

  it("a legacy note (no sections) renders the old sections", () => {
    render(<HeadOfGrowthCard hog={offNote()} unavailable={false} channels={[]} onChanged={onChanged} />);
    expect(screen.getByText("What I need from you")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  it("headOfGrowthOf drops malformed sections and any link that is not same-site relative", () => {
    const h = headOfGrowthOf({
      autopilot: true,
      note: {
        saw: [], changed: [], would_change: [], need: [], created_at: "x", next_review_at: "y",
        sections: [
          { key: "needs_you", title: "Needs you", rows: [{ line: "A", url: "https://evil.test/x" }, { line: "B", url: "//evil.test" }, { line: "C", url: "/\\evil.test" }, { line: "", url: "/ok" }, { line: "D", url: "/workspace?tab=channels" }], more: { count: 2, url: "https://evil.test", line: "2 more" } },
          { key: "bogus", title: "X", rows: [{ line: "x", url: null }], more: null },
          { key: "changed", title: "What I changed", rows: [{ line: "E", url: null, undo: { kind: "goal" } }], more: null },
        ],
      },
      undoable: [],
    });
    expect(h.note?.sections).toEqual([
      { key: "needs_you", title: "Needs you", rows: [{ line: "A", url: null }, { line: "B", url: null }, { line: "C", url: null }, { line: "D", url: "/workspace?tab=channels" }], more: null },
      { key: "changed", title: "What I changed", rows: [{ line: "E", url: null }], more: null },
    ]);
  });
});
