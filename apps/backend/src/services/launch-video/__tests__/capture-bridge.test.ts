import { describe, it, expect, vi } from "vitest";

const PUBLIC_ANSWER = [{ address: "93.184.216.34", family: 4 }];
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = vi.fn(async () => PUBLIC_ANSWER);
  return { ...actual, default: { ...actual, promises: { ...actual.promises, lookup } }, promises: { ...actual.promises, lookup } };
});
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = vi.fn(async () => PUBLIC_ANSWER);
  return { ...actual, default: { ...actual, lookup }, lookup };
});

import {
  evaluateCaptureShowability,
  normalizeCaptureUrl,
  resolveCaptureTarget,
  stripImagePromptAt,
  captureImageFor,
  captureProductStill,
  type CaptureSnapshot,
  type CaptureChromiumLauncher,
  type CapturePage,
} from "../capture-bridge";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";
import type { PlatformGate } from "@/services/mcp/higgsfield-meter";
import type { VideoBrief } from "../brief-mapper";
import { SHOWABILITY_MIN_BODY_LEN, type ShowabilityChecks } from "@/services/qa/showability-gate";

const goodChecks = (over: Partial<ShowabilityChecks> = {}): ShowabilityChecks => ({
  overflow: false,
  offenders: [],
  scrollWidth: 1280,
  innerWidth: 1280,
  dirtyText: false,
  ctaCount: 2,
  bodyLen: 800,
  bodySample: "a real product homepage with lots of content",
  headingFontFamily: "Inter, sans-serif",
  bodyFontFamily: "Inter, sans-serif",
  ...over,
});

describe("evaluateCaptureShowability", () => {
  const base: CaptureSnapshot = { status: 200, loadErr: null, checks: goodChecks(), hasPasswordField: false };

  it("passes a real showable product page", () => {
    expect(evaluateCaptureShowability(base)).toEqual({ showable: true });
  });

  it("FAILS a login wall (visible password field)", () => {
    const v = evaluateCaptureShowability({ ...base, hasPasswordField: true });
    expect(v.showable).toBe(false);
    if (!v.showable) expect(v.reason).toBe("login_wall");
  });

  it("FAILS a near-empty / error shell (body below the min length)", () => {
    const v = evaluateCaptureShowability({ ...base, checks: goodChecks({ bodyLen: SHOWABILITY_MIN_BODY_LEN - 1 }) });
    expect(v.showable).toBe(false);
    if (!v.showable) expect(v.reason).toContain("near_empty");
  });

  it("FAILS an HTTP >= 400 navigation", () => {
    const v = evaluateCaptureShowability({ ...base, status: 503 });
    expect(v.showable).toBe(false);
    if (!v.showable) expect(v.reason).toBe("http_503");
  });

  it("FAILS a load failure", () => {
    const v = evaluateCaptureShowability({ ...base, loadErr: "net::ERR_NAME_NOT_RESOLVED" });
    expect(v.showable).toBe(false);
    if (!v.showable) expect(v.reason).toContain("load_failed");
  });

  it("FAILS when a QA sentinel / unescaped markup leaks into rendered text", () => {
    const v = evaluateCaptureShowability({ ...base, checks: goodChecks({ dirtyText: true }) });
    expect(v.showable).toBe(false);
  });
});

