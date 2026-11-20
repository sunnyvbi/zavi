// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PlatformSpec } from "../types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const approveDecision = vi.hoisted(() => vi.fn());
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { FIXTURES } from "./fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const DRAFT_TEXT = "Your car sat idle all weekend. Not because demand was low.";

const stagedCard = (id = "decision-1"): ChannelActionView => ({
  ...FIXTURES.other,
  id,
  action_type: "text_post",
  title: "Post this",
  body: { step: { deliverable: { kind: "post", label: "Post", content: DRAFT_TEXT } } },
});

function route() {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    if (url.includes("/metrics")) return ok({ metrics: [] });
    if (url.includes("/dashboard")) return ok({ connected: true, drafts: [{ decision_id: "decision-1", text: DRAFT_TEXT }] });
    return ok({});
  });
}

const pressDone = async (card: HTMLElement) => {
  fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: "More actions" })));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Done/ }));
};

function lane(slug: string) {
  return render(
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

const WITH_STAGED: PlatformSpec = {
  name: "Made-up channel",
  kpiFallback: "gads",
  stagedCards: () => [stagedCard()],
};

beforeEach(() => {
  apiFetch.mockReset();
  approveDecision.mockReset();
  approveDecision.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  route();
});
afterEach(cleanup);

describe("a draft the agent staged but wrote no action row for", () => {
  it("is drawn as a card, FIRST, rather than left to the approvals fold", async () => {
    spec.current = WITH_STAGED;
    const view = lane("staged-shown");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const html = view.container.innerHTML;
    expect(html.indexOf(DRAFT_TEXT)).toBeLessThan(html.indexOf(FIXTURES.other.title));
  });

  it("Done on it retires the proposal and never publishes", async () => {
    spec.current = WITH_STAGED;
    lane("staged-verb");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const card = screen.getByText(DRAFT_TEXT).closest("article") as HTMLElement;
    await pressDone(card);
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([u]) => String(u) === "/api/approvals/decision-1/reject")).toBe(true),
    );
    expect(approveDecision).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/actions/decision-1"))).toBe(false);
  });

  it("re-reads the payload after a verb, so the card can leave", async () => {
    spec.current = WITH_STAGED;
    lane("staged-refresh");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const dashboardReads = () => apiFetch.mock.calls.filter(([u]) => String(u).includes("/dashboard")).length;
    const before = dashboardReads();
    const card = screen.getByText(DRAFT_TEXT).closest("article") as HTMLElement;
    await pressDone(card);
    await waitFor(() => expect(dashboardReads()).toBeGreaterThan(before));
  });

  it("FALSIFIER: without the key the draft never reaches the page", async () => {
    spec.current = { name: "Made-up channel", kpiFallback: "gads" };
    lane("staged-absent");
    await waitFor(() => expect(screen.getByText(FIXTURES.other.title)).toBeTruthy());
    expect(screen.queryByText(DRAFT_TEXT)).toBeNull();
  });
});

describe("a check card", () => {
  const checkCard = (): ChannelActionView => ({
    ...FIXTURES.other,
    id: "check:pinned",
    action_type: "fix",
    title: "No pinned post",
    body: { step: { title: "No pinned post", body: "Pin the best performer.", effort: "minutes" } },
  });

  const WITH_CHECK: PlatformSpec = { name: "Made-up channel", kpiFallback: "gads", stagedCards: () => [checkCard()] };

  it("sends I did this to the dismissal route, never to /actions/:id", async () => {
    route();
    spec.current = WITH_CHECK;
    lane("check-verb");
    await waitFor(() => expect(screen.getByText("No pinned post")).toBeTruthy());
    const card = screen.getByText("No pinned post").closest("article") as HTMLElement;
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /I did this|^Done$/ })));
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/actions/check:pinned"))).toBe(false);
    expect(approveDecision).not.toHaveBeenCalled();
  });

  it("offers no verb that has nowhere to go", async () => {
    route();
    spec.current = WITH_CHECK;
    lane("check-verbs");
    await waitFor(() => expect(screen.getByText("No pinned post")).toBeTruthy());
    const card = screen.getByText("No pinned post").closest("article") as HTMLElement;
    await waitFor(() => expect(within(card).getByRole("button", { name: /I did this|^Done$/ })).toBeTruthy());
    expect(within(card).queryByRole("button", { name: /Dismiss/i })).toBeNull();
    const more = within(card).queryByRole("button", { name: "More actions" });
    if (more) fireEvent.click(more);
    expect(screen.queryByRole("menuitem", { name: /Dismiss/i })).toBeNull();
  });

  it("FALSIFIER: a card with a real row still offers Not now", async () => {
    route();
    spec.current = { name: "Made-up channel", kpiFallback: "gads" };
    lane("check-falsifier");
    await waitFor(() => expect(screen.getByText(FIXTURES.other.title)).toBeTruthy());
    const card = screen.getByText(FIXTURES.other.title).closest("article") as HTMLElement;
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: "More actions" })));
    expect(screen.getByRole("menuitem", { name: /^Not now$/ })).toBeTruthy();
  });

  it("is drawn BELOW the ranked cards, unlike a staged draft", async () => {
    route();
    spec.current = WITH_CHECK;
    const view = lane("check-order");
    await waitFor(() => expect(screen.getByText("No pinned post")).toBeTruthy());
    const html = view.container.innerHTML;
    expect(html.indexOf("No pinned post")).toBeGreaterThan(html.indexOf(FIXTURES.other.title));
  });
});

