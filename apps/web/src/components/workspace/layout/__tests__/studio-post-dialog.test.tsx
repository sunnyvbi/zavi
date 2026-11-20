// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { STUDIO_PATH } from "../../videoStudio/types";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "k" }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));

const SLUG = "generated_video";
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, clone() { return this; } });
const VIDEOS = [{ artifact_id: "a1", filename: "Summer drop.mp4", created_at: "2026-10-26T10:00:00Z", source: "chat", thread_id: null }];
const TARGETS = [
  { name: "instagram", label: "Instagram", status: "connected" },
  { name: "linkedin", label: "LinkedIn", status: "connected" },
];

let release: ((v: unknown) => void) | null;
let postCalls: number;

beforeEach(() => {
  release = null;
  postCalls = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  Element.prototype.scrollIntoView = () => undefined;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u === `${STUDIO_PATH}/threads`) return res({ threads: [] });
    if (u === `${STUDIO_PATH}/videos`) return res({ videos: VIDEOS });
    if (u === `${STUDIO_PATH}/post-targets`) return res({ targets: TARGETS });
    if (u.endsWith("/post") && init?.method === "POST") {
      postCalls += 1;
      return new Promise((r) => {
        release = r;
      });
    }
    if (u.startsWith("/api/run-artifacts/")) return res({ signed_url: "https://cdn.test/v.mp4" });
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

function Host() {
  const [open, setOpen] = useState(true);
  return (
    <ChannelDrawer detail={open ? detail() : null} actionCount={0} error={null} onClose={() => setOpen(false)} onOpenConnectors={() => {}}>
      <li>row</li>
    </ChannelDrawer>
  );
}

const drawer = () => screen.queryByRole("dialog", { name: detail().channel.name });
const postDialog = () => screen.queryByTestId("video-post-dialog");

async function openPost() {
  render(<Host />);
  await settle();
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: /^Library/ })));
  await settle();
  const opener = screen.getByTestId("video-library-post");
  opener.focus();
  await act(async () => fireEvent.click(opener));
  await settle();
  expect(postDialog()).toBeTruthy();
  return opener;
}

const escape = async () => {
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
};

describe("AI UGC Library Post dialog inside the channel drawer", () => {
  it("Escape closes only the Post dialog and leaves the drawer open on Library", async () => {
    await openPost();
    await escape();
    expect(postDialog()).toBeNull();
    expect(drawer()).toBeTruthy();
    expect(screen.getByTestId("video-library-post")).toBeTruthy();
    await escape();
    expect(drawer()).toBeNull();
  });

  it("Escape while a post is sending keeps both open and the result still shows", async () => {
    await openPost();
    fireEvent.click(screen.getByTestId("video-post-row-instagram").querySelector("input")!);
    await act(async () => fireEvent.click(screen.getByTestId("video-post-submit")));
    expect(postCalls).toBe(1);
    await escape();
    await escape();
    expect(postDialog()).toBeTruthy();
    expect(drawer()).toBeTruthy();
    await act(async () => release?.(res({ results: [{ name: "instagram", status: "failed", message: "Instagram said no." }] })));
    await settle();
    expect(screen.getByTestId("video-post-error").textContent).toBe("Instagram: Instagram said no.");
    expect(drawer()).toBeTruthy();
  });

  it("focus starts inside the dialog, Tab and Shift+Tab stay inside, and closing returns focus to Post", async () => {
    const opener = await openPost();
    const panel = postDialog()!;
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("video-post-row-instagram").querySelector("input"));
    const close = screen.getByTestId("video-post-close");
    const submit = screen.getByTestId("video-post-submit") as HTMLButtonElement;
    fireEvent.click(screen.getByTestId("video-post-row-instagram").querySelector("input")!);
    expect(submit.disabled).toBe(false);
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);
    opener.focus();
    fireEvent.keyDown(opener, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    await act(async () => fireEvent.click(close));
    expect(postDialog()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("video-library-post"));
  });
});
