// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/"}

import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type User = { id: string; created_at: string; last_sign_in_at: string; app_metadata: { provider: string } };
const h = vi.hoisted(() => ({
  track: vi.fn(),
  verify: vi.fn(),
  unsubscribe: vi.fn(),
  consent: true,
  listener: null as null | ((state: { allowed: boolean }) => void),
  auth: null as null | ((event: string, session: { user: User } | null) => void),
}));

vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: h.verify }));
vi.mock("@/lib/consent", () => ({
  hasAnalyticsConsent: () => h.consent,
  allowsAnalytics: (state: { allowed: boolean }) => state.allowed,
  subscribe: (listener: typeof h.listener) => { h.listener = listener; return () => {}; },
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: {
    onAuthStateChange: (listener: typeof h.auth) => {
      h.auth = listener;
      return { data: { subscription: { unsubscribe: h.unsubscribe } } };
    },
  } }),
}));

import { AuthEventTracking } from "./auth";

const user: User = {
  id: "u1",
  created_at: "2026-09-30T00:00:00Z",
  last_sign_in_at: "2026-09-30T00:00:01Z",
  app_metadata: { provider: "google" },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T00:02:00Z"));
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  vi.stubEnv("NEXT_PUBLIC_MIXPANEL_TOKEN", "");
  vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST");
  vi.stubEnv("NEXT_PUBLIC_GA_ENHANCED_MEASUREMENT_DISABLED", "true");
  sessionStorage.clear();
  h.consent = true;
  h.auth = null;
  h.listener = null;
  h.verify.mockResolvedValue(user);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("auth events are independent of the Mixpanel provider", () => {
  it("tracks signup once with GA configured and Mixpanel disabled", async () => {
    render(<AuthEventTracking />);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(h.track).toHaveBeenCalledWith("signup_completed", { method: "google" });
    act(() => { h.auth?.("SIGNED_IN", { user }); vi.runAllTimers(); });
    expect(h.track).toHaveBeenCalledTimes(1);
  });

  it("counts a signup once per browser, not once per tab", async () => {
    render(<AuthEventTracking />);
    await act(async () => { await vi.runAllTimersAsync(); });
    cleanup();
    sessionStorage.clear();
    render(<AuthEventTracking />);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(h.track.mock.calls.filter(([name]) => name === "signup_completed")).toHaveLength(1);
  });

  it("treats an old account whose only sign-in was at creation as a login", async () => {
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    render(<AuthEventTracking />);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(h.track).toHaveBeenCalledWith("logged_in", { method: "google" });
    expect(h.track).not.toHaveBeenCalledWith("signup_completed", expect.anything());
  });

  it("does not track or observe auth when consent is rejected", () => {
    h.consent = false;
    render(<AuthEventTracking />);
    vi.runAllTimers();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.auth).toBeNull();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("drops a slow initial lookup after signout", async () => {
    let resolve: (value: User) => void = () => {};
    h.verify.mockReturnValue(new Promise<User>((done) => { resolve = done; }));
    render(<AuthEventTracking />);
    act(() => h.auth?.("SIGNED_OUT", null));
    await act(async () => { resolve(user); await Promise.resolve(); vi.runAllTimers(); });
    expect(h.track).not.toHaveBeenCalled();
  });

  it("cancels pending events on consent withdrawal", async () => {
    render(<AuthEventTracking />);
    await act(async () => { await Promise.resolve(); });
    act(() => { h.listener?.({ allowed: false }); vi.runAllTimers(); });
    expect(h.track).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
  });

  it("keeps server and initial client markup identical", () => {
    const element = <AuthEventTracking />;
    const server = renderToString(element);
    const view = render(element);
    expect(view.container.innerHTML).toBe(server);
  });
});
