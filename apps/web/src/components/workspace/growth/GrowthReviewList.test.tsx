// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const calls: Array<{ path: string; method?: string }> = [];
let approvals: unknown = { decisions: [] };
let exact: Record<string, unknown> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string }) => {
    calls.push({ path, method: opts?.method });
    if (path in exact) {
      const hit = exact[path] as { __status?: number; body?: unknown };
      const status = hit?.__status ?? 200;
      return { ok: status < 400, status, json: async () => (hit?.__status ? hit.body : hit) } as unknown as Response;
    }
    const { homeResponseFor } = await import("./testHomeFixture");
    const home = homeResponseFor(path, approvals as never);
    if (home) return { ok: true, status: 200, json: async () => home } as unknown as Response;
    const decided = /^\/api\/approvals\/([^/?]+)$/.exec(path);
    if (decided) {
      const d = ((approvals as { decisions?: Array<Record<string, unknown>> }).decisions ?? []).find((r) => r.id === decided[1]);
      if (!d) return { ok: false, status: 404, json: async () => ({ error: { code: "not_found" } }) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          decision: { handler: null, body: {}, dispatched_at: null, dispatch_error: null, ...d, status: approvedIds.has(decided[1]) ? "approved" : "proposed" },
          home: { kind: "growth" },
          needs_owner_admin: false,
          viewer_role: "owner",
        }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  },
}));

const approvedIds = new Set<string>();
const approveSpy = vi.fn(async (id: string, _extras?: unknown) => {
  approvedIds.add(id);
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
});
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: (id: string, extras?: unknown) => (extras && Object.keys(extras as object).length ? approveSpy(id, extras) : approveSpy(id)),
  rejectDecision: async (id: string, opts?: { surface?: string }) => {
    calls.push({ path: `/api/approvals/${id}/reject?surface=${opts?.surface}`, method: "POST" });
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  },
}));

let actionsBySlug: Record<string, ChannelActionView[]> = {};
let failSlugs = new Set<string>();
let previewsBySlug: Record<string, number> = {};
const listSpy = vi.fn();
const setSpy = vi.fn(async (_id: string, _input: unknown) => ({}));
vi.mock("@/lib/workspace/channelActionsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/channelActionsApi")>()),
  listChannelActions: async (slug: string) => {
    listSpy(slug);
    if (failSlugs.has(slug)) throw new Error("HTTP 500");
    return {
      actions: actionsBySlug[slug] ?? [],
      more: 0,
      store: "channel_actions",
      ...(previewsBySlug[slug] ? { locked_preview: { count: previewsBySlug[slug], types: [] } } : {}),
    };
  },
  setChannelAction: (id: string, input: unknown) => setSpy(id, input),
}));

vi.mock("@/app/approvals/ApprovalsIsland", () => ({ DecisionBody: () => <div>decision body</div> }));

import { GrowthReviewList, arrangeReview, beforeYouDoIt, firstSentence } from "./GrowthReviewList";

const action = (id: string, over: Partial<ChannelActionView> & { effort?: string; stepBody?: string } = {}): ChannelActionView =>
  ({
    id,
    channel_slug: "seo",
    run_id: "r",
    position: 3,
    run_of: 5,
    blocking: false,
    action_type: "fix",
    title: `Action ${id}`,
    body: { step: { body: over.stepBody ?? `Why ${id}. More detail here.`, effort: over.effort } },
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 1,
    score_inputs: {},
    proposed_at: "2026-09-20T00:00:00Z",
    repeat_of: null,
    redo_of: null,
    source: "channel_action",
    executable: false,
    exec_status: null,
    edited_body: null,
    ...over,
  }) as ChannelActionView;

beforeEach(() => {
  calls.length = 0;
  approveSpy.mockClear();
  setSpy.mockClear();
  actionsBySlug = {};
  failSlugs = new Set();
  previewsBySlug = {};
  listSpy.mockClear();
  approvals = { decisions: [] };
  exact = {};
  approvedIds.clear();
});
afterEach(cleanup);

