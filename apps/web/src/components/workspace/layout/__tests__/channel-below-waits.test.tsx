// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../ChannelRunFoot", () => ({
  ChannelRunFoot: ({ memory = true }: { memory?: boolean }) =>
    memory ? (
      <section data-testid="posted-pins">
        <a href="https://pinterest.com/pin/1">Open pin</a>
      </section>
    ) : null,
}));

let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let store = "channel_actions";

afterEach(cleanup);
beforeEach(() => {
  store = "channel_actions";
  gate = new Promise<void>((r) => {
    release = r;
  });
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) =>
    gate.then(() => ({
      ok: true,
      status: 200,
      json: async () =>
        String(path).includes("/settings")
          ? { fields: {} }
          : { actions: [], more: 0, store, metrics: [], briefs: [], artifacts: [] },
    })),
  );
});

const channel = (slug: string) => (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

function detail(slug: string): ChannelDetail {
  return {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: [],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
  };
}

const hiddenUp = (el: HTMLElement) => el.closest("[hidden]") !== null;

describe("the block under the lane waits for the lane", () => {
  it("keeps the run foot out of the layout while the sections above it are still loading", async () => {
    render(<ChannelPanel detail={detail("pinterest_organic")} actionCount={0} onOpenConnectors={() => {}} />);
    const pins = await screen.findByTestId("posted-pins");
    expect(screen.getAllByRole("status", { busy: true }).length).toBeGreaterThan(0);
    expect(hiddenUp(pins)).toBe(true);
    expect(screen.queryByRole("link", { name: "Open pin" })).toBeNull();

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(screen.getByTestId("channel-overview").hidden).toBe(false));
    expect(hiddenUp(screen.getByTestId("posted-pins"))).toBe(false);
    expect(screen.getByRole("link", { name: "Open pin" })).toBeTruthy();
  });

  it("hides it again on a switch to another channel until that channel's lane has painted", async () => {
    release();
    const view = render(<ChannelPanel detail={detail("pinterest_organic")} actionCount={0} onOpenConnectors={() => {}} />);
    await waitFor(() => expect(hiddenUp(screen.getByTestId("posted-pins"))).toBe(false));

    gate = new Promise<void>((r) => {
      release = r;
    });
    view.rerender(<ChannelPanel detail={detail("tiktok_organic")} actionCount={0} onOpenConnectors={() => {}} />);
    expect(screen.getByTestId("channel-overview-below").hidden).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(screen.getByTestId("channel-overview-below").hidden).toBe(false));
  });

  it("does not hide it forever on a channel the lane draws on the legacy rail", async () => {
    store = "decisions";
    release();
    render(<ChannelPanel detail={detail("pinterest_organic")} actionCount={0} onOpenConnectors={() => {}} />);
    await waitFor(() => expect(hiddenUp(screen.getByTestId("posted-pins"))).toBe(false));
  });
});
