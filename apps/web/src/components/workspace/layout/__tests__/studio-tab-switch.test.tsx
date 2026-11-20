// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { STUDIO_PATH, type StudioView } from "../../videoStudio/types";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";
import { CHANNEL_TAB_EVENT } from "../../actions/topActions/api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "k" }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../videoStudio/VideoLibrary", () => ({
  VideoLibrary: ({ onOpenChat }: { onOpenChat?: (id: string) => void }) => (
    <div data-testid="library-stub">
      <button type="button" onClick={() => onOpenChat?.("t1")}>
        Open t1
      </button>
    </div>
  ),
}));

const SLUG = "generated_video";
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, clone() { return this; } });

function view(id: string): StudioView {
  return {
    thread_id: id,
    messages: [
      { id: `u-${id}`, role: "user", body: "make an ad", created_at: "2026-10-26T10:00:00Z", kind: null, draft: null, render_run_id: null, run_id: null },
      {
        id: `m-${id}`,
        role: "assistant",
        body: "Here is a draft",
        created_at: "2026-10-26T10:00:05Z",
        kind: null,
        draft: { intent: "talking_head", aspect_ratio: "9:16", visual: "desk", script: "Stop wasting mornings. One tap.", hook: null, presenter_gender: null },
        render_run_id: null,
        run_id: null,
      },
    ],
    renders: {},
  } as StudioView;
}

const scrolled: string[] = [];
let failSend = false;

beforeEach(() => {
  scrolled.length = 0;
  failSend = false;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u === `${STUDIO_PATH}/threads`) return res({ threads: [{ id: "t1", title: "Old ad", last_message_at: "2026-10-25T00:00:00Z" }] });
    if (u.startsWith(`${STUDIO_PATH}?thread_id=`)) return res(view(decodeURIComponent(u.split("=")[1])));
    if (u === `${STUDIO_PATH}/messages`) return failSend ? res({ error: { message: "Zavi is busy right now." } }, 500) : new Promise(() => undefined);
    if (u === `${STUDIO_PATH}/videos`) return res({ videos: [] });
    if (u === "/api/chat/upload-image") return res({ image_path: "uploads/car.png" });
    if (u.match(/^\/api\/channels\/[a-z_]+\/actions/)) return res({ actions: [], more: 0, store: "channel_actions" });
    if (u.match(/^\/api\/channels\/[a-z_]+\/history/)) return res({ runs: [], closed: [], pre_switch: [] });
    if (init?.method && init.method !== "GET") return res({ ok: true });
    return res({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function detail(): ChannelDetail {
  const channel = (CHANNELS as readonly Channel[]).find((c) => c.slug === SLUG)!;
  return {
    channel,
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

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function open() {
  render(
    <ChannelDrawer detail={detail()} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}}>
      <li>row</li>
    </ChannelDrawer>,
  );
  await settle();
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
async function go(name: string) {
  await act(async () => fireEvent.click(tab(name)));
  await settle();
}
const script = () => screen.getByLabelText("Your script") as HTMLTextAreaElement;
const promptSwitch = () => screen.getByRole("switch", { name: /Enable prompt/ });
const ads = () => screen.queryAllByTestId("suggested-ad");

describe("AI UGC channel: Overview survives a trip to Library", () => {
  it("keeps the typed script and Enable prompt", async () => {
    await open();
    fireEvent.change(script(), { target: { value: "QA keep test text" } });
    await act(async () => fireEvent.click(promptSwitch()));
    expect(promptSwitch().getAttribute("aria-checked")).toBe("true");

    await go("Library");
    expect(screen.getByTestId("library-stub")).toBeTruthy();
    await go("Overview");

    expect(script().value).toBe("QA keep test text");
    expect(promptSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps Image to video mode, the attached image and its motion text", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Image to video/ })));
    const file = new File(["png"], "car.png", { type: "image/png" });
    await act(async () => fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [file] } }));
    await settle();
    fireEvent.change(screen.getByLabelText("How the image should move"), { target: { value: "Slow pan left" } });
    expect(screen.getByTestId("video-studio-attachment")).toBeTruthy();

    await go("Library");
    await go("Overview");

    expect(screen.getByRole("radio", { name: /Image to video/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("video-studio-attachment")).toBeTruthy();
    expect((screen.getByLabelText("How the image should move") as HTMLTextAreaElement).value).toBe("Slow pan left");
  });

  it("keeps a failed new ad", async () => {
    failSend = true;
    await open();
    fireEvent.change(script(), { target: { value: "Fail me once and keep this ad on screen" } });
    await act(async () => fireEvent.click(within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Generate" })));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    expect(apiFetch.mock.calls.some((c) => String(c[0]) === `${STUDIO_PATH}/messages`)).toBe(true);

    await go("Library");
    await go("Overview");

    expect(ads()[0].getAttribute("data-state")).toBe("failed");
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toContain("keep this ad on screen");
    expect(within(ads()[0]).getByRole("alert").textContent).toBe("Zavi could not start this video. Try again.");
  });

  it("scrolls to an ad opened from Library once per open, not on every return to Overview", async () => {
    await open();
    await go("Library");
    scrolled.length = 0;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open t1" })));
    await settle();
    expect(scrolled.filter((id) => id === "suggested-ad-thread-t1")).toHaveLength(1);

    scrolled.length = 0;
    await go("Library");
    await go("Overview");
    expect(scrolled).not.toContain("suggested-ad-thread-t1");

    await go("Library");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open t1" })));
    await settle();
    expect(scrolled.filter((id) => id === "suggested-ad-thread-t1")).toHaveLength(1);
  });
  it("a top action switching tabs clears the opened ad like the tab bar does, so opening it again scrolls again", async () => {
    await open();
    const sendTab = async (tab: string) => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(CHANNEL_TAB_EVENT, { detail: { slug: SLUG, tab } }));
      });
      await settle();
    };
    await sendTab("library");
    expect(screen.getByTestId("library-stub")).toBeTruthy();
    scrolled.length = 0;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open t1" })));
    await settle();
    expect(scrolled.filter((id) => id === "suggested-ad-thread-t1")).toHaveLength(1);

    await sendTab("library");
    expect(screen.getByTestId("library-stub")).toBeTruthy();
    scrolled.length = 0;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open t1" })));
    await settle();
    expect(scrolled.filter((id) => id === "suggested-ad-thread-t1")).toHaveLength(1);
  });
});
