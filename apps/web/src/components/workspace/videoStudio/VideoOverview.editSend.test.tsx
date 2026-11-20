// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { VideoOverview } from "./VideoOverview";
import { adDomId } from "./SuggestedAds";
import { STUDIO_PATH, type StudioView } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "k" }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => null, useWorkspace: () => null }));
vi.mock("../actions/useChannelActions", () => ({
  useChannelActions: () => ({ actions: [], refreshSilent: async () => undefined, loading: false, completed: [], more: 0, plan: null, metrics: [] }),
}));

const SLUG = "generated_video";
const SCRIPT = "Stop wasting mornings. Our app plans your day in one tap.";
const EDITED = "My own edited script about busy mornings and one tap plans.";
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

let views: Record<string, StudioView> = {};
let messageAnswer: () => Promise<unknown> = async () => res({});
const messagePosts: Array<Record<string, unknown>> = [];

function view(id: string, status: "done" | null): StudioView {
  return {
    thread_id: id,
    messages: [
      { id: `u-${id}`, role: "user", body: "make an ad", created_at: "2026-10-26T10:00:00Z", kind: null, draft: null, render_run_id: null, run_id: null },
      { id: `m-${id}`, role: "assistant", body: "Here is a draft", created_at: "2026-10-26T10:00:05Z", kind: null, draft: { intent: "talking_head", aspect_ratio: "9:16", visual: "A founder at a desk", script: SCRIPT, hook: null, presenter_gender: null }, render_run_id: status ? `r-${id}` : null, run_id: null },
    ],
    renders: status ? { [`r-${id}`]: { status, started_at: new Date(Date.now() - 1000).toISOString(), videos: [{ artifact_id: `a-${id}`, filename: null }] } } : {},
  } as StudioView;
}

beforeEach(() => {
  views = {};
  messagePosts.length = 0;
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  window.sessionStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u === `${STUDIO_PATH}/threads`) return res({ threads: [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }] });
    if (u.startsWith(`${STUDIO_PATH}?thread_id=`)) {
      const id = decodeURIComponent(u.split("=")[1]);
      return views[id] ? res(views[id]) : res({}, 404);
    }
    if (u === `${STUDIO_PATH}/messages`) {
      messagePosts.push(init?.body ? JSON.parse(init.body) : {});
      return messageAnswer();
    }
    if (u === `/api/channels/${SLUG}/starters`) return res({ run_id: null });
    if (u.startsWith("/api/run-artifacts/")) return res({ signed_url: "https://cdn.test/v.mp4" });
    return res({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = () => document.getElementById(adDomId("thread-t1"))!;

async function editAndMake() {
  await act(async () => {
    render(<VideoOverview slug={SLUG} focusThread={null} />);
  });
  await waitFor(() => expect(card()).not.toBeNull());
  fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(card()).getByLabelText("Script"), { target: { value: EDITED } });
  fireEvent.submit(within(card()).getByRole("form", { name: 'Edit "Planner ad"' }));
  expect(within(card()).getByTestId("suggested-ad-script").textContent).toBe(EDITED);
  await act(async () => {
    fireEvent.click(within(card()).getByRole("button", { name: "Make video" }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("VideoOverview keeps an edited ad when the send makes nothing (bd36 reopened)", () => {
  it("a ready ad keeps the edit when the server answers 200 with render null", async () => {
    views = { t1: view("t1", "done"), new1: view("new1", null) };
    messageAnswer = async () => res({ thread_id: "new1", reply: { body: "That script breaks our rules." }, render: null });
    await editAndMake();
    await waitFor(() => expect(screen.getByTestId("video-overview-status").textContent).toContain("did not make"));
    expect(messagePosts).toEqual([{ text: EDITED, verbatim: true, new_thread: true }]);
    expect(within(card()).getByTestId("suggested-ad-script").textContent).toBe(EDITED);
    expect(within(card()).getByRole("button", { name: "Make video" })).toBeTruthy();
  });

  it("a ready ad drops the edit when the server starts the render", async () => {
    views = { t1: view("t1", "done"), new1: view("new1", null) };
    messageAnswer = async () => res({ thread_id: "new1", reply: null, render: { run_id: "r-new1" } });
    await editAndMake();
    await waitFor(() => expect(within(card()).getByTestId("suggested-ad-script").textContent).toBe(SCRIPT));
    expect(messagePosts).toHaveLength(1);
  });

  it("a not-made thread draft keeps the edit after it shows making and the send fails with a 500", async () => {
    views = { t1: view("t1", null) };
    let fail!: () => void;
    messageAnswer = () => new Promise((r) => (fail = () => r(res({ error: { message: "boom" } }, 500))));
    await editAndMake();
    expect(card().querySelector('[data-testid="suggested-ad"]')!.getAttribute("data-state")).toBe("making");
    expect(messagePosts).toEqual([{ text: EDITED, verbatim: true, thread_id: "t1" }]);
    await act(async () => {
      fail();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(card().querySelector('[data-testid="suggested-ad"]')!.getAttribute("data-state")).not.toBe("making"));
    expect(within(card()).getByTestId("suggested-ad-script").textContent).toBe(EDITED);
    expect(within(card()).getByRole("button", { name: "Make video" })).toBeTruthy();
  });
});
