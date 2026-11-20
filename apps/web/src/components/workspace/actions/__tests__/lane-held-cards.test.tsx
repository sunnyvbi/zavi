// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: { name: "Reddit" } as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { FIXTURES } from "./fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const QUEUED = "8 more Reddit steps are queued. I'll bring a few out each day so you're not buried.";

let list: Record<string, unknown>;
function lane() {
  return render(
    <ChannelActionsLane slug="reddit_organic" legacy={<p>legacy rail</p>} workState="delivered" lastRunAt={null} actionCount={0} connected hasConnectors={false}>
      {null}
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  list = { actions: [], more: 0, store: "channel_actions", held_count: 8 };
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes("/actions/release-held") && init?.method === "POST") {
      list = { actions: [FIXTURES.other], more: 0, store: "channel_actions" };
      return ok({ ok: true, released: 8 });
    }
    if (url.includes("/actions")) return ok(list);
    return ok({});
  });
});
afterEach(cleanup);

describe("held signup cards on a channel page", () => {
  it("shows the queued line instead of the empty state, and Show them now brings the cards out", async () => {
    lane();
    expect(await screen.findByText(QUEUED)).toBeTruthy();
    expect(screen.queryByTestId("run-channel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show them now" }));
    expect((await screen.findAllByText("Ask three recent customers for a quote")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByTestId("held-cards-queued")).toBeNull());
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/reddit_organic/actions/release-held", expect.objectContaining({ method: "POST" }));
  });

  it("shows the queued line beside cards already on the page", async () => {
    list = { actions: [FIXTURES.other], more: 0, store: "channel_actions", held_count: 8 };
    lane();
    expect((await screen.findAllByText("Ask three recent customers for a quote")).length).toBeGreaterThan(0);
    expect(screen.getByText(QUEUED)).toBeTruthy();
  });

  it("says nothing about a queue when no card is held", async () => {
    list = { actions: [], more: 0, store: "channel_actions" };
    lane();
    expect(await screen.findByTestId("run-channel")).toBeTruthy();
    expect(screen.queryByTestId("held-cards-queued")).toBeNull();
  });
});
