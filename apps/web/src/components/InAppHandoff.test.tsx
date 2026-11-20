// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { leaveTo, trackEvent } = vi.hoisted(() => ({ leaveTo: vi.fn(), trackEvent: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent }));
vi.mock("@/lib/inAppBrowser", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inAppBrowser")>("@/lib/inAppBrowser");
  return { ...actual, leaveTo };
});

import { InAppHandoff } from "./InAppHandoff";
import { HANDOFF_SESSION_KEY } from "@/lib/inAppBrowser";

const X_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.48";
const X_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 TwitterAndroid";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_TARGET = "x-safari-https://www.zaviagent.com/?from=cr-z&iab=x&utm_source=x";

let visibility: DocumentVisibilityState = "visible";
const realLocation = window.location;

function open(href: string, userAgent: string) {
  Object.defineProperty(window, "location", { configurable: true, value: new URL(href) });
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
}

function StripsCreatorCode() {
  useEffect(() => {
    open("https://www.zaviagent.com/", X_IPHONE);
  }, []);
  return null;
}

function events(name: string) {
  return trackEvent.mock.calls.filter(([event]) => event === name);
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  window.sessionStorage.clear();
  leaveTo.mockReset();
  trackEvent.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("InAppHandoff", () => {
  it("opens the same page in Safari once, after the page has had time to start", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(399);
    expect(leaveTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    expect(leaveTo).toHaveBeenCalledWith(SAFARI_TARGET);
    expect(events("in_app_handoff_attempted")).toEqual([["in_app_handoff_attempted", { app: "X", os: "ios" }]]);
  });

  it("does not try again when the X app reloads or reopens the page in the same visit", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    const first = render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(400);
    first.unmount();
    render(<InAppHandoff enabled />);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(5000);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    expect(events("in_app_handoff_attempted")).toHaveLength(1);
  });

  it("does not loop when Chrome is missing and Android falls back to the marked page inside the X app", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_ANDROID);
    const first = render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(400);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    const fallback = decodeURIComponent(String(leaveTo.mock.calls[0][0]).split("S.browser_fallback_url=")[1].split(";end")[0]);
    first.unmount();
    window.sessionStorage.clear();
    open(fallback, X_ANDROID);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(5000);
    expect(leaveTo).toHaveBeenCalledTimes(1);
  });

  it("reports the visitor is still in the X app when nothing opened, and leaves the page alone", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(400);
    vi.advanceTimersByTime(1499);
    expect(events("in_app_handoff_stuck")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events("in_app_handoff_stuck")).toEqual([["in_app_handoff_stuck", { app: "X", os: "ios" }]]);
    expect(leaveTo).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the page went to the background because the other browser opened", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_ANDROID);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(400);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    vi.advanceTimersByTime(5000);
    expect(events("in_app_handoff_attempted")).toEqual([["in_app_handoff_attempted", { app: "X", os: "android" }]]);
    expect(events("in_app_handoff_stuck")).toHaveLength(0);
  });

  it("never leaves when the visitor navigated away before the start delay", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    const view = render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(399);
    view.unmount();
    vi.advanceTimersByTime(5000);
    expect(leaveTo).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("does nothing when session storage is blocked, because a repeat could not be prevented", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(5000);
    expect(leaveTo).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("does nothing while switched off, in Safari, or on a signed-in page", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff enabled={false} />);
    open("https://www.zaviagent.com/?from=cr-z", SAFARI_IPHONE);
    render(<InAppHandoff enabled />);
    open("https://www.zaviagent.com/workspace", X_IPHONE);
    render(<InAppHandoff enabled />);
    vi.advanceTimersByTime(5000);
    expect(leaveTo).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull();
  });

  it("keeps a creator's link code that another part of the page strips from the address on load", () => {
    open("https://www.zaviagent.com/?via=abcdefgh", X_IPHONE);
    render(
      <>
        <StripsCreatorCode />
        <InAppHandoff enabled />
      </>,
    );
    expect(window.location.href).toBe("https://www.zaviagent.com/");
    vi.advanceTimersByTime(400);
    expect(leaveTo).toHaveBeenCalledWith("x-safari-https://www.zaviagent.com/?via=abcdefgh&iab=x&utm_source=x");
  });

  it("follows the visitor when they tap through to another page before it fires", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff enabled />);
    open("https://www.zaviagent.com/pricing", X_IPHONE);
    vi.advanceTimersByTime(400);
    expect(leaveTo).toHaveBeenCalledWith("x-safari-https://www.zaviagent.com/pricing?iab=x&utm_source=x");
  });

  it("stays put when the visitor has already tapped through to sign-in", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff enabled />);
    open("https://www.zaviagent.com/login?signup=1", X_IPHONE);
    vi.advanceTimersByTime(5000);
    expect(leaveTo).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull();
  });

  it("fires exactly once when React mounts the page twice", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(
      <StrictMode>
        <InAppHandoff enabled />
      </StrictMode>,
    );
    vi.advanceTimersByTime(5000);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    expect(events("in_app_handoff_attempted")).toHaveLength(1);
  });

  it("is on for every X app visitor unless the switch is set to off", () => {
    open("https://www.zaviagent.com/?from=cr-z", X_IPHONE);
    render(<InAppHandoff />);
    vi.advanceTimersByTime(400);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    expect(leaveTo).toHaveBeenCalledWith(SAFARI_TARGET);
  });

  it("lets the private test link through while switched off for everyone else", () => {
    open("https://www.zaviagent.com/?from=cr-z&iab_handoff=1", X_IPHONE);
    render(<InAppHandoff enabled={false} />);
    vi.advanceTimersByTime(400);
    expect(leaveTo).toHaveBeenCalledWith(SAFARI_TARGET);
  });
});