describe("the five-card fold", () => {
  const drafts = Array.from({ length: 8 }, (_, i) => ({
    ...stagedCard(`decision-${i}`),
    body: { step: { deliverable: { kind: "post", label: "Post", content: `draft number ${i}` } } },
  }));

  it("shows every draft on the channel page without a fold", async () => {
    route();
    spec.current = { name: "Made-up channel", kpiFallback: "gads", stagedCards: () => drafts };
    lane("fold");
    await waitFor(() => expect(screen.getByText("draft number 0")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId("action-section")[0].querySelectorAll("article")).toHaveLength(9));
    expect(screen.getByText("draft number 7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("a verb that failed", () => {
  it("says so on a staged draft, the way it already does on a ranked card", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/approvals/") && String(url).endsWith("/reject"))
        return { ok: false, status: 500, json: async () => ({ error: { message: "X did not take the post." } }) };
      if (String(url).includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
      if (String(url).includes("/metrics")) return ok({ metrics: [] });
      if (String(url).includes("/dashboard"))
        return ok({ connected: true, drafts: [{ decision_id: "decision-1", text: DRAFT_TEXT }] });
      return ok({});
    });
    spec.current = WITH_STAGED;
    lane("staged-fail");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const card = screen.getByText(DRAFT_TEXT).closest("article") as HTMLElement;
    await pressDone(card);
    await waitFor(() => expect(screen.getByText("X did not take the post.")).toBeTruthy());
  });

  it("says so on a check card too", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/checks/")) return { ok: false, status: 503, json: async () => ({}) };
      if (String(url).includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
      if (String(url).includes("/metrics")) return ok({ metrics: [] });
      if (String(url).includes("/dashboard")) return ok({ connected: true, drafts: [] });
      return ok({});
    });
    spec.current = {
      name: "Made-up channel",
      kpiFallback: "gads",
      stagedCards: () => [
        {
          ...FIXTURES.other,
          id: "check:pinned",
          action_type: "fix",
          title: "No pinned post",
          body: { step: { title: "No pinned post", body: "Pin the best performer.", effort: "minutes" } },
        } as ChannelActionView,
      ],
    };
    lane("check-fail");
    await waitFor(() => expect(screen.getByText("No pinned post")).toBeTruthy());
    const card = screen.getByText("No pinned post").closest("article") as HTMLElement;
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /I did this|^Done$/ })));
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy());
  });
});

describe("a staged draft that was already published", () => {
  it("cannot be published a second time while the payload re-read is in flight", async () => {
    let approved = false;
    let proposeCalls = 0;
    let dashHits = 0;
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/social/propose")) {
        proposeCalls += 1;
        return ok({ decision_id: `new-decision-${proposeCalls}` });
      }
      if (u.includes("/dashboard")) {
        dashHits += 1;
        if (dashHits > 2) await new Promise((r) => setTimeout(r, 300));
        return ok({
          connected: true,
          attention: [],
          drafts: approved
            ? []
            : [{ decision_id: "decision-1", source: "staged", text: DRAFT_TEXT, channel: "x", thread: null }],
        });
      }
      if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/metrics")) return ok({ metrics: [] });
      return ok({});
    });
    approveDecision.mockImplementation(async () => {
      approved = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { x_organic } = await import("../platforms/x_organic");
    const { stagedCardsFromPayload } = await import("../../agent/xStagedPosts");
    spec.current = {
      ...x_organic,
      stagedCards: (p, a) => stagedCardsFromPayload(p, a as ChannelActionView[]),
    } as PlatformSpec;

    lane("x_organic");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const card = screen.getByText(DRAFT_TEXT).closest("article") as HTMLElement;
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /^Post on / })));
    await waitFor(() => expect(approveDecision.mock.calls.length).toBeGreaterThan(0));

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const live = screen.queryByText(DRAFT_TEXT);
      if (!live) break;
      const again = within(live.closest("article") as HTMLElement).queryByRole("button", {
        name: /^Post on /,
      }) as HTMLButtonElement | null;
      if (again && !again.disabled) {
        fireEvent.click(again);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(proposeCalls).toBe(0);
    expect(approveDecision.mock.calls).toEqual([["decision-1"]]);
  });

  it("does not report a rejection after the post succeeded", async () => {
    let rejectCalls = 0;
    let approved2 = false;
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/reject")) {
        rejectCalls += 1;
        return ok({});
      }
      if (u.includes("/dashboard")) {
        return ok({
          connected: true,
          attention: [],
          drafts: approved2
            ? []
            : [{ decision_id: "decision-1", source: "staged", text: DRAFT_TEXT, channel: "x", thread: null }],
        });
      }
      if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/metrics")) return ok({ metrics: [] });
      return ok({});
    });
    approveDecision.mockImplementation(async () => {
      approved2 = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { x_organic } = await import("../platforms/x_organic");
    const { stagedCardsFromPayload } = await import("../../agent/xStagedPosts");
    spec.current = {
      ...x_organic,
      stagedCards: (p, a) => stagedCardsFromPayload(p, a as ChannelActionView[]),
    } as PlatformSpec;

    lane("x_organic");
    await waitFor(() => expect(screen.getByText(DRAFT_TEXT)).toBeTruthy());
    const card = screen.getByText(DRAFT_TEXT).closest("article") as HTMLElement;
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /^Post on / })));
    await waitFor(() => expect(approveDecision.mock.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400));

    expect(rejectCalls).toBe(0);
    expect(screen.queryByText(/Rejected/i)).toBeNull();
  });
});