describe("arranging the list", () => {
  it("puts a blocking action on top, then the Channels page's own order", () => {
    const { top } = arrangeReview([
      action("a", { score: 9 }),
      action("b", { blocking: true, score: 1 }),
      action("c", { position: 1, score: 2 }),
    ]);
    expect(top?.id).toBe("b");
    expect(arrangeReview([action("a", { score: 9 }), action("c", { position: 1, score: 2 })]).top?.id).toBe("c");
    expect(arrangeReview([action("a", { score: 1 }), action("d", { score: 5 })]).top?.id).toBe("d");
  });

  it("groups by effort: minutes are quick wins, the rest takes longer", () => {
    const { top, quick, longer } = arrangeReview([
      action("top", { blocking: true }),
      action("m", { effort: "minutes" }),
      action("h", { effort: "hours" }),
      action("d", { effort: "days" }),
      action("none"),
    ]);
    expect(top?.id).toBe("top");
    expect(quick.map((a) => a.id)).toEqual(["m"]);
    expect(longer.map((a) => a.id).sort()).toEqual(["d", "h", "none"]);
  });

  it("takes Risk / Undo / If you skip it from the first finding, and omits what is missing", () => {
    expect(beforeYouDoIt({ findings: [{ risk: "Low.", undo: "Restore it.", do_nothing: "Keeps competing." }] })).toEqual([
      ["Risk", "Low."],
      ["Undo", "Restore it."],
      ["If you skip it", "Keeps competing."],
    ]);
    expect(beforeYouDoIt({ findings: [{ risk: "Low." }] })).toEqual([["Risk", "Low."]]);
    expect(beforeYouDoIt({})).toEqual([]);
  });

  it("uses the first sentence as the one-line why", () => {
    expect(firstSentence("It competes in search. Fix the title.")).toBe("It competes in search.");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence(undefined)).toBe("");
  });
});

