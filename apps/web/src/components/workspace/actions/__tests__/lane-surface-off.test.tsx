// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { FIXTURES } from "./fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const WITH_TOP_ACTIONS: PlatformSpec = {
  name: "Made-up channel",
  topActions: [
    { key: "find_threads", label: "Find threads", modal: "scan", lead: "l", primary: "Find threads", done: "d" },
  ],
} as PlatformSpec;

function lane(surfaceOff: boolean) {
  return render(
    <ChannelActionsLane slug="made_up" legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={1} connected hasConnectors surfaceOff={surfaceOff}>
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    return ok({});
  });
  spec.current = WITH_TOP_ACTIONS;
});
afterEach(cleanup);

describe("top actions follow the channel's surface switch", () => {
  it("offers the top actions while the surface is on", async () => {
    lane(false);
    expect((await screen.findAllByText("Ask three recent customers for a quote")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: "Find threads" })).toBeTruthy();
  });

  it("draws no top action, so nothing can start a scan against a switched-off surface", async () => {
    lane(true);
    expect((await screen.findAllByText("Ask three recent customers for a quote")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Find threads" })).toBeNull();
  });
});
