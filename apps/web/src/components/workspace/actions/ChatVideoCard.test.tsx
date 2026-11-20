// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CARD_MAX_POLLS, CARD_POLL_MS, CARD_WAITING_POLL_MS, ChatVideoCard } from "./ChatVideoCard";
import { RENDER_POLL_MS } from "../videoStudio/studioApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), apiFetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => null, useWorkspace: () => null }));

const ID = "11111111-1111-4111-8111-111111111111";
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const card = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: "Hook: why yoga",
  status: "pending",
  note: null,
  exec_status: null,
  body: { cost_credits: 420, step: { deliverable: { content: "Stop scrolling. Yoga helps." } } },
  ...over,
});
const made = card({ status: "acted", exec_status: "executed", body: { media: { kind: "video", url: "https://x.test/v.mp4", download_url: "https://x.test/d.mp4" } } });

let current: unknown;
let approveAnswer: unknown;
let messageAnswer: unknown;
let studioAnswer: unknown;
const stateOf = () => screen.getByTestId("suggested-ad").getAttribute("data-state");
const messageCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).endsWith("/studio/messages"));
const studioReads = () => apiFetch.mock.calls.filter((c) => String(c[0]).includes("/studio?thread_id="));
const READ_ONLY_LINKS = new Set(["How it works", "What it is"]);
const pressable = () => screen.queryAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled && !READ_ONLY_LINKS.has(b.textContent?.trim() ?? ""));
const rendering = { messages: [], renders: { "run-2": { status: "rendering", started_at: "2026-11-02T10:00:00Z", videos: [] } } };
const renderDone = { messages: [], renders: { "run-2": { status: "done", started_at: "2026-11-02T10:00:00Z", videos: [{ artifact_id: "art-2" }] } } };
const tickFor = async (ms: number) => {
  for (let t = 0; t < ms; t += 1000) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
};
const editAndMake = async (script: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: /script/i }), { target: { value: script } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Make video" }));
  await flush();
  await flush();
};
const approveCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).endsWith("/approve"));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const mount = async () => {
  render(<ChatVideoCard id={ID} title="Stored title" fallback={<a href="/channel">Open the card</a>} />);
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  current = res({ card: card() });
  approveAnswer = res({ ok: true });
  messageAnswer = res({ thread_id: "thread-2", render: { run_id: "run-2" } });
  studioAnswer = res(rendering);
  apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path.endsWith("/approve")) return approveAnswer;
    if (path.endsWith("/studio/messages")) return messageAnswer;
    if (path.includes("/studio?thread_id=")) return studioAnswer;
    if (path.startsWith("/api/run-artifacts/")) return res({ signed_url: "https://x.test/edited.mp4" });
    return current;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatVideoCard", () => {
  it("shows script and price, spends nothing on mount, and links nowhere else", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Make video" })).toBeTruthy();
    expect(screen.getByTestId("suggested-ad-script").textContent).toContain("Stop scrolling");
    expect(screen.getByTestId("suggested-ad-cost").textContent).toContain("About 420 credits");
    expect(stateOf()).toBe("draft");
    expect(approveCalls()).toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("two clicks in one tick make one approve, and the card goes straight to making", async () => {
    await mount();
    const button = screen.getByRole("button", { name: "Make video" });
    await act(async () => {
      button.click();
      button.click();
    });
    await flush();
    expect(approveCalls()).toHaveLength(1);
    expect(stateOf()).toBe("making");
    expect(screen.getByTestId("suggested-ad-stage")).toBeTruthy();
    expect(screen.getByTestId("suggested-ad-progress")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make video" })).toBeNull();
  });

  it("polls while making and plays the video in place when it lands", async () => {
    current = res({ card: card({ exec_status: "running" }) });
    await mount();
    expect(stateOf()).toBe("making");
    current = res({ card: made });
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS); });
    expect(stateOf()).toBe("ready");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://x.test/v.mp4");
    expect(screen.getByRole("button", { name: /^Play / })).toBeTruthy();
    const fetched = vi.fn().mockRejectedValue(new Error("cors"));
    vi.stubGlobal("fetch", fetched);
    vi.stubGlobal("open", vi.fn(() => ({ opener: {} })));
    fireEvent.click(screen.getByTestId("suggested-ad-download"));
    await flush();
    expect(fetched).toHaveBeenCalledWith("https://x.test/d.mp4");
    vi.unstubAllGlobals();
    const reads = apiFetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS * 3); });
    expect(apiFetch.mock.calls.length).toBe(reads);
  });

  it("a card made from Suggested ads shows as making on the next mount, with nothing to press", async () => {
    current = res({ card: card({ status: "approved", exec_status: "queued" }) });
    await mount();
    expect(stateOf()).toBe("making");
    expect(pressable()).toEqual([]);
  });

  it("a failed retry stays making until the server moves, and a stale read cannot offer a second paid press", async () => {
    current = res({ card: card({ exec_status: "failed", exec_bucket: "temporary", note: "Sorry, the vendor refused this script." }) });
    await mount();
    expect(screen.getByText("Sorry, the vendor refused this script.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS); });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(approveCalls()).toHaveLength(1);
  });

  it("a card pressed in Suggested ads while this chat is open stops offering Make video", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Make video" })).toBeTruthy();
    current = res({ card: card({ status: "approved", exec_status: "queued" }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_WAITING_POLL_MS); });
    expect(screen.queryByRole("button", { name: "Make video" })).toBeNull();
    expect(stateOf()).toBe("making");
    expect(approveCalls()).toHaveLength(0);
  });

  it("a dismissed card offers no press and says nothing was made", async () => {
    current = res({ card: card({ status: "rejected" }) });
    await mount();
    expect(pressable()).toEqual([]);
    expect(screen.getByText(/nothing more will be made or charged/)).toBeTruthy();
  });

  it("a failed card dismissed in Suggested ads offers no Try again that the server would refuse", async () => {
    current = res({ card: card({ status: "rejected", exec_status: "failed", note: "Sorry, the vendor refused this script." }) });
    await mount();
    expect(pressable()).toEqual([]);
    expect(screen.getByText(/nothing more will be made or charged/)).toBeTruthy();
    expect(screen.queryByText(/vendor refused/)).toBeNull();
  });

  it("a delivered video whose link could not be signed never claims it is still being made", async () => {
    current = res({ card: card({ status: "acted", exec_status: "executed", body: {} }) });
    await mount();
    expect(screen.getByText(/could not be loaded here/)).toBeTruthy();
    expect(screen.queryByTestId("suggested-ad-stage")).toBeNull();
    expect(pressable()).toEqual([]);
    current = res({ card: made });
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS); });
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://x.test/v.mp4");
  });

  it("a credit refusal keeps the card and offers Top up, and the press can be repeated", async () => {
    await mount();
    approveAnswer = res({ error: { code: "insufficient_credits", message: "No credits" } }, 402);
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make video" })).toBeTruthy();
    expect(screen.getByTestId("suggested-ad-top-up")).toBeTruthy();
    expect(stateOf()).toBe("draft");
  });

  it("an edited script starts its own video, spends nothing on the card, and plays in the same card", async () => {
    await mount();
    await editAndMake("My own words.");
    expect(approveCalls()).toHaveLength(0);
    expect(messageCalls()).toHaveLength(1);
    expect(JSON.parse(messageCalls()[0][1].body)).toEqual({ text: "Stop scrolling. My own words.", verbatim: true, new_thread: true });
    expect(stateOf()).toBe("making");
    await tickFor(RENDER_POLL_MS * 2);
    expect(studioReads().length).toBeGreaterThan(0);
    expect(stateOf()).toBe("making");
    studioAnswer = res(renderDone);
    await tickFor(RENDER_POLL_MS);
    await flush();
    expect(stateOf()).toBe("ready");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://x.test/edited.mp4");
    const reads = studioReads().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * 3); });
    expect(studioReads().length).toBe(reads);
  });

  it("picking another hook makes that hook, never the approved card", async () => {
    current = res({ card: card({ body: { cost_credits: 420, hooks: ["Stop scrolling.", "Look here."], step: { deliverable: { content: "Stop scrolling. Yoga helps." } } } }) });
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Look here." }));
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    await flush();
    await flush();
    expect(approveCalls()).toHaveLength(0);
    expect(JSON.parse(messageCalls()[0][1].body).text).toContain("Look here.");
  });

  it("two clicks on an edited Make video start one paid render", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: /script/i }), { target: { value: "My own words." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const button = screen.getByRole("button", { name: "Make video" });
    await act(async () => {
      button.click();
      button.click();
    });
    await flush();
    await flush();
    expect(messageCalls()).toHaveLength(1);
  });

  it("a credit refusal on an edit keeps the founder's words and offers Top up", async () => {
    await mount();
    messageAnswer = res({ error: { code: "insufficient_credits", message: "No credits" } }, 402);
    await editAndMake("My own words.");
    expect(stateOf()).toBe("draft");
    expect(screen.getByTestId("suggested-ad-script").textContent).toContain("My own words.");
    expect(screen.getByTestId("suggested-ad-top-up")).toBeTruthy();
  });

  it("a stalled edited render says it is taking longer, keeps polling, and still lands", async () => {
    await mount();
    await editAndMake("My own words.");
    studioAnswer = res({ messages: [], renders: { "run-2": { status: "stalled", started_at: "2026-11-02T10:00:00Z", videos: [] } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(RENDER_POLL_MS); });
    await flush();
    expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
    expect(screen.queryByText(/You were not charged/)).toBeNull();
    studioAnswer = res(renderDone);
    await act(async () => { await vi.advanceTimersByTimeAsync(RENDER_POLL_MS); });
    await flush();
    expect(stateOf()).toBe("ready");
  });

  it("an image card shows its motion, and an edit sends the image the way the channel does, never as spoken words", async () => {
    current = res({ card: card({ title: "Animate your image", body: { cost_credits: 200, video_format: "animate", image_path: "t/photo.png", step: { deliverable: { content: "Slow push in.\n\nCaption: Look" } } } }) });
    await mount();
    expect(screen.getByTestId("suggested-ad-script").textContent).toBe("Slow push in.");
    expect(screen.queryByTestId("suggested-ad-hook")).toBeNull();
    expect(screen.getByText(/Animated/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: /request/i }), { target: { value: "Zoom out fast." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    await flush();
    await flush();
    expect(approveCalls()).toHaveLength(0);
    expect(JSON.parse(messageCalls()[0][1].body)).toEqual({ text: "Zoom out fast.", image_path: "t/photo.png", new_thread: true });
  });

  it("editing a card with a founder's presenter photo keeps that photo", async () => {
    current = res({ card: card({ body: { cost_credits: 420, portrait_path: "t/me.png", step: { deliverable: { content: "Stop scrolling. Yoga helps." } } } }) });
    await mount();
    await editAndMake("My own words.");
    expect(JSON.parse(messageCalls()[0][1].body)).toEqual({ text: "Stop scrolling. My own words.", image_path: "t/me.png", new_thread: true });
  });

  it("an unedited image card goes through the card's own approve", async () => {
    current = res({ card: card({ body: { cost_credits: 200, video_format: "animate", image_path: "t/photo.png", step: { deliverable: { content: "Slow push in." } } } }) });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    await flush();
    expect(approveCalls()).toHaveLength(1);
    expect(messageCalls()).toHaveLength(0);
  });

  it("a non-video card falls back to the channel link", async () => {
    current = res({ error: { code: "not_found" } }, 404);
    await mount();
    expect(screen.getByRole("link", { name: "Open the card" })).toBeTruthy();
  });

  it("a failed read during making does not throw the founder out of the card", async () => {
    current = res({ card: card({ exec_status: "running" }) });
    await mount();
    current = res({ error: { code: "read_failed" } }, 503);
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS); });
    expect(stateOf()).toBe("making");
    expect(screen.queryByRole("link", { name: "Open the card" })).toBeNull();
  });

  it("stops polling after the cap and says it is taking long", async () => {
    current = res({ card: card({ exec_status: "running" }) });
    await mount();
    for (let i = 0; i < CARD_MAX_POLLS + 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS); });
    expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
    const reads = apiFetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS * 5); });
    expect(apiFetch.mock.calls.length).toBe(reads);
  });

  it("unmounting mid-flight stops the poll", async () => {
    current = res({ card: card({ exec_status: "running" }) });
    await mount();
    const reads = apiFetch.mock.calls.length;
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_POLL_MS * 3); });
    expect(apiFetch.mock.calls.length).toBe(reads);
  });
});
