// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => h.search,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: {} }) }));
vi.mock("@/lib/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => `http://api.test${p}` }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({ AuthMarketingPanel: () => null }));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));

import LoginPage from "./page";

const X_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.48";
const X_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 TwitterAndroid";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  h.search = new URLSearchParams();
  setUserAgent(SAFARI_IPHONE);
});
afterEach(cleanup);

function googleButtons() {
  return screen
    .queryAllByRole("button")
    .filter((b) => `${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""}`.includes("Continue with Google"));
}

describe("/login inside the X app", () => {
  it.each([
    ["sign-up", "signup=1"],
    ["sign-in", ""],
  ])("offers no Google button anywhere on %s, so nobody can hit Google's block", async (_name, query) => {
    setUserAgent(X_IPHONE);
    h.search = new URLSearchParams(query);
    render(<LoginPage />);

    expect(await screen.findByText(/Google sign-in doesn.t work inside the X app/)).toBeTruthy();
    await waitFor(() => expect(googleButtons()).toHaveLength(0));
    expect(screen.getAllByRole("button", { name: "Continue with GitHub" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("opens the same page in Safari on an iPhone", async () => {
    setUserAgent(X_IPHONE);
    window.history.replaceState(null, "", "/login?signup=1&error=access_denied");
    h.search = new URLSearchParams("signup=1&error=access_denied");
    render(<LoginPage />);

    const open = await screen.findByRole("link", { name: "Open in Safari" });
    expect(open.getAttribute("href")).toBe("x-safari-https://www.zaviagent.com/login?signup=1");
    window.history.replaceState(null, "", "/");
  });

  it("opens Safari on sign-in after the visitor switched from sign-up to sign-in", async () => {
    setUserAgent(X_IPHONE);
    window.history.replaceState(null, "", "/login?signup=1&next=%2Fworkspace");
    h.search = new URLSearchParams("signup=1&next=%2Fworkspace");
    render(<LoginPage />);

    expect((await screen.findByRole("link", { name: "Open in Safari" })).getAttribute("href")).toBe(
      "x-safari-https://www.zaviagent.com/login?signup=1&next=%2Fworkspace",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open in Safari" }).getAttribute("href")).toBe(
        "x-safari-https://www.zaviagent.com/login?next=%2Fworkspace",
      ),
    );
    window.history.replaceState(null, "", "/");
  });

  it("keeps saying sign-up after Email me a code, and Safari still opens on sign-up", async () => {
    setUserAgent(X_IPHONE);
    window.history.replaceState(null, "", "/login?signup=1&next=%2Fworkspace");
    h.search = new URLSearchParams("signup=1&next=%2Fworkspace");
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    await screen.findByRole("heading", { name: "Create your workspace." });
    expect(screen.getByText("Create a free account to see your growth plan. No card.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/a password \(8\+ characters\)/);
    expect(screen.getByRole("link", { name: "Open in Safari" }).getAttribute("href")).toBe(
      "x-safari-https://www.zaviagent.com/login?signup=1&next=%2Fworkspace",
    );

    fireEvent.click(screen.getByRole("button", { name: /Use email \+ password instead/ }));
    await screen.findByPlaceholderText("At least 8 characters");
    expect(screen.getByRole("heading", { name: "Create your workspace." })).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });

  it("keeps saying sign-up after Use a different email", async () => {
    setUserAgent(X_IPHONE);
    h.search = new URLSearchParams("signup=1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByPlaceholderText("you@company.com"), { target: { value: "new@company.com" } });
    fireEvent.submit(screen.getByPlaceholderText("you@company.com").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: /Use a different email/ }));

    expect(await screen.findByRole("heading", { name: "Create your workspace." })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("keeps the onboarding design after Email me a code", async () => {
    setUserAgent(X_IPHONE);
    h.search = new URLSearchParams("signup=1&next=%2Fstart%3Fwebsite%3Dupcar.ai");
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    await screen.findByRole("button", { name: /Use email \+ password instead/ });
    expect(screen.getByRole("heading", { name: "Create your workspace." })).toBeTruthy();
    expect(screen.queryByText("Create a free account to see your growth plan. No card.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Continue with GitHub" })[0].className).toContain("rounded-full");
  });

  it("a code asked for from sign-in stays sign-in", async () => {
    setUserAgent(X_IPHONE);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    await screen.findByRole("button", { name: /Use email \+ password instead/ });
    expect(screen.getByRole("heading", { name: "Open your workspace." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Use email \+ password instead/ }));
    await screen.findByPlaceholderText("Your password");
  });

  it("shows the link to paste by hand when Safari did not open", async () => {
    setUserAgent(X_IPHONE);
    window.history.replaceState(null, "", "/login?signup=1");
    h.search = new URLSearchParams("signup=1");
    render(<LoginPage />);
    const open = await screen.findByRole("link", { name: "Open in Safari" });
    open.addEventListener("click", (e) => e.preventDefault());

    vi.useFakeTimers();
    try {
      fireEvent.click(open);
      expect(screen.queryByText(/Didn.t open\?/)).toBeNull();
      await vi.advanceTimersByTimeAsync(1600);
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/Didn.t open\? Copy this link/);
    expect(screen.getByText("https://www.zaviagent.com/login?signup=1")).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });

  it("stays quiet when Safari did open", async () => {
    setUserAgent(X_IPHONE);
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    render(<LoginPage />);
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
  });

  it("opens the same page in Chrome on Android", async () => {
    setUserAgent(X_ANDROID);
    window.history.replaceState(null, "", "/login?signup=1");
    h.search = new URLSearchParams("signup=1");
    render(<LoginPage />);

    const open = await screen.findByRole("link", { name: "Open in Chrome" });
    expect(open.getAttribute("href")).toBe(
      "intent://www.zaviagent.com/login?signup=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" +
        encodeURIComponent("https://www.zaviagent.com/login?signup=1") +
        ";end",
    );
    expect(googleButtons()).toHaveLength(0);
    window.history.replaceState(null, "", "/");
  });

  it("switches to the email code when the first option is pressed", async () => {
    setUserAgent(X_IPHONE);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Email me a code" })).toHaveLength(1));
    expect(screen.getByText(/Use email \+ password instead/)).toBeTruthy();
  });

  it("shows the link to copy by hand when the clipboard is blocked", async () => {
    setUserAgent(X_IPHONE);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("blocked")) },
      configurable: true,
    });
    window.history.replaceState(null, "", "/login?signup=1&error=PKCE+code+verifier+not+found");
    h.search = new URLSearchParams("signup=1&error=PKCE+code+verifier+not+found");
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/Copy this link and open it in Safari or Chrome/)).toBeTruthy();
    expect(screen.getByText(/\/login\?signup=1$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/PKCE/);
    window.history.replaceState(null, "", "/");
  });
});

describe("/login in a normal browser", () => {
  it("shows no in-app notice and no extra email-code button", async () => {
    render(<LoginPage />);

    await screen.findByRole("heading", { name: "Open your workspace." });
    expect(screen.queryByText(/Google sign-in doesn.t work/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Email me a code" })).toBeNull();
  });

  it("leads sign-up with Google and says why an account is needed", async () => {
    h.search = new URLSearchParams("signup=1");
    render(<LoginPage />);

    expect(await screen.findByText("Create a free account to see your growth plan. No card.")).toBeTruthy();
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent || b.getAttribute("aria-label") || "")
      .filter((t) => t.startsWith("Continue with"));
    expect(labels[0]).toBe("Continue with Google");
    expect(labels.indexOf("Continue with Google")).toBeLessThan(labels.indexOf("Continue with GitHub"));
  });
});

describe("/login ?error=", () => {
  it.each([
    ["access_denied", "Sign-in was cancelled."],
    [
      "PKCE code verifier not found in storage. use @supabase/ssr",
      "This link opened in a different browser. Sign in again here, or open the link in the browser you signed up in.",
    ],
    ["Anything a stranger typed into the URL", "Something went wrong. Please try again."],
  ])("maps %s to plain words", async (raw, shown) => {
    h.search = new URLSearchParams({ error: raw });
    render(<LoginPage />);

    expect((await screen.findByRole("alert")).textContent).toBe(shown);
    expect(screen.queryByText(raw)).toBeNull();
  });
});
