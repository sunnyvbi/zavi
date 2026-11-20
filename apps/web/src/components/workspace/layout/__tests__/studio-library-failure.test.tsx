// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { STUDIO_PATH } from "../../videoStudio/types";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "k" }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));

const SLUG = "generated_video";
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, clone() { return this; } });
const RAW = "db timeout xyz";
const VIDEOS = [
  { artifact_id: "a1", filename: "Summer drop.mp4", created_at: "2026-10-26T10:00:00Z", source: "chat", thread_id: null },
  { artifact_id: "a2", filename: "Winter drop.mp4", created_at: "2026-10-25T10:00:00Z", source: "chat", thread_id: null },
];

let failing = false;

beforeEach(() => {
  failing = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  Element.prototype.scrollIntoView = () => undefined;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === `${STUDIO_PATH}/threads`) return res({ threads: [] });
    if (u === `${STUDIO_PATH}/videos`) return failing ? res({ error: { message: RAW } }, 500) : res({ videos: VIDEOS });
    if (u.match(/^\/api\/channels\/[a-z_]+\/actions/)) return res({ actions: [], more: 0, store: "channel_actions" });
    if (u.match(/^\/api\/channels\/[a-z_]+\/history/)) return res({ runs: [], closed: [], pre_switch: [] });
    return res({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function detail(): ChannelDetail {
  const channel = (CHANNELS as readonly Channel[]).find((c) => c.slug === SLUG)!;
  return { channel, mode: "produce", connected: true, connectors: [], workState: "delivered", lastRunAt: new Date().toISOString(), lastProbeAt: null, lastProbeDelta: null, runnable: true };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function openLibrary() {
  render(
    <ChannelDrawer detail={detail()} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}}>
      <li>row</li>
    </ChannelDrawer>,
  );
  await settle();
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: /^Library/ })));
  await settle();
}

const cards = () => screen.queryAllByTestId("video-library-item");

describe("AI UGC Library load failures", () => {
  it("a Refresh that gets a 5xx keeps the cards on screen and shows plain copy, not the server text", async () => {
    await openLibrary();
    expect(cards()).toHaveLength(2);
    failing = true;
    await act(async () => fireEvent.click(screen.getByTestId("video-library-refresh")));
    await settle();
    expect(cards()).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("Zavi could not load your videos. Try again.");
    expect(document.body.textContent).not.toContain(RAW);
  });

  it("a first load that gets a 5xx shows plain copy, not the server text", async () => {
    failing = true;
    await openLibrary();
    expect(cards()).toHaveLength(0);
    expect(within(screen.getByTestId("video-library")).getByRole("alert").textContent).toBe("Zavi could not load your videos. Try again.");
    expect(document.body.textContent).not.toContain(RAW);
  });

  it("a later good Refresh clears the error", async () => {
    await openLibrary();
    failing = true;
    await act(async () => fireEvent.click(screen.getByTestId("video-library-refresh")));
    await settle();
    expect(screen.getByRole("alert")).toBeTruthy();
    failing = false;
    await act(async () => fireEvent.click(screen.getByTestId("video-library-refresh")));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(cards()).toHaveLength(2);
  });
});
