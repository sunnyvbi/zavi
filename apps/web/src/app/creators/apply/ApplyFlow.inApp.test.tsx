// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/creators/apply"}
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ signInWithOAuth: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signInWithOAuth: h.signInWithOAuth } }) }));

import { trackEvent } from "@/lib/analytics/events";
import ApplyFlow from "./ApplyFlow";

function stuckEvents() {
  return vi.mocked(trackEvent).mock.calls.filter(([name]) => name === "in_app_open_browser_stuck");
}

const X_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24A446 Twitter for iPhone/12.33";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  setUserAgent(SAFARI_IPHONE);
  vi.mocked(trackEvent).mockClear();
});
afterEach(cleanup);

describe("creator sign up inside the X app", () => {
  it("hides Google, keeps email sign up, and opens the page in Safari", async () => {
    setUserAgent(X_IPHONE);
    render(<ApplyFlow />);

    expect(await screen.findByText(/Google sign-in doesn.t work inside the X app/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Continue with Google/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign up" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Safari" }).getAttribute("href")).toBe(
      "x-safari-https://www.zaviagent.com/creators/apply",
    );
    expect(h.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("shows the address to paste by hand when Safari did not open", async () => {
    setUserAgent(X_IPHONE);
    render(<ApplyFlow />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      await vi.advanceTimersByTimeAsync(1600);
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText(/Didn.t open\? Copy this link/)).toBeTruthy();
    expect(screen.getByText("https://www.zaviagent.com/creators/apply")).toBeTruthy();
  });

  it("never carries the provider's raw error text into Safari or onto the screen", async () => {
    setUserAgent(X_IPHONE);
    window.history.replaceState(null, "", "/creators/apply?invite=abc&error=server_error&error_description=Unable+to+exchange+external+code");
    render(<ApplyFlow />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    expect(open.getAttribute("href")).toBe("x-safari-https://www.zaviagent.com/creators/apply?invite=abc");
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      await vi.advanceTimersByTimeAsync(1600);
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText("https://www.zaviagent.com/creators/apply?invite=abc")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Unable to exchange|server_error/);
    window.history.replaceState(null, "", "/creators/apply");
  });

  it("stays quiet when Safari did open", async () => {
    setUserAgent(X_IPHONE);
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    render(<ApplyFlow />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(500);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
    expect(screen.queryByText(/Didn.t open\?/)).toBeNull();
    expect(stuckEvents()).toHaveLength(0);
  });

  it("reports one stuck attempt when the link is tapped twice", async () => {
    setUserAgent(X_IPHONE);
    render(<ApplyFlow />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      await vi.advanceTimersByTimeAsync(1000);
      fireEvent.click(open);
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    expect(stuckEvents()).toHaveLength(1);
  });

  it("reports nothing once the page has gone away", async () => {
    setUserAgent(X_IPHONE);
    const { unmount } = render(<ApplyFlow />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      unmount();
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    expect(stuckEvents()).toHaveLength(0);
  });

  it("still offers Google in a normal browser", async () => {
    render(<ApplyFlow />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeTruthy());
    expect(screen.queryByText(/Google sign-in doesn.t work/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Open in/ })).toBeNull();
  });
});
