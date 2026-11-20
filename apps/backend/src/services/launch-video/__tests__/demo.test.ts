import { describe, it, expect } from "vitest";
import {
  intakeToVideoBrief,
  launchVideoIntakeSchema,
  VIDEO_TYPE_PROFILES,
  VIDEO_TYPE_VALUES,
  type LaunchVideoIntake,
} from "../brief-mapper";
import {
  resolveCaptureTarget,
  stripImagePromptAt,
  captureImageFor,
  captureProductStill,
  type CaptureChromiumLauncher,
  type CapturePage,
} from "../capture-bridge";
import type { PlatformGate } from "@/services/mcp/higgsfield-meter";
import type { ShowabilityChecks } from "@/services/qa/showability-gate";

const demoIntake: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "people who need a car for the weekend",
  tone: "clean",
  video_type: "demo",
  capture_url: "https://upcar.ai",
  product_surface: {
    header: { title: "Cars near you", search_placeholder: "Austin, TX" },
    items: [
      { image_prompt: "a clean silver Tesla Model 3 on a sunny street, photoreal", title: "Tesla Model 3", chips: ["$48/day", "4.9 stars"] },
      { image_prompt: "a white Jeep Wrangler parked downtown, photoreal", title: "Jeep Wrangler", chips: ["$65/day", "4.8 stars"] },
    ],
  },
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Thousands of cars from real people in your city." },
  ],
  metrics: [{ stat: "600+", label: "active hosts" }],
  cta_text: "See it yourself",
  cta_url: "https://upcar.ai",
};

describe("demo video_type — registration + shape", () => {
  it("'demo' is a registered video_type with a product-forward arc", () => {
    expect(VIDEO_TYPE_VALUES).toContain("demo");
    const profile = VIDEO_TYPE_PROFILES.demo;
    expect(profile.arc).not.toBeNull();
    expect(profile.arc![0]).toBe("hook");
    expect(profile.arc![1]).toBe("productui");
    expect(profile.arc).toContain("cta");
    expect(profile.arc).not.toContain("problem");
    expect(profile.arc).not.toContain("broll" as never);
  });

  it("the render tool schema accepts video_type:'demo' with capture_url", () => {
    const parsed = launchVideoIntakeSchema.safeParse(demoIntake);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.video_type).toBe("demo");
      expect(parsed.data.capture_url).toBe("https://upcar.ai");
    }
  });
});

describe("(a) a demo request with capture_url produces a demo-shaped brief using the captured still", () => {
  it("builds a demo brief that LEADS with the product UI (product-forward)", () => {
    const brief = intakeToVideoBrief(demoIntake);
    const kinds = brief.beats.map((b) => b.kind);
    expect(kinds[0]).toBe("hook");
    expect(kinds[1]).toBe("productui");
    expect(kinds).toContain("cta");
    expect(kinds).not.toContain("problem");
    expect(kinds).not.toContain("broll");
  });

  it("the captured still lands on the demo's productui beat (the bridge injection target)", () => {
    const brief = intakeToVideoBrief(demoIntake);
    const target = resolveCaptureTarget(brief);
    expect(target).not.toBeNull();
    const productuiIdx = brief.beats.findIndex((b) => b.kind === "productui");
    expect(target).toEqual({ beatIndex: productuiIdx, itemIndex: 0 });
  });

  it("end-to-end: a SHOWABLE live-URL capture flows into the demo's product beat as the image", async () => {
    const png = Buffer.from("REAL-UI-SCREENSHOT-BYTES");
    const cap = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: demoIntake.capture_url! },
      { launcher: fakeLauncher(showablePage(png)), meter: chargedMeter() },
    );
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;

    const brief = intakeToVideoBrief(demoIntake);
    const target = resolveCaptureTarget(brief)!;
    stripImagePromptAt(brief, target);
    const injected = captureImageFor(target, cap.png, "A");

    const productuiIdx = brief.beats.findIndex((b) => b.kind === "productui");
    expect(injected.beatIndex).toBe(productuiIdx);
    expect(injected.itemIndex).toBe(0);
    expect(Buffer.from(injected.bytes).equals(png)).toBe(true);
    const productui = brief.beats[productuiIdx] as { items: Array<{ imagePrompt?: string }> };
    expect(productui.items[0].imagePrompt).toBeUndefined();
  });
});

describe("(b) motion is NOT attempted for a demo — still only", () => {
  it("the demo brief contains no motion (broll/video) beat", () => {
    const brief = intakeToVideoBrief(demoIntake);
    expect(brief.beats.some((b) => b.kind === "broll")).toBe(false);
  });

  it("the injected capture is a STILL image, and the capture seam is screenshot-only", async () => {
    let screenshotCalls = 0;
    const page: CapturePage = {
      goto: async () => ({ status: () => 200 }),
      url: () => "https://upcar.ai/",
      waitForTimeout: async () => undefined,
      evaluate: async (fn: string) => {
        if (/password/i.test(fn)) return false;
        if (/getBoundingClientRect|innerWidth|scrollWidth/.test(fn)) return goodChecks();
        return true;
      },
      screenshot: async () => {
        screenshotCalls += 1;
        return Buffer.from("STILL-PNG");
      },
    };
    expect(typeof page.screenshot).toBe("function");
    expect((page as Record<string, unknown>).recordVideo).toBeUndefined();
    expect((page as Record<string, unknown>).startScreencast).toBeUndefined();

    const cap = await captureProductStill(
      { tenant_id: "t1", run_id: "r1", url: "https://upcar.ai" },
      { launcher: fakeLauncher(page), meter: chargedMeter() },
    );
    expect(cap.ok).toBe(true);
    expect(screenshotCalls).toBe(1);

    const brief = intakeToVideoBrief(demoIntake);
    const target = resolveCaptureTarget(brief)!;
    const injected = captureImageFor(target, cap.ok ? cap.png : Buffer.alloc(0), "A");
    expect(injected.filename).toMatch(/\.png$/);
    expect((injected as Record<string, unknown>).videoPrompt).toBeUndefined();
  });
});

function goodChecks(over: Partial<ShowabilityChecks> = {}): ShowabilityChecks {
  return {
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
  };
}

function chargedMeter(): () => Promise<PlatformGate> {
  return async () => ({ decision: "charged", idempotency_key: "k" });
}

function showablePage(png: Buffer = Buffer.from("PNGDATA")): CapturePage {
  return {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://upcar.ai/",
    waitForTimeout: async () => undefined,
    evaluate: async (fn: string) => {
      if (/password/i.test(fn)) return false;
      if (/getBoundingClientRect|innerWidth|scrollWidth/.test(fn)) return goodChecks();
      return true;
    },
    screenshot: async () => png,
  };
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
