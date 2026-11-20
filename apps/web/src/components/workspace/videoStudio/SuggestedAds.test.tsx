// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SuggestedAds, type AdItem } from "./SuggestedAds";
import { kindLabel, type VideoIntent } from "./types";

vi.mock("./useSignedVideo", () => ({ useSignedVideo: () => ({ url: null, download: async () => true, onError: () => undefined }) }));

afterEach(cleanup);

const base = (over: Partial<AdItem> = {}): AdItem => ({
  key: "k1",
  title: "Planner ad",
  hooks: [],
  script: "Stop wasting your mornings today with our planner.",
  state: "draft",
  onMakeScript: () => undefined,
  ...over,
});

const mount = (item: AdItem) => render(<SuggestedAds items={[item]} loading={false} error={null} now={0} />);
const redraw = (r: ReturnType<typeof mount>, item: AdItem) => r.rerender(<SuggestedAds items={[item]} loading={false} error={null} now={0} />);

describe("SuggestedAds edits survive a refused send (bd36)", () => {
  const edited = "My own edited script that is long enough to send.";

  const editAndSend = (onMakeScript: (t: string) => void) => {
    const r = mount(base({ onMakeScript }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: edited } });
    fireEvent.submit(screen.getByRole("form", { name: 'Edit "Planner ad"' }));
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    return r;
  };

  it("keeps the founder's edited script when the send is refused and the card stays a draft", () => {
    const sent: string[] = [];
    const r = editAndSend((t) => sent.push(t));
    expect(sent).toEqual([edited]);
    redraw(r, base({ onMakeScript: () => undefined, topUp: true }));
    expect(screen.getByTestId("suggested-ad-script").textContent).toBe(edited);
  });

  it("drops the edit once the send takes, so the finished video shows instead of the stale draft", () => {
    const r = editAndSend(() => undefined);
    redraw(r, base({ state: "making", startedAt: 0 }));
    redraw(r, base({ state: "ready", video: { url: "https://cdn.test/v.mp4", downloadUrl: null }, cost: 40, onRetry: () => undefined }));
    expect(document.querySelector("video")).not.toBeNull();
    expect(screen.getByTestId("suggested-ad-script").textContent).toBe(base().script);
    expect(screen.queryByText(edited)).toBeNull();
    expect(screen.getByTestId("suggested-ad-cost").textContent).not.toContain("Yours is priced");
  });
});

describe("SuggestedAds keeps an edit until the send really succeeds (bd36 reopened)", () => {
  const edited = "My own edited script that is long enough to send.";
  const ready = (over: Partial<AdItem> = {}) => base({ state: "ready", video: { url: "https://cdn.test/v.mp4", downloadUrl: null }, onRetry: () => undefined, ...over });
  const gate = () => {
    let resolve!: (ok: boolean) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const edit = () => {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: edited } });
    fireEvent.submit(screen.getByRole("form", { name: 'Edit "Planner ad"' }));
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
  };
  const scriptText = () => screen.getByTestId("suggested-ad-script").textContent;

  it("a ready ad with an edited script starts one paid render when Make video is pressed again while the first send is in flight", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    const item = ready({ onMakeScript });
    const r = mount(item);
    edit();
    redraw(r, { ...item });
    fireEvent.click(screen.getByRole("button", { name: /Starting|Make video/ }));
    redraw(r, { ...item });
    fireEvent.click(screen.getByRole("button", { name: /Starting|Make video/ }));
    expect(onMakeScript).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Starting/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => g.resolve(false));
    expect(screen.getByRole("button", { name: "Make video" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Make video" }));
    expect(onMakeScript).toHaveBeenCalledTimes(2);
  });

  it("a thread draft that goes making and then fails keeps the edit when the send resolves false afterwards", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    const r = mount(base({ onMakeScript }));
    edit();
    expect(onMakeScript).toHaveBeenCalledWith(edited);
    redraw(r, base({ onMakeScript, state: "making", startedAt: 0 }));
    expect(screen.getByRole("button", { name: /Making it/ })).toBeTruthy();
    redraw(r, base({ onMakeScript, state: "failed", error: { text: "Zavi could not start this video. Try again.", credit: null }, onRetry: () => undefined }));
    expect(scriptText()).toBe(edited);
    await act(async () => g.resolve(false));
    expect(scriptText()).toBe(edited);
    redraw(r, base({ onMakeScript }));
    expect(scriptText()).toBe(edited);
    expect(screen.getByRole("button", { name: "Make video" })).toBeTruthy();
  });

  it("a thread draft whose send throws after going making keeps the edit", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    const r = mount(base({ onMakeScript }));
    edit();
    redraw(r, base({ onMakeScript, state: "making", startedAt: 0 }));
    redraw(r, base({ onMakeScript }));
    await act(async () => g.reject(new Error("network")));
    expect(scriptText()).toBe(edited);
  });

  it("a thread draft whose send resolves true drops the edit so the made video shows", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    const r = mount(base({ onMakeScript }));
    edit();
    redraw(r, base({ onMakeScript, state: "making", startedAt: 0 }));
    await act(async () => g.resolve(true));
    redraw(r, ready({ onMakeScript }));
    expect(document.querySelector("video")).not.toBeNull();
    expect(scriptText()).toBe(base().script);
    expect(screen.queryByText(edited)).toBeNull();
  });

  it("a ready ad keeps the edit when the send resolves false", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    mount(ready({ onMakeScript }));
    edit();
    expect(scriptText()).toBe(edited);
    await act(async () => g.resolve(false));
    expect(scriptText()).toBe(edited);
    expect(screen.getByRole("button", { name: "Make video" })).toBeTruthy();
  });

  it("a ready ad drops the edit when the send resolves true", async () => {
    const g = gate();
    const onMakeScript = vi.fn(() => g.promise);
    mount(ready({ onMakeScript }));
    edit();
    await act(async () => g.resolve(true));
    expect(scriptText()).toBe(base().script);
    expect(screen.queryByRole("button", { name: "Make video" })).toBeNull();
  });
});

describe("SuggestedAds names the real kind of video (e6c3)", () => {
  it("not-made card says Animated image for an animate ad, not AI presenter", () => {
    mount(base({ intent: "animate" }));
    expect(screen.getByText(/^Animated image · \d+s$/)).toBeTruthy();
    expect(screen.queryByText(/AI presenter/)).toBeNull();
  });

  it("keeps AI presenter when the ad is a presenter or has no intent", () => {
    mount(base());
    expect(screen.getByText(/^AI presenter · \d+s$/)).toBeTruthy();
  });

  it("falls back to AI presenter for an intent it does not know, never undefined", () => {
    expect(kindLabel("slideshow" as VideoIntent)).toBe("AI presenter");
    expect(kindLabel("slideshow" as VideoIntent, "Video")).toBe("Video");
    mount(base({ intent: "slideshow" as VideoIntent }));
    expect(screen.getByText(/^AI presenter · \d+s$/)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("preview of a ready cinematic ad says Cinematic", () => {
    mount(base({ state: "ready", intent: "cinematic", video: { url: "https://cdn.test/v.mp4", downloadUrl: null } }));
    expect(screen.getByTestId("suggested-ad-preview-meta").textContent).toMatch(/^(About )?\d+ seconds$/);
    expect(screen.getByText("· Cinematic")).toBeTruthy();
  });
});
