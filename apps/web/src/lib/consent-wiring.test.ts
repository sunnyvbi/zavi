
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "./middlewareRoutes";

const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("the analytics providers gate on lib/consent", () => {
  for (const rel of ["app/PostHogProvider.tsx", "lib/analytics/mixpanel.tsx", "lib/analytics/google.tsx"]) {
    const s = src(rel);

    it(`${rel} imports the gate and has no local copy of the old dead check`, () => {
      expect(s).toContain('from "@/lib/consent"');
      expect(s).toContain(rel.endsWith("google.tsx") ? "allowsGoogleAnalytics(readConsent(), region)" : "hasAnalyticsConsent()");
      expect(s).toContain("subscribe(");
      expect(s).not.toContain("cookie_consent");
      expect(s).not.toContain("hasRejectedAnalyticsConsent");
    });

    it(`${rel} checks consent BEFORE calling init()`, () => {
      const gate = s.indexOf("if (!allowed) return;");
      const init = s.search(/\b(posthog\.init\(key|mixpanel\.init\(token|loadGtag\(id\))/);
      expect(gate).toBeGreaterThan(-1);
      expect(init).toBeGreaterThan(gate);
    });
  }

  it("neither provider calls reset() on withdrawal (reset re-persists a fresh ID)", () => {
    const mp = src("lib/analytics/mixpanel.tsx");
    const subBlock = mp.slice(mp.indexOf("subscribe("));
    expect(subBlock).not.toContain("mixpanel.reset(");
    const ph = src("app/PostHogProvider.tsx");
    expect(ph.slice(ph.indexOf("subscribe("))).not.toContain("posthog.reset(");
  });

  it("Google Analytics stops sending on withdrawal and never enables ad storage", () => {
    const ga = src("lib/analytics/google.tsx");
    const subBlock = ga.slice(ga.indexOf("subscribe("));
    expect(subBlock).toContain('analytics_storage: "denied"');
    expect(subBlock).toContain("ga-disable-");
    expect(ga).toContain('ad_storage: "denied"');
    expect(ga).toContain("allow_google_signals: false");
  });

  it("a page load without consent clears analytics storage left by earlier runs", () => {
    const c = src("lib/consent.ts");
    const wire = c.slice(c.indexOf("function wire()"), c.indexOf("export function subscribe("));
    expect(wire).toContain("purgeAnalyticsStorage()");
  });

  it("PostHog page views touch no storage until the client is loaded", () => {
    const ph = src("app/PostHogProvider.tsx");
    const guard = ph.indexOf("!ready || !pathname");
    expect(guard).toBeGreaterThan(-1);
    expect(ph.indexOf("`ph_pv:${url}`")).toBeGreaterThan(guard);
  });
});

describe("the policy page is reachable and cannot be shadowed", () => {
  it("/cookie-policy is a public path in middleware", () => {
    expect(isPublicPath("/cookie-policy")).toBe(true);
  });

  it("cookie-policy is a reserved creator slug", () => {
    expect(
      readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "shared", "src", "creators", "slug.ts"), "utf8"),
    ).toContain('"cookie-policy"');
  });

  it("the banner is mounted in the root layout, outside the providers", () => {
    const layout = src("app/layout.tsx");
    const banner = layout.indexOf("<CookieBanner />");
    const provider = layout.indexOf("<PostHogProvider>");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(provider);
  });
});

describe("PostHog session replay hides what the policy promises", () => {
  it("routes every input and text node through the masking functions, blocks media, and skips console logs", () => {
    const ph = src("app/PostHogProvider.tsx");
    expect(ph).toContain("maskAllInputs: true");
    expect(ph).toContain("maskInputFn: maskReplayInput");
    expect(ph).toContain('maskTextSelector: "*"');
    expect(ph).toContain("maskTextFn: maskReplayText");
    expect(ph).toMatch(/blockSelector: "img, video, canvas/);
    expect(ph).toContain("enable_recording_console_log: false");
    expect(ph).toContain("maskAttributeFn: maskReplayAttribute");
    expect(ph).toContain("maskCapturedNetworkRequestFn: () => null");
  });

  it("stops the recorder on an in-page withdrawal", () => {
    const ph = src("app/PostHogProvider.tsx");
    const sub = ph.slice(ph.indexOf("const unsubscribe = subscribe("));
    expect(sub).toContain("posthog.stopSessionRecording()");
  });
});