describe("the list in the page", () => {
  async function renderList(opts: { onResolved?: () => void; onAsk?: (t: string) => void; focusDecisionId?: string } = {}) {
    render(
      <GrowthReviewList
        inChannels={{ seo: 3 }}
        focusDecisionId={opts.focusDecisionId}
        onAsk={opts.onAsk}
        onResolved={opts.onResolved ?? (() => {})}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading what is waiting" })).toBeNull());
  }

  it("shows the top card open, with its why, text to paste and what to know first", async () => {
    actionsBySlug.seo = [
      action("top", {
        blocking: true,
        title: "Replace the duplicate title",
        stepBody: "It uses your homepage's title. The two pages compete.",
        body: {
          step: {
            body: "It uses your homepage's title. The two pages compete.",
            deliverable: { content: "Title: Terms | Upcar" },
          },
          findings: [{ risk: "Low. Title only.", undo: "Restore the old title." }],
        },
      }),
      action("quick", { effort: "minutes" }),
    ];
    const onAsk = vi.fn();
    await renderList({ onAsk });
    const card = screen.getByRole("region", { name: "If you do one thing this week" });
    expect(within(card).getByText("Replace the duplicate title")).toBeTruthy();
    expect(within(card).getByText("It uses your homepage's title.")).toBeTruthy();
    expect(within(card).getByText("The two pages compete.")).toBeTruthy();
    expect(within(card).getByText("Title: Terms | Upcar")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(within(card).getByText("Before you do it")).toBeTruthy();
    expect(within(card).getByText("Low. Title only.")).toBeTruthy();
    expect(within(card).getByText("Restore the old title.")).toBeTruthy();
    expect(within(card).queryByText("If you skip it")).toBeNull();
    expect(within(card).getByRole("link", { name: "Open in SEO" }).getAttribute("href")).toBe(
      "/workspace?tab=channels&channel=seo",
    );
    fireEvent.click(within(card).getByRole("button", { name: "Ask Zavi about this" }));
    expect(onAsk).toHaveBeenCalledWith('About "Replace the duplicate title": what should I know before I do it?');
  });

  it("omits the paste box and Before you do it when the action has neither", async () => {
    actionsBySlug.seo = [action("top", { blocking: true })];
    await renderList();
    const card = screen.getByRole("region", { name: "If you do one thing this week" });
    expect(within(card).queryByText("Ready to paste")).toBeNull();
    expect(within(card).queryByText("Before you do it")).toBeNull();
  });

  it("Did it and Not now go through the Channels page's status call, and collapse the row", async () => {
    actionsBySlug.seo = [action("top", { blocking: true }), action("q1", { effort: "minutes" }), action("q2", { effort: "minutes" })];
    const onResolved = vi.fn();
    await renderList({ onResolved });
    expect(screen.getByText("Quick wins · 2")).toBeTruthy();
    const rows = () => screen.getAllByRole("button", { name: "Did it" });
    fireEvent.click(rows()[1]);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("q1", { action: "acted" }));
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByText("Quick wins · 1")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Not now" })[1]);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("q2", { action: "snoozed" }));
    await waitFor(() => expect(screen.getByText("Quick wins · 0")).toBeTruthy());
    expect(screen.getAllByText("Not now").some((el) => el.tagName === "SPAN")).toBe(true);
    expect(onResolved).toHaveBeenCalledTimes(2);
  });

  it("approves a decision through approveDecision, and rejects through the reject route", async () => {
    approvals = {
      decisions: [
        { id: "d1", decision_class: "channel.recipe_step", body: {}, handler: null },
        { id: "d2", decision_class: "channel.recipe_step", body: {}, handler: null },
      ],
    };
    await renderList();
    expect(screen.getByText("To approve · 2")).toBeTruthy();
    expect(screen.getAllByText(/You approve$/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith("d1"));
    expect(await screen.findByText("Approved. Running it now.")).toBeTruthy();
    expect(screen.getByText("To approve · 1")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/approvals/d2/reject?surface=growth" && c.method === "POST")).toBe(true));
  });

  it("reads the growth and channel homes with true totals, and pages with Show more", async () => {
    exact["/api/approvals?home=growth%2Cchannel&count=1"] = {
      decisions: [{ id: "d1", decision_class: "social.publish.v2", body: {}, handler: null, home: "growth", home_channel: null, emitted_at: "2026-10-17T00:00:02Z" }],
      next_cursor: "C1",
      totals: { growth: 61, channel: 1, needs_you: 9 },
    };
    exact["/api/approvals?home=growth%2Cchannel&cursor=C1"] = {
      decisions: [{ id: "d2", decision_class: "meta_ads.pause", body: {}, handler: null, home: "growth", home_channel: null, emitted_at: "2026-10-17T00:00:01Z" }],
      next_cursor: null,
    };
    await renderList();
    expect(screen.getByText("To approve · 62")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByText(/You approve$/)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens a focused decision; one not on the page is read alone and pinned; a gone one says so", async () => {
    approvals = { decisions: [{ id: "d1", decision_class: "social.publish.v2", body: { rationale: "Post it." }, handler: null }] };
    await renderList({ focusDecisionId: "d1" });
    await waitFor(() => expect(screen.getAllByRole("button", { expanded: true }).length).toBeGreaterThan(0));
    cleanup();
    await renderList({ focusDecisionId: "gone" });
    expect(await screen.findByText("That card is not in your list any more.")).toBeTruthy();
  });

  it("points an executable ad change to its channel instead of Did it", async () => {
    actionsBySlug.seo = [action("ad", { blocking: true, executable: true })];
    await renderList();
    const card = screen.getByRole("region", { name: "If you do one thing this week" });
    expect(within(card).queryByRole("button", { name: "Did it" })).toBeNull();
    expect(within(card).getByRole("link", { name: "Review in SEO" })).toBeTruthy();
  });

  it("expands a row to the same detail as the top card", async () => {
    actionsBySlug.seo = [
      action("top", { blocking: true }),
      action("q", { effort: "minutes", stepBody: "First sentence. Second sentence." }),
    ];
    await renderList();
    const title = screen.getByText("Action q");
    expect(screen.queryByText("Second sentence.")).toBeNull();
    fireEvent.click(title);
    expect(screen.getByText("Second sentence.")).toBeTruthy();
  });
});

describe("the action's steps, option B", () => {
  it("shows Do with the menu path as chips, Check, Don't, and Why folded, on the card and on a row", async () => {
    const body =
      'In Google Ads: Tools > Conversions > "Upcar (web) sign_up_complete" > Settings > Include in Conversions > Yes. ' +
      "Verify firing in Tag Assistant within 24 hours by completing a test signup while Tag Assistant is active. " +
      "Do not make bid or budget changes until recording is confirmed. " +
      "The tag is already firing (4 events in the all_conversions window). " +
      "This is a goal-inclusion setting, not a missing tag installation.";
    actionsBySlug.seo = [
      action("top", { blocking: true, body: { step: { body, effort: "minutes" } } }),
      action("row", { effort: "minutes", body: { step: { body, effort: "minutes" } } }),
    ];
    render(<GrowthReviewList inChannels={{ seo: 2 }} onResolved={() => {}} />);
    const card = await screen.findByRole("region", { name: "If you do one thing this week" });
    expect(within(card).getByText("Minutes")).toBeTruthy();
    expect(within(card).getByText("SEO")).toBeTruthy();
    for (const chip of ["Tools", "Conversions", "Upcar (web) sign_up_complete", "Settings", "Include in Conversions", "Yes"]) {
      expect(within(card).getByText(chip)).toBeTruthy();
    }
    expect(within(card).getByText("In Google Ads:")).toBeTruthy();
    expect(within(card).getByText(/^Verify firing in Tag Assistant/)).toBeTruthy();
    expect(within(card).getByText("Make bid or budget changes until recording is confirmed.")).toBeTruthy();
    expect(within(card).queryByText(/The tag is already firing/)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Why this matters" }));
    expect(within(card).getByText(/The tag is already firing/)).toBeTruthy();
    fireEvent.click(screen.getByText("Action row"));
    expect(screen.getAllByText("Upcar (web) sign_up_complete")).toHaveLength(2);
  });

  it("falls back to plain lines when nothing reads as a step", async () => {
    actionsBySlug.seo = [
      action("top", { blocking: true, body: { step: { body: "The page has 250 words. Turo's has 2,000." } } }),
    ];
    render(<GrowthReviewList inChannels={{ seo: 1 }} onResolved={() => {}} />);
    const card = await screen.findByRole("region", { name: "If you do one thing this week" });
    expect(within(card).getByText("The page has 250 words.")).toBeTruthy();
    expect(within(card).getByText("Turo's has 2,000.")).toBeTruthy();
    expect(within(card).queryByText("Do")).toBeNull();
  });
});

describe("growth work only in the list", () => {
  it("shows growth decisions and every channel action, never other agents' work", async () => {
    approvals = {
      decisions: [
        { id: "pm", decision_class: "pm.needs_action", body: {}, handler: null },
        { id: "cos", decision_class: "chief-of-staff.dispatch-specialist", body: {}, handler: "praxis.dispatch_specialist" },
        { id: "post", decision_class: "channel.recipe_step", body: {}, handler: null },
        { id: "ad", decision_class: "google_ads.update_campaign_budget", body: {}, handler: null },
      ],
    };
    actionsBySlug.seo = [action("a1", { blocking: true }), action("a2", { effort: "minutes" })];
    render(<GrowthReviewList inChannels={{ seo: 2 }} onResolved={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading what is waiting" })).toBeNull());
    expect(screen.getByText("To approve · 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(screen.getByText("Quick wins · 1")).toBeTruthy();
    expect(screen.getByRole("region", { name: "If you do one thing this week" })).toBeTruthy();
  });
});

describe("review fixes", () => {
  const settled = () => waitFor(() => expect(screen.queryByRole("status", { name: "Loading what is waiting" })).toBeNull());

  it("never one-click approves a high-stakes decision: a Google Ads budget raise goes to its channel", async () => {
    approvals = {
      decisions: [
        {
          id: "raise",
          decision_class: "google_ads.update_campaign_budget",
          body: { rationale: "Raise the budget to $50 a day." },
          handler: "google_ads.update_campaign_budget",
          channel_slug: "google_ads",
        },
      ],
    };
    render(<GrowthReviewList inChannels={{}} onResolved={() => {}} />);
    await settled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    const link = screen.getByRole("link", { name: "Review in Google Ads" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=channels&channel=google_ads&action=raise");
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("says a channel failed to load, never 'Nothing is waiting', and retries", async () => {
    failSlugs = new Set(["seo"]);
    render(<GrowthReviewList inChannels={{ seo: 2 }} onResolved={() => {}} />);
    await settled();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load SEO.");
    expect(screen.queryByText(/Nothing is waiting/)).toBeNull();
    failSlugs = new Set();
    actionsBySlug.seo = [action("a1", { blocking: true })];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "If you do one thing this week" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("shows locked signup previews per channel, never an empty list", async () => {
    previewsBySlug = { seo: 3 };
    render(<GrowthReviewList inChannels={{ seo: 3 }} onResolved={() => {}} />);
    await settled();
    expect(screen.getByText(/3 previews in SEO/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open SEO" }).getAttribute("href")).toBe("/workspace?tab=channels&channel=seo");
    expect(screen.queryByText(/Nothing is waiting/)).toBeNull();
  });

  it("re-reads when the page's approvals read lands again, keeping rows until then", async () => {
    actionsBySlug.seo = [action("a1", { blocking: true, title: "First" })];
    const { rerender } = render(<GrowthReviewList inChannels={{ seo: 1 }} onResolved={() => {}} revision={1} />);
    await screen.findByText("First");
    actionsBySlug.seo = [action("a2", { blocking: true, title: "Second" })];
    rerender(<GrowthReviewList inChannels={{ seo: 1 }} onResolved={() => {}} revision={2} />);
    expect(screen.getByText("First")).toBeTruthy();
    expect(await screen.findByText("Second")).toBeTruthy();
    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});

describe("the last review round", () => {
  const settled = () => waitFor(() => expect(screen.queryByRole("status", { name: "Loading what is waiting" })).toBeNull());

  it("with nothing to approve and nothing in the channels, says nothing is waiting", async () => {
    approvals = { decisions: [] };
    render(<GrowthReviewList inChannels={{}} onResolved={() => {}} />);
    await settled();
    expect(screen.getByText(/Nothing is waiting/)).toBeTruthy();
  });

  it("a high-stakes decision with no channel opens its live card in place, never a link elsewhere", async () => {
    approvals = {
      decisions: [
        { id: "d", decision_class: "meta_ads.budget", body: {}, handler: null, channel_slug: null },
      ],
    };
    render(<GrowthReviewList inChannels={{}} onResolved={() => {}} />);
    await settled();
    expect(screen.queryByRole("link", { name: /Review on Home/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/approvals/d")).toBe(true);
  });

  it("a social post is never one-click: its live card approves with the post revision and the loaded time (F1/F8)", async () => {
    approvals = {
      decisions: [
        {
          id: "s1",
          decision_class: "social.publish.v2",
          handler: "social.publish",
          body: { channel: "x", payload: { text: "Hello" }, scheduled_at: "2026-10-20T16:00:00.000Z" },
          post_revision: "rev-1",
        },
      ],
    };
    const onResolved = vi.fn();
    render(<GrowthReviewList inChannels={{}} onResolved={onResolved} />);
    await settled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveSpy).toHaveBeenCalledWith("s1", { expected_post_revision: "rev-1", expected_scheduled_at: "2026-10-20T16:00:00.000Z" }),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("ACCEPTANCE A2 (web, row part): an Autopilot-held Google cut shows why it was held, and its evidence once opened", async () => {
    approvals = {
      decisions: [
        {
          id: "held-1",
          decision_class: "google_ads.update_campaign_budget_review",
          body: { campaign_id: "1", name: "Search - hosts", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 },
          handler: null,
          channel_slug: null,
          cgo_hold: { words: ["it is not set up to get conversions, so zero conversions says nothing"], evidence: "7-day spend $40, 0 conversions" },
        },
      ],
    };
    render(<GrowthReviewList inChannels={{}} onResolved={() => {}} />);
    await settled();
    const why = screen.getByText("Autopilot held this: it is not set up to get conversions, so zero conversions says nothing");
    expect(screen.queryByText("7-day spend $40, 0 conversions")).toBeNull();
    fireEvent.click(why);
    expect(screen.getByText("7-day spend $40, 0 conversions")).toBeTruthy();
  });
});
