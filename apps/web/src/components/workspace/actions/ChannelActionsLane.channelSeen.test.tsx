// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { FIXTURES } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const answer = (status: number, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
});

type Seen = () => unknown;
let seenAnswers: Seen[] = [];

const post: ChannelActionView = {
  ...FIXTURES.text_post,
  id: "p1",
  title: "The 3pm slump post",
  plan_day: null,
  plan_day_source: null,
  series: null,
} as ChannelActionView;

function route() {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/channel-seen")) {
      const next = seenAnswers.shift();
      if (!next) return answer(204);
      return next();
    }
    if (u.includes("/actions")) return ok({ actions: [post], more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
}

const seenCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/workspace/channel-seen");
const liveSeenCalls = () =>
  seenCalls().filter((c) => !((c[1] as { signal?: AbortSignal }).signal?.aborted ?? false));

function lane() {
  return (
    <ChannelActionsLane
      slug="email_marketing"
      legacy={<p>legacy rail</p>}
      workState="delivered"
      lastRunAt="2026-10-13T10:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      {null}
    </ChannelActionsLane>
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  seenAnswers = [];
  spec.current = { name: "Email", publish: vi.fn(async () => true) } as unknown as PlatformSpec;
  Element.prototype.scrollIntoView = () => {};
  route();
});
afterEach(cleanup);

describe("the first-load channel-seen ping", () => {
  it("is sent again after the backend's fail-closed 503 and lands on the second try", async () => {
    seenAnswers = [() => answer(503, { "Retry-After": "0" })];
    render(lane());
    await screen.findByTestId("action-p1");
    await waitFor(() => expect(seenCalls()).toHaveLength(2));
    const bodies = seenCalls().map((c) => JSON.parse(String((c[1] as { body: string }).body)));
    expect(bodies).toEqual([{ slug: "email_marketing" }, { slug: "email_marketing" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(seenCalls()).toHaveLength(2);
  });

  it("is sent again after a dropped connection on load", async () => {
    seenAnswers = [
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(lane());
      await screen.findByTestId("action-p1");
      await waitFor(() => expect(seenCalls()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => expect(seenCalls()).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after a bounded number of 503s instead of hammering the backend", async () => {
    seenAnswers = Array.from({ length: 10 }, () => () => answer(503, { "Retry-After": "0" }));
    render(lane());
    await screen.findByTestId("action-p1");
    await waitFor(() => expect(seenCalls()).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 50));
    expect(seenCalls()).toHaveLength(4);
  });

  it("does not resend a request the backend refused for good", async () => {
    seenAnswers = [() => answer(400)];
    render(lane());
    await screen.findByTestId("action-p1");
    await waitFor(() => expect(seenCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(seenCalls()).toHaveLength(1);
  });

  it("sends nothing more once the lane is gone while it waits out Retry-After", async () => {
    seenAnswers = [() => answer(503, { "Retry-After": "1" })];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = render(lane());
      await screen.findByTestId("action-p1");
      await waitFor(() => expect(seenCalls()).toHaveLength(1));
      view.unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(seenCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("under StrictMode's double mount, exactly one live ping goes out once the cards are on screen", async () => {
    render(<StrictMode>{lane()}</StrictMode>);
    await screen.findByTestId("action-p1");
    await waitFor(() => expect(liveSeenCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(liveSeenCalls()).toHaveLength(1);
  });
});
