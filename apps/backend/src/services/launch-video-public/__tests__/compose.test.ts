import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePublicVideo, TARGET_SECONDS, FPS, MAX_FEATURES } from "../compose";
import { launchVideoIntakeSchema, intakeToVideoBrief } from "@/services/launch-video/brief-mapper";

const feature = (n: number) => ({ title: `Capability ${n}`, detail: `What capability ${n} does for you.` });

const RICH = {
  product_name: "Okara",
  one_liner: "An AI CMO that runs your marketing.",
  problem: "Marketing headcount is the first thing a small team cannot afford.",
  features: Array.from({ length: 10 }, (_, i) => feature(i + 1)),
  product_surface: {
    header: { title: "Your channels" },
    items: [
      { title: "SEO", chips: ["12 posts"] },
      { title: "LinkedIn", chips: ["daily"] },
    ],
  },
  metrics: [{ stat: "10+", label: "marketing agents" }],
  proof: { stat: "3x", label: "more content shipped" },
  coverage: { regions: ["US", "UK", "India"] },
  cta_text: "Start free",
  cta_url: "https://okara.ai",
};

describe("composePublicVideo", () => {
  it("clears the floor on rich material", () => {
    const plan = composePublicVideo(RICH);
    expect(plan.seconds).toBeGreaterThanOrEqual(TARGET_SECONDS);
    expect(plan.meets_target).toBe(true);
    expect(plan.missing).toEqual([]);
  });

  it("never pads: thin material is short, and says what would fix it", () => {
    const plan = composePublicVideo({
      product_name: "Okara",
      one_liner: "An AI CMO that runs your marketing.",
      features: [feature(1), feature(2), feature(3)],
      cta_text: "Start free",
      cta_url: "https://okara.ai",
    });
    expect(plan.meets_target).toBe(false);
    expect(plan.seconds).toBeLessThan(TARGET_SECONDS);
    expect(plan.missing.length).toBeGreaterThan(0);
    for (const m of plan.missing) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.seconds).toBeGreaterThan(0);
    }
    expect(plan.missing.map((m) => m.field)).toContain("features");
  });

  it("no dense layout repeats back to back", () => {
    const { scenes } = composePublicVideo(RICH);
    for (let i = 1; i < scenes.length; i++) {
      const kind = scenes[i]?.kind;
      if (kind === "feature") continue;
      expect(kind).not.toBe(scenes[i - 1]?.kind);
    }
  });

  it("spreads the set-pieces through the capability run, not after it", () => {
    const { scenes } = composePublicVideo(RICH);
    const kinds = scenes.map((s) => s.kind);
    const lastFeature = kinds.lastIndexOf("feature");
    const interleaved = kinds.slice(0, lastFeature).filter((k) => k === "metric" || k === "coverage" || k === "proof");
    expect(interleaved.length).toBeGreaterThan(0);
  });

  it("the plan survives the real intake schema and maps to a brief that clears the floor", () => {
    const plan = composePublicVideo(RICH);
    const parsed = launchVideoIntakeSchema.safeParse({
      product_name: RICH.product_name,
      one_liner: RICH.one_liner,
      url: RICH.cta_url,
      audience: "founders",
      tone: "clean",
      features: RICH.features.slice(0, 8),
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
      scenes: plan.scenes,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const brief = intakeToVideoBrief(parsed.data);
    const totalFrames = brief.beats.reduce((sum, b) => sum + (b.durationFrames ?? 0), 0);
    expect(brief.beats.length).toBe(plan.scenes.length);
    expect(totalFrames / FPS).toBeGreaterThanOrEqual(TARGET_SECONDS);
  });

  it("the ceiling, measured through the REAL schema, clears the floor", () => {
    const parsed = launchVideoIntakeSchema.safeParse({
      product_name: "Okara",
      one_liner: RICH.one_liner,
      url: RICH.cta_url,
      audience: "founders",
      tone: "clean",
      features: Array.from({ length: MAX_FEATURES }, (_, i) => feature(i + 1)),
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.features.length).toBe(MAX_FEATURES);

    const plan = composePublicVideo({
      ...RICH,
      features: parsed.data.features.map((f) => ({ title: f.title, detail: f.detail })),
    });
    expect(plan.seconds).toBeGreaterThanOrEqual(TARGET_SECONDS);
    expect(plan.meets_target).toBe(true);
  });

  it("never asks for a capability the schema would reject", () => {
    const plan = composePublicVideo({
      product_name: "Okara",
      one_liner: RICH.one_liner,
      features: Array.from({ length: MAX_FEATURES }, (_, i) => feature(i + 1)),
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
    });
    const asks = plan.missing.filter((m) => m.field === "features");
    for (const a of asks) {
      const n = Number(a.label.match(/^(\d+)/)?.[1] ?? 0);
      expect(n).toBeLessThanOrEqual(0);
    }
    expect(plan.missing.every((m) => m.field !== "features")).toBe(true);
  });

  it("a MAX-LENGTH intake survives the compose round trip", () => {
    const problem = "P".repeat(240);
    const detail = "D".repeat(240);
    const productName = "N".repeat(80);
    const features = Array.from({ length: MAX_FEATURES }, (_, i) => ({ title: `Cap ${i + 1}`, detail }));
    const plan = composePublicVideo({
      product_name: productName,
      one_liner: RICH.one_liner,
      problem,
      features,
      product_surface: { header: { title: productName.slice(0, 60) }, items: [{ title: "i", chips: ["c"] }] },
      metrics: [{ stat: "1", label: "a" }],
      proof: { stat: "3x", label: "more" },
      coverage: { regions: ["US", "UK"] },
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
    });
    const parsed = launchVideoIntakeSchema.safeParse({
      product_name: productName,
      one_liner: RICH.one_liner,
      url: RICH.cta_url,
      audience: "founders",
      tone: "clean",
      problem,
      features,
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
      scenes: plan.scenes,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | "));
    }
  });
});

describe("the composed durations survive the mapper", () => {
  it("a non-launch video_type SCALES the plan's durations, it does not discard them", () => {
    const plan = composePublicVideo(RICH);
    const composed = plan.scenes.map((sc) => sc.duration_frames ?? 0);
    expect(composed.every((n) => n > 0)).toBe(true);

    const parsed = launchVideoIntakeSchema.safeParse({
      product_name: RICH.product_name,
      one_liner: RICH.one_liner,
      url: RICH.cta_url,
      audience: "founders",
      tone: "clean",
      features: RICH.features.slice(0, 8),
      cta_text: RICH.cta_text,
      cta_url: RICH.cta_url,
      scenes: plan.scenes,
      video_type: "explainer",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const brief = intakeToVideoBrief(parsed.data);
    const rendered = brief.beats.map((b) => b.durationFrames ?? 0);
    expect(rendered.length).toBe(composed.length);

    const ratios = rendered.map((r, i) => r / (composed[i] ?? 1));
    const first = ratios[0] ?? 0;
    expect(first).toBeGreaterThan(0);
    for (const r of ratios) expect(Math.abs(r - first)).toBeLessThan(0.05);
  });
});

describe("every shortfall label names a field the form actually has", () => {
  const formSrc = readFileSync(
    join(__dirname, "../../../../../../apps/web/src/app/launch-video/LaunchVideoForm.tsx"),
    "utf8",
  );
  const formLabels = [...formSrc.matchAll(/<Field\s+label="([^"]+)"/g)].map((m) => m[1]!);

  it("finds the form's fields, so a path change fails loudly instead of vacuously passing", () => {
    expect(formLabels.length).toBeGreaterThanOrEqual(5);
    expect(formLabels).toContain("What should it show off?");
  });

  const PAIRS: Array<[string, string, string]> = [
    ["problem", "What is broken today?", "What is broken today"],
    ["product_surface", "What does someone actually do with it?", "What someone actually does with it"],
    ["metrics", "Real numbers", "Real numbers"],
    ["coverage", "Where do you operate?", "Where you operate"],
    ["features", "What should it show off?", "What should it show off"],
  ];

  const thin = () =>
    composePublicVideo({
      product_name: "Fernwork",
      one_liner: "Field teams log every site visit from their phone.",
      features: [{ title: "Scan and log", detail: "Scan the tag and the visit is recorded." }],
    } as unknown as Parameters<typeof composePublicVideo>[0]);

  it.each(PAIRS)("the %s ask points at the form's own question", (field, formLabel, phrase) => {
    expect(formLabels, `the form no longer has a field labelled "${formLabel}"`).toContain(formLabel);
    const ask = thin().missing.find((m) => m.field === field);
    expect(ask, `no shortfall ask for ${field}`).toBeDefined();
    expect(ask!.label).toContain(phrase);
  });

  it("no label uses the retired revenue/users/churn framing", () => {
    for (const m of thin().missing) {
      expect(m.label.toLowerCase()).not.toMatch(/revenue|churn|active users|growth\b/);
    }
  });
});