describe("SSRF / isPrivateIp", () => {
  it("isPrivateIp rejects internal / IMDS / loopback ranges", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("captureProductStill refuses a private-IP capture URL (never launches a browser)", async () => {
    let launched = false;
    const launcher = {
      launch: async () => {
        launched = true;
        throw new Error("should not launch for a blocked URL");
      },
    } as unknown as CaptureChromiumLauncher;

    const r = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://169.254.169.254/" },
      { launcher, meter: chargedMeter() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ssrf_blocked");
    expect(launched).toBe(false);
  });

  it("captureProductStill refuses a non-https (http) capture URL", async () => {
    const r = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "http://example.com/" },
      { launcher: fakeLauncher(showablePage()), meter: chargedMeter() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ssrf_blocked");
  });
});

describe("captureProductStill (fake browser)", () => {
  it("returns the PNG bytes for a SHOWABLE public page (test c producer)", async () => {
    const png = Buffer.from("PNGDATA-showable");
    const r = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
      { launcher: fakeLauncher(showablePage(png)), meter: chargedMeter() },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.png.equals(png)).toBe(true);
  });

  it("returns ok:false for a LOGIN-WALL page → the worker keeps the stylized fallback (test a)", async () => {
    const r = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
      { launcher: fakeLauncher(loginWallPage()), meter: chargedMeter() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("login_wall");
  });

  it("REJECTS a public URL that REDIRECTS to a private host (IMDS/loopback) — SSRF on the final URL", async () => {
    for (const finalUrl of ["https://169.254.169.254/latest/meta-data/", "http://[::1]/", "https://10.0.0.5/admin"]) {
      const r = await captureProductStill(
        { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
        { launcher: fakeLauncher(redirectedToPrivatePage(finalUrl)), meter: chargedMeter() },
      );
      expect(r.ok, `final ${finalUrl} must be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/load_failed|ssrf/i);
    }
  });

  it("interceptor: literal private IP aborts; public domain continues; DOMAIN resolving PRIVATE (DNS-rebind) aborts", async () => {
    let handler: ((r: import("../capture-bridge").CaptureRoute) => void | Promise<void>) | null = null;
    const launcher = fakeLauncherWithRoute(showablePage(), (h) => {
      handler = h;
    });
    const resolveHost = async (host: string) => (host === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
      { launcher, meter: chargedMeter(), resolveHost },
    );
    expect(handler, "the interceptor handler must be installed").toBeTruthy();
    const drive = async (url: string) => {
      let aborted = false;
      let continued = false;
      await handler!({
        request: () => ({ url: () => url }),
        abort: async () => {
          aborted = true;
        },
        continue: async () => {
          continued = true;
        },
      });
      return { aborted, continued };
    };
    expect((await drive("http://169.254.169.254/latest/meta-data/")).aborted).toBe(true);
    expect((await drive("http://127.0.0.1/")).aborted).toBe(true);
    expect((await drive("http://[::1]/")).aborted).toBe(true);
    expect((await drive("https://8.8.8.8/")).continued).toBe(true);
    expect((await drive("https://upcar.ai/app")).continued).toBe(true);
    expect((await drive("https://evil.example/x")).aborted).toBe(true);
  });

  it("degrades (no capture) when the meter is not 'charged' (idempotent retry / over-cap)", async () => {
    const r = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
      { launcher: fakeLauncher(showablePage()), meter: async () => ({ decision: "already", idempotency_key: "k" }) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("already");
  });

  it("fails closed when tenant/run is missing (real meter → meter_error)", async () => {
    const r = await captureProductStill(
      { tenant_id: "", run_id: "", url: "https://upcar.ai" },
      { launcher: fakeLauncher(showablePage()) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("meter_meter_error");
  });
});

describe("resolveCaptureTarget + captureImageFor", () => {
  it("targets the productui beat's first item", () => {
    const brief = briefWithBeats([
      { kind: "problem", headline: "x" },
      { kind: "productui", items: [{ title: "A", chips: [], imagePrompt: "gen a card" }, { title: "B", chips: [] }] },
      { kind: "cardwall", cards: [] },
      { kind: "cta", headline: "go" },
    ]);
    expect(resolveCaptureTarget(brief)).toEqual({ beatIndex: 1, itemIndex: 0 });
  });

  it("falls back to a hook hero when there is no productui beat", () => {
    const brief = briefWithBeats([
      { kind: "hook", headline: "hi", imagePrompt: "gen a hero" },
      { kind: "cta", headline: "go" },
    ]);
    expect(resolveCaptureTarget(brief)).toEqual({ beatIndex: 0, itemIndex: null });
  });

  it("returns null when no injectable beat exists", () => {
    const brief = briefWithBeats([{ kind: "cardwall", cards: [] }, { kind: "cta", headline: "go" }]);
    expect(resolveCaptureTarget(brief)).toBeNull();
  });

  it("strips the target item's imagePrompt so Higgsfield doesn't spend on a replaced image", () => {
    const brief = briefWithBeats([
      { kind: "productui", items: [{ title: "A", chips: [], imagePrompt: "gen a card" }] },
    ]);
    const target = resolveCaptureTarget(brief)!;
    stripImagePromptAt(brief, target);
    const b = brief.beats[1 - 1] as { items: Array<{ imagePrompt?: string }> };
    expect(b.items[0].imagePrompt).toBeUndefined();
  });

  it("a SHOWABLE capture injects as the productui beat image (test c)", () => {
    const brief = briefWithBeats([
      { kind: "problem", headline: "x" },
      { kind: "productui", items: [{ title: "A", chips: [], imagePrompt: "gen a card" }] },
      { kind: "cta", headline: "go" },
    ]);
    const png = Buffer.from("PNGDATA-showable");
    const target = resolveCaptureTarget(brief)!;
    stripImagePromptAt(brief, target);
    const img = captureImageFor(target, png, "A");
    expect(img.beatIndex).toBe(1);
    expect(img.itemIndex).toBe(0);
    expect(img.filename).toBe("capture_A.png");
    expect(Buffer.from(img.bytes).equals(png)).toBe(true);
  });
});

describe("normalizeCaptureUrl", () => {
  it("prepends https:// to a bare host and leaves a full URL untouched", () => {
    expect(normalizeCaptureUrl("upcar.ai")).toBe("https://upcar.ai");
    expect(normalizeCaptureUrl("https://upcar.ai/host")).toBe("https://upcar.ai/host");
    expect(normalizeCaptureUrl("http://upcar.ai")).toBe("http://upcar.ai");
  });
});

function chargedMeter(): () => Promise<PlatformGate> {
  return async () => ({ decision: "charged", idempotency_key: "k" });
}

type PageEvalMap = { checks: ShowabilityChecks; hasPassword: boolean; screenshot: Buffer; url?: string };

function fakePage(map: PageEvalMap): CapturePage {
  return {
    goto: async () => ({ status: () => 200 }),
    url: () => map.url ?? "https://upcar.ai/",
    waitForTimeout: async () => undefined,
    evaluate: async (fn: string) => {
      if (/password/i.test(fn)) return map.hasPassword;
      if (/getBoundingClientRect|innerWidth|scrollWidth/.test(fn)) return map.checks;
      return true;
    },
    screenshot: async () => map.screenshot,
  };
}

function redirectedToPrivatePage(finalUrl: string): CapturePage {
  return fakePage({ checks: goodChecks(), hasPassword: false, screenshot: Buffer.from("PNGDATA"), url: finalUrl });
}

function fakeLauncher(page: CapturePage): CaptureChromiumLauncher {
  return {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => page,
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
  };
}

function fakeLauncherWithRoute(
  page: CapturePage,
  onHandler: (h: (route: import("../capture-bridge").CaptureRoute) => void) => void,
): CaptureChromiumLauncher {
  return {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => page,
        route: async (_pattern: string, handler: (route: import("../capture-bridge").CaptureRoute) => void) => {
          onHandler(handler);
        },
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
  };
}

function showablePage(png: Buffer = Buffer.from("PNGDATA")): CapturePage {
  return fakePage({ checks: goodChecks(), hasPassword: false, screenshot: png });
}

function loginWallPage(): CapturePage {
  return fakePage({ checks: goodChecks({ bodyLen: 120 }), hasPassword: true, screenshot: Buffer.from("PNGDATA") });
}

function briefWithBeats(beats: unknown[]): VideoBrief {
  return {
    product: { name: "Upcar", oneLiner: "rent cars", url: "https://upcar.ai" },
    brand: { primaryColor: "#000", accentColor: "#fff" },
    audience: "hosts",
    tone: "clean",
    cta: { text: "go", url: "https://upcar.ai" },
    beats: beats as VideoBrief["beats"],
  };
}
