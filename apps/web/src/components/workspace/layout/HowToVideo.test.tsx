// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: (...a: unknown[]) => trackEvent(...a),
  trackEventDeferred: (...a: unknown[]) => {
    trackEvent(...a);
    return () => {};
  },
}));

import { HOWTO_SEEN_KEY, HowToVideoCard, HowToVideoDialog } from "./HowToVideo";

beforeEach(() => {
  window.localStorage.clear();
  trackEvent.mockClear();
});
afterEach(cleanup);

describe("HowToVideoCard", () => {
  it("shows for someone who has not seen the video and reports it once", () => {
    render(<HowToVideoCard onOpen={() => {}} />);
    expect(screen.getByText("How to use Zavi")).toBeTruthy();
    expect(screen.getByText("2 min video")).toBeTruthy();
    expect(trackEvent).toHaveBeenCalledWith("howto_video_card_shown");
  });

  it("opening the video keeps the card until the player marks it seen", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<HowToVideoCard onOpen={onOpen} />);
    fireEvent.click(screen.getByText("How to use Zavi"));
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(<HowToVideoCard onOpen={onOpen} dialogOpen />);
    rerender(<HowToVideoCard onOpen={onOpen} dialogOpen={false} />);
    expect(screen.getByText("How to use Zavi")).toBeTruthy();
    window.localStorage.setItem(HOWTO_SEEN_KEY, "1");
    rerender(<HowToVideoCard onOpen={onOpen} dialogOpen />);
    rerender(<HowToVideoCard onOpen={onOpen} dialogOpen={false} />);
    expect(screen.queryByText("How to use Zavi")).toBeNull();
    cleanup();
    render(<HowToVideoCard onOpen={onOpen} />);
    expect(screen.queryByText("How to use Zavi")).toBeNull();
  });

  it("closing the card hides it without opening the video", () => {
    const onOpen = vi.fn();
    render(<HowToVideoCard onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the how-to video card" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText("How to use Zavi")).toBeNull();
    expect(window.localStorage.getItem(HOWTO_SEEN_KEY)).toBe("1");
    expect(trackEvent).toHaveBeenCalledWith("howto_video_card_dismissed");
  });

  it("still shows when storage is blocked", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<HowToVideoCard onOpen={() => {}} />);
    expect(screen.getByText("How to use Zavi")).toBeTruthy();
    get.mockRestore();
  });
});

describe("HowToVideoDialog", () => {
  const setup = (source: "card" | "menu" = "menu") => {
    const onClose = vi.fn();
    const onStart = vi.fn();
    render(<HowToVideoDialog source={source} onClose={onClose} onStart={onStart} />);
    const video = document.querySelector("video") as HTMLVideoElement;
    return { onClose, onStart, video };
  };

  it("reports where it was opened from, and marks seen only once it plays", () => {
    const { video } = setup("menu");
    expect(trackEvent).toHaveBeenCalledWith("howto_video_opened", { source: "menu" });
    expect(window.localStorage.getItem(HOWTO_SEEN_KEY)).toBeNull();
    act(() => { fireEvent.play(video); });
    expect(window.localStorage.getItem(HOWTO_SEEN_KEY)).toBe("1");
  });

  it("a deliberate close marks it seen, a failed load does not", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(window.localStorage.getItem(HOWTO_SEEN_KEY)).toBe("1");
    expect(first.onClose).toHaveBeenCalledOnce();
    cleanup();
    window.localStorage.clear();
    const second = setup();
    act(() => { fireEvent.error(second.video); });
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(window.localStorage.getItem(HOWTO_SEEN_KEY)).toBeNull();
  });

  it("hides Open Messaging while setup locks the sidebar", () => {
    render(<HowToVideoDialog source="card" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Open Messaging" })).toBeNull();
  });

  it("reports 25, 50 and 100 percent once each, and the furthest point on close", () => {
    const { video, onClose } = setup("card");
    Object.defineProperty(video, "duration", { value: 100, configurable: true });
    const at = (t: number) => {
      Object.defineProperty(video, "currentTime", { value: t, configurable: true });
      act(() => { fireEvent.timeUpdate(video); });
    };
    at(30);
    at(31);
    at(55);
    act(() => { fireEvent.ended(video); });
    const marks = trackEvent.mock.calls.filter((c) => c[0] === "howto_video_progress").map((c) => (c[1] as { pct: number }).pct);
    expect(marks).toEqual([25, 50, 100]);
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(trackEvent).toHaveBeenCalledWith("howto_video_closed", { watched_pct: 100, source: "card" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Open Messaging is the one action at the end", () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open Messaging" }));
    expect(onStart).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledWith("howto_video_cta", { target: "messaging", watched_pct: 0, source: "menu" });
  });

  it("says so when the video fails to load", () => {
    const { video } = setup();
    act(() => { fireEvent.error(video); });
    expect(screen.getByText(/The video didn.t load/)).toBeTruthy();
  });

  it("Escape closes it", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
