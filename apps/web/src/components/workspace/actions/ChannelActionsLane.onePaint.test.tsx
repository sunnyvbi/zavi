// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import type { PlatformSpec } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/analytics/posthog", () => ({ captureEvent: vi.fn() }));

vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import { cardKind } from "./registry";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const PAYLOAD = {
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  prev_period: { from: "2026-07-21", to: "2026-08-19" },
  account: null,
  kpis: [
    {
      key: "spend",
      label: "Spend",
      value: 4820,
      prev: null,
      delta_pct: null,
      delta_abs: null,
      delta_good: null,
      unit: "usd",
    },
  ],
  campaigns: [],
  totals: null,
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
};

const CARD = makeAction("text_post", {
  id: "ca-1",
  title: "The action the actions read already answered with",
});

let actions = [CARD];

function route(dashboard: () => Promise<unknown> | unknown) {
  actions = [CARD];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    if (u.includes("/dashboard")) return dashboard();
    if (u.includes("/run")) return ok({ run_id: "r-1" });
    throw new Error(`unexpected request: ${u}`);
  });
}

function lane(slug: string, workState: "idle" | "running" | "delivered" = "idle") {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy rail</p>}
      workState={workState}
      lastRunAt="2026-09-20T10:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

const painted = () =>
  document.querySelector<HTMLElement>('[data-testid="channel-overview"]')?.hidden === false;
const loading = () =>
  document.querySelector('[data-testid="channel-overview-loading"]') !== null;
const cardOnScreen = () => document.body.textContent?.includes(CARD.title) ?? false;

const actionReads = () =>
  apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/actions"));

beforeEach(() => {
  apiFetch.mockReset();
  spec.current = { name: "Google Ads", kpiFallback: "gads" };
});
afterEach(cleanup);

