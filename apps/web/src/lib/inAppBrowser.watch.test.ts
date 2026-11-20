// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchOpenAttempt } from "./inAppBrowser";

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("watchOpenAttempt", () => {
  it("reports the page is still here when the other browser never opened", () => {
    const stuck = vi.fn();
    watchOpenAttempt(stuck, 1500);
    vi.advanceTimersByTime(1499);
    expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the page went to the background because Safari or Chrome opened", () => {
    const stuck = vi.fn();
    watchOpenAttempt(stuck, 1500);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    vi.advanceTimersByTime(2000);
    expect(stuck).not.toHaveBeenCalled();
  });

  it("stays quiet when the page was left", () => {
    const stuck = vi.fn();
    watchOpenAttempt(stuck, 1500);
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(2000);
    expect(stuck).not.toHaveBeenCalled();
  });

  it("can be cancelled", () => {
    const stuck = vi.fn();
    const stop = watchOpenAttempt(stuck, 1500);
    stop();
    vi.advanceTimersByTime(2000);
    expect(stuck).not.toHaveBeenCalled();
  });
});
