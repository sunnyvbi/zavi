// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/start?utm_source=news&key=secret"}

import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type State = { status: "unset" } | { status: "set"; prefs: { analytics: boolean }; ts: string };
const YES: State = { status: "set", prefs: { analytics: true }, ts: "t" };
const NO: State = { status: "set", prefs: { analytics: false }, ts: "t" };
const UNSET: State = { status: "unset" };

const h = vi.hoisted(() => ({
  state: null as unknown,
  gpc: false,
  listener: null as null | ((s: unknown) => void),
  pathname: "/start",
}));

vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("@/lib/consent", () => ({
  readConsent: () => h.state,
  allowsAnalytics: (s: State) => (s.status === "set" ? s.prefs.analytics : !h.gpc),
  subscribe: (fn: (s: unknown) => void) => {
    h.listener = fn;
    return () => {};
  },
}));

type GaWindow = Window & { dataLayer?: IArguments[] } & { [key: `ga-disable-${string}`]: boolean | undefined };

function calls(): unknown[][] {
  return ((window as unknown as GaWindow).dataLayer ?? []).map((a) => Array.from(a));
}

describe("GoogleAnalyticsProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("NEXT_PUBLIC_GA_ENHANCED_MEASUREMENT_DISABLED", "true");
    (window as unknown as GaWindow).dataLayer = undefined;
    document.head.innerHTML = "";
    h.state = YES;
    h.gpc = false;
    h.listener = null;
    document.cookie = "zavi_region=; Max-Age=0; Path=/";
    h.pathname = "/start";
    window.history.replaceState(null, "", "/start?utm_source=news&key=secret");
    document.title = "Private customer title";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  async function mount() {
    const mod = await import("./google");
    render(
      <mod.GoogleAnalyticsProvider>
        <div />
      </mod.GoogleAnalyticsProvider>,
    );
    return mod;
  }

  it("loads gtag with ads features off and sends a scrubbed page view", async () => {
    await mount();
    expect(document.head.querySelector("script")?.getAttribute("src")).toContain("id=G-TEST123");
    const all = calls();
    expect(all).toContainEqual([
      "consent",
      "default",
      expect.objectContaining({ ad_storage: "denied", ad_personalization: "denied" }),
    ]);
    expect(all).toContainEqual([
      "config",
      "G-TEST123",
      expect.objectContaining({
        send_page_view: false,
        allow_google_signals: false,
        page_location: "https://www.zaviagent.com/start?utm_source=news",
      }),
    ]);
    expect(all).toContainEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/start", page_type: "onboarding_start" }),
    ]);
    expect(JSON.stringify(all)).not.toContain("secret");
  });

  it("does nothing without consent", async () => {
    h.state = NO;
    await mount();
    expect(document.head.querySelector("script")).toBeNull();
    expect((window as unknown as GaWindow).dataLayer).toBeUndefined();
  });

  it("stays disabled until automatic collection has been explicitly turned off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_ENHANCED_MEASUREMENT_DISABLED", "");
    await mount();
    expect(document.head.querySelector("script")).toBeNull();
    expect((window as unknown as GaWindow).dataLayer).toBeUndefined();
  });

  it("sends events once loaded and stops on withdrawal", async () => {
    const mod = await mount();
    mod.gaEvent("pricing_plan_selected", { tier: "pro", long: "x".repeat(300), skip: null });
    expect(calls()).toContainEqual(["event", "pricing_plan_selected", expect.objectContaining({ tier: "pro", long: "x".repeat(100) })]);
    act(() => h.listener?.(NO));
    expect((window as unknown as GaWindow)["ga-disable-G-TEST123"]).toBe(true);
    expect(calls()).toContainEqual(["consent", "update", { analytics_storage: "denied" }]);
    const before = calls().length;
    mod.gaEvent("after_withdrawal");
    expect(calls().length).toBe(before);
  });

  it("uses the current sanitized address for events after a query-only navigation", async () => {
    const mod = await mount();
    window.history.replaceState(null, "", "/start?utm_source=changed&website=private.example&key=secret");
    mod.gaEvent("onboarding_website_submitted");
    expect(calls()).toContainEqual(["event", "onboarding_website_submitted", {
      page_location: "https://www.zaviagent.com/start?utm_source=changed",
      page_referrer: "",
      page_title: "onboarding_start",
    }]);
    expect(JSON.stringify(calls())).not.toContain("Private customer title");
    expect(JSON.stringify(calls())).not.toContain("private.example");
  });

  describe("EU/UK opt-in", () => {
    const script = () => document.head.querySelector("script");

    it("an EU visitor who has not answered gets no GA script", async () => {
      document.cookie = "zavi_region=eu; Path=/";
      h.state = UNSET;
      await mount();
      expect(script()).toBeNull();
      expect((window as unknown as GaWindow).dataLayer).toBeUndefined();
    });

    it("an EU visitor gets GA after saying yes", async () => {
      document.cookie = "zavi_region=eu; Path=/";
      h.state = UNSET;
      await mount();
      act(() => h.listener?.(YES));
      expect(script()?.getAttribute("src")).toContain("id=G-TEST123");
    });

    it("outside the EU/UK the opt-out rule is unchanged", async () => {
      document.cookie = "zavi_region=other; Path=/";
      h.state = UNSET;
      await mount();
      expect(script()?.getAttribute("src")).toContain("id=G-TEST123");
    });

    it("outside the EU/UK, GPC with no answer still keeps GA off", async () => {
      document.cookie = "zavi_region=other; Path=/";
      h.state = UNSET;
      h.gpc = true;
      await mount();
      expect(script()).toBeNull();
    });

    it("an unknown region is opt-in", async () => {
      h.state = UNSET;
      await mount();
      expect(script()).toBeNull();
      act(() => h.listener?.(YES));
      expect(script()).not.toBeNull();
    });
  });

  it("gives GA /app, not the real path, on signed-in app pages", async () => {
    const mod = await mount();
    h.pathname = "/workspace/thread-123";
    window.history.replaceState(null, "", "/workspace/thread-123?tab=runs");
    mod.gaEvent("logged_out");
    expect(calls()).toContainEqual(["event", "logged_out", expect.objectContaining({
      page_location: "https://www.zaviagent.com/app",
      page_title: "app",
    })]);
    expect(JSON.stringify(calls())).not.toContain("thread-123");
  });

  it("keeps page views active after StrictMode replays the provider effect", async () => {
    const mod = await import("./google");
    const view = render(<StrictMode><mod.GoogleAnalyticsProvider><div /></mod.GoogleAnalyticsProvider></StrictMode>);
    h.pathname = "/pricing";
    window.history.replaceState(null, "", "/pricing");
    view.rerender(<StrictMode><mod.GoogleAnalyticsProvider><div /></mod.GoogleAnalyticsProvider></StrictMode>);
    expect(calls()).toContainEqual(["event", "page_view", expect.objectContaining({ page_type: "pricing" })]);
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("preserves the server markup on the first client render", async () => {
    h.state = NO;
    const mod = await import("./google");
    const element = <mod.GoogleAnalyticsProvider><span>Content</span></mod.GoogleAnalyticsProvider>;
    const server = renderToString(element);
    const view = render(element);
    expect(view.container.innerHTML).toBe(server);
    expect(document.head.querySelector("script")).toBeNull();
  });
});