describe("the first paint", () => {
  it("projects publishing identity from the existing dashboard into post previews", async () => {
    spec.current = {
      name: "LinkedIn", kpiFallback: "gads",
      account: { name: "Personal profile" },
      accountFromPayload: payload => (payload as { publishing_account?: { name: string } } | null)?.publishing_account,
    };
    route(() => ok({ ...PAYLOAD, account: { name: "Company metrics" }, publishing_account: { name: "Verified personal account" } }));
    const view = lane("one-paint-publishing-identity");
    expect((await view.findByTestId("publishing-account")).textContent).toContain("Verified personal account");
    expect(apiFetch.mock.calls.filter(([url]) => String(url).includes("/dashboard"))).toHaveLength(1);
  });
  it("leaves the publishing line out when the channel hides it", async () => {
    const accountFromPayload = vi.fn((payload: unknown) => (payload as { publishing_account?: { name: string } } | null)?.publishing_account);
    spec.current = { name: "LinkedIn", kpiFallback: "gads", hidePublishingAccount: true, accountFromPayload };
    route(() => ok({ ...PAYLOAD, publishing_account: { name: "Verified personal account" } }));
    const view = lane("one-paint-hidden-publishing-identity");
    await waitFor(() => expect(accountFromPayload).toHaveBeenCalledWith(expect.objectContaining({ publishing_account: { name: "Verified personal account" } })));
    await act(async () => {});
    expect(view.queryByTestId("publishing-account")).toBeNull();
  });
  it("holds the whole Overview until the dashboard read settles, then shows it all at once", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = () => r();
    });
    route(async () => {
      await held;
      return ok(PAYLOAD);
    });

    lane("one-paint-held");

    await waitFor(() => expect(actionReads().length).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(loading()).toBe(true);
    expect(painted()).toBe(false);
    expect(document.querySelector('[data-testid="channel-overview"]')?.contains(
      document.querySelector('[data-metric="spend"]'),
    )).not.toBe(true);

    await act(async () => {
      release?.();
      await held;
    });

    await waitFor(() => expect(painted()).toBe(true));
    expect(loading()).toBe(false);
    expect(cardOnScreen()).toBe(true);
    expect(document.querySelector('[data-metric="spend"]')?.textContent).toContain("$4,820");
  });

  it("shows the action cards after 3s when the numbers are still loading, then the numbers once", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = () => r();
    });
    route(async () => {
      await held;
      return ok(PAYLOAD);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      lane("one-paint-capped");
      await waitFor(() => expect(actionReads().length).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(painted()).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      await waitFor(() => expect(painted()).toBe(true));
      expect(cardOnScreen()).toBe(true);
      expect(document.querySelector('[data-testid="channel-numbers-loading"]')).not.toBeNull();
      expect(document.querySelector('[data-metric="spend"]')).toBeNull();
      await act(async () => {
        release?.();
        await held;
      });
      await waitFor(() => expect(document.querySelector('[data-metric="spend"]')?.textContent).toContain("$4,820"));
      expect(document.querySelector('[data-testid="channel-numbers-loading"]')).toBeNull();
      expect(cardOnScreen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a creator card landing after the 3s paint does not hide a card already on screen", async () => {
    route(() => ok(PAYLOAD));
    spec.current = { name: "Meta Ads" };
    const kind = cardKind(CARD);
    const props = (settled: boolean) => ({
      slug: "one-paint-late-extras",
      legacy: <p>legacy rail</p>,
      workState: "idle" as const,
      lastRunAt: "2026-09-20T10:00:00Z",
      actionCount: 0,
      connected: true,
      hasConnectors: true,
      children: <li>an approvals row</li>,
      extraCards: { cards: settled ? [<p key="x">creator card</p>] : [], settled, position: "before" as const, kinds: settled ? [kind] : [] },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = render(<ChannelActionsLane {...props(false)} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      await waitFor(() => expect(painted()).toBe(true));
      expect(cardOnScreen()).toBe(true);
      view.rerender(<ChannelActionsLane {...props(true)} />);
      await waitFor(() => expect(document.body.textContent).toContain("creator card"));
      expect(cardOnScreen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creator cards that settled before a late dashboard paint beside the action card", async () => {
    route(() => new Promise(() => {}));
    const kind = cardKind(CARD);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <ChannelActionsLane slug="one-paint-extras-first" legacy={<p>legacy rail</p>} workState="idle" lastRunAt="2026-09-20T10:00:00Z" actionCount={0} connected hasConnectors
          extraCards={{ cards: [<p key="x">creator card</p>], settled: true, position: "before", kinds: [kind] }}>
          <li>an approvals row</li>
        </ChannelActionsLane>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      await waitFor(() => expect(painted()).toBe(true));
      expect(document.body.textContent).toContain("creator card");
      expect(cardOnScreen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paints without the numbers when the dashboard read fails, rather than waiting forever", async () => {
    route(() => ({ ok: false, status: 500, json: async () => ({}) }));

    const view = lane("one-paint-dead-dashboard");

    await waitFor(() => expect(painted()).toBe(true));
    expect(loading()).toBe(false);
    expect(cardOnScreen()).toBe(true);
    expect(document.querySelector('[data-metric="spend"]')).toBeNull();
    expect(view.queryByTestId("channel-value-empty")).not.toBeNull();
  });

  it("does not wait on a dashboard for a channel that asks for none", async () => {
    spec.current = { name: "Reddit" };
    route(() => {
      throw new Error("this channel must not ask for a dashboard");
    });

    lane("one-paint-no-dashboard");

    await waitFor(() => expect(painted()).toBe(true));
    expect(cardOnScreen()).toBe(true);
  });
});

describe("after the first paint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function settle() {
    for (let i = 0; i < 6; i += 1) await tick(0);
  }

  it("the mid-run silent poll does not bring the loader back", async () => {
    let releasePoll: (() => void) | null = null;
    const pollRead = new Promise<void>((r) => {
      releasePoll = () => r();
    });
    let reads = 0;
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/actions")) {
        reads += 1;
        if (reads > 1) await pollRead;
        return ok({ actions, more: 0, store: "channel_actions" });
      }
      if (u.includes("/metrics")) return ok({ metrics: [] });
      return ok(PAYLOAD);
    });
    actions = [CARD];

    lane("one-paint-poll", "running");
    await settle();
    expect(painted()).toBe(true);

    actions = [CARD, makeAction("check", { id: "ca-2", title: "Written mid-run" })];
    await tick(20_000);

    expect(reads).toBeGreaterThan(1);
    expect(loading()).toBe(false);
    expect(painted()).toBe(true);
    expect(cardOnScreen()).toBe(true);

    await act(async () => {
      releasePoll?.();
      await pollRead;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(painted()).toBe(true);
    expect(document.body.textContent).toContain("Written mid-run");
  });

  it("a reload started from the page does not blank it either", async () => {
    let releaseSecond: (() => void) | null = null;
    const secondRead = new Promise<void>((r) => {
      releaseSecond = () => r();
    });
    let reads = 0;
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/actions")) {
        reads += 1;
        if (reads > 1) await secondRead;
        return ok({ actions, more: 3, store: "channel_actions" });
      }
      if (u.includes("/metrics")) return ok({ metrics: [] });
      return ok(PAYLOAD);
    });
    const untouched = makeAction("check", { id: "ca-3", title: "The card nobody pressed" });
    actions = [CARD, untouched];

    const view = lane("one-paint-reload");
    await settle();
    expect(painted()).toBe(true);
    expect(document.body.textContent).toContain(untouched.title);

    const pressed = view.getAllByText(CARD.title)[0].closest("article") as HTMLElement;
    await act(async () => {
      within(pressed).getByRole("button", { name: /more actions/i }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      view.getByRole("menuitem", { name: /^Done/ }).click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reads).toBeGreaterThan(1);
    expect(loading()).toBe(false);
    expect(painted()).toBe(true);
    expect(cardOnScreen()).toBe(true);
    expect(within(pressed).queryByRole("button", { name: /more actions/i })).toBeNull();
    expect(document.body.textContent).toContain(untouched.title);

    await act(async () => {
      releaseSecond?.();
      await secondRead;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(painted()).toBe(true);
  });
});
