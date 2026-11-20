import { describe, it, expect } from "vitest";
import {
  intakeToVideoBrief,
  launchVideoIntakeSchema,
  stripDashes,
  sanitizeBrief,
  aspectForPlatform,
  VIDEO_TYPE_PROFILES,
  VIDEO_TYPE_VALUES,
  type LaunchVideoIntake,
  type VideoBrief,
} from "../brief-mapper";

const upcar: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "people who need a car for the weekend",
  tone: "bold",
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Thousands of cars from real people in your city." },
    { title: "Fully insured", detail: "Every trip covered end to end." },
  ],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
};

const saas: LaunchVideoIntake = {
  product_name: "Pulse",
  one_liner: "Your whole business, on one dashboard.",
  url: "https://pulse.app",
  audience: "operators at growing companies",
  tone: "enterprise",
  features: [
    { title: "Live dashboards", detail: "Every metric refreshed in real time." },
    { title: "Connect your tools", detail: "Plug in your warehouse and go." },
    { title: "Alerts that matter", detail: "Get pinged only when a number breaks." },
  ],
  cta_text: "See your numbers",
  cta_url: "https://pulse.app",
};

const dtc: LaunchVideoIntake = {
  product_name: "Lumi",
  one_liner: "A desk lamp that learns your light.",
  url: "https://lumi.co",
  audience: "people who work from home",
  tone: "playful",
  features: [
    { title: "Ships in two days", detail: "Free delivery, right to your door." },
    { title: "Thirty-day returns", detail: "Love it or send it back." },
    { title: "Made to last", detail: "Aircraft-grade aluminum, five-year warranty." },
  ],
  cta_text: "Light up your desk",
  cta_url: "https://lumi.co",
};

const FIXTURES = { upcar, saas, dtc };

const BANNED = [
  "slack",
  "ask in plain english",
  "it ships",
  "hand off",
  "can you handle this",
  "everything you can hand off",
];

function briefText(brief: VideoBrief): string {
  const parts: string[] = [];
  for (const b of brief.beats) {
    const any = b as Record<string, unknown>;
    for (const k of ["headline", "sub", "eyebrow"]) if (typeof any[k] === "string") parts.push(any[k] as string);
    if (b.vo?.srtText) parts.push(b.vo.srtText);
    if (b.kind === "cardwall") for (const c of b.cards) parts.push(c.label, c.headline, c.body ?? "", c.footer ?? "");
    if (b.kind === "chat") for (const m of b.messages) parts.push(m.mention ?? "", m.body ?? "", m.reply?.body ?? "", m.reply?.role ?? "", m.reply?.badge ?? "");
    if (b.kind === "productui") {
      parts.push(b.header?.title ?? "", b.header?.searchPlaceholder ?? "");
      for (const it of b.items) parts.push(it.title, ...it.chips);
    }
    if (b.kind === "coverage") parts.push(...b.regions);
  }
  return parts.join("  ").toLowerCase();
}

describe("intakeToVideoBrief — product-neutral (no imposed narrative)", () => {
  it("emits hook → cardwall → cta (no chat beat, no metric when proof absent)", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).toEqual(["hook", "cardwall", "cta"]);
  });

  it("NEVER emits a deterministic chat/agent-conversation beat for any product shape", () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const kinds = intakeToVideoBrief(fx).beats.map((b) => b.kind);
      expect(kinds, `${name} must have no chat beat`).not.toContain("chat");
    }
  });

  it("injects ZERO Zavi-narrative terms (Slack / @-mention / hand-off / agent-ask) for any product", () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const text = briefText(intakeToVideoBrief(fx));
      for (const term of BANNED) {
        expect(text.includes(term), `${name}: mapper injected banned term "${term}"`).toBe(false);
      }
      expect(text.includes("@"), `${name}: mapper injected an @mention`).toBe(false);
    }
  });

  it("CardWall copies feature {title,detail} VERBATIM and labels with a neutral numeric index (never a role)", () => {
    const brief = intakeToVideoBrief(upcar);
    const wall = brief.beats.find((b) => b.kind === "cardwall");
    expect(wall?.kind).toBe("cardwall");
    if (wall && wall.kind === "cardwall") {
      expect(wall.cards).toHaveLength(3);
      expect(wall.cards[0]).toMatchObject({ headline: "Book in two minutes", body: "Find a car near you and reserve it instantly." });
      wall.cards.forEach((c, i) => {
        expect(c.label, "label is a neutral 2-digit index, not a role").toBe(String(i + 1).padStart(2, "0"));
        expect(c.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
      });
      expect(wall.cards[0].accent).not.toBe(wall.cards[1].accent);
    }
  });

  it("inserts a metric beat (second-to-last) only when a stat is provided, no fabricated series", () => {
    const without = intakeToVideoBrief(upcar).beats.map((b) => b.kind);
    expect(without).not.toContain("metric");
    const withProof = intakeToVideoBrief({ ...upcar, proof: { stat: "600+", label: "active hosts" } });
    const kinds = withProof.beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "metric", "cta"]);
    const metric = withProof.beats.find((b) => b.kind === "metric");
    expect(metric).toMatchObject({ kind: "metric", metrics: [{ stat: "600+", label: "active hosts" }] });
    if (metric && metric.kind === "metric") expect(metric.metrics?.[0].series).toBeUndefined();
  });

  it("hook uses the one-liner; cta uses cta_text/url; product + tone carried through", () => {
    const brief = intakeToVideoBrief(upcar);
    expect(brief.beats[0]).toMatchObject({ kind: "hook", headline: "Rent the perfect car from local hosts." });
    expect(brief.product).toEqual({ name: "Upcar", oneLiner: "Rent the perfect car from local hosts.", url: "https://upcar.ai" });
    expect(brief.cta).toEqual({ text: "Start your trip", url: "https://upcar.ai" });
    expect(brief.tone).toBe("bold");
    expect(brief.aspect).toBe("16:9");
  });

  it("sets vo.srtText on every beat but never vo.audioFile", () => {
    const brief = intakeToVideoBrief({ ...upcar, proof: { stat: "600+", label: "active hosts" } });
    for (const b of brief.beats) {
      expect(b.vo?.srtText && b.vo.srtText.length).toBeGreaterThan(0);
      expect(b.vo?.audioFile).toBeUndefined();
    }
  });

  it("strips the URL scheme in the spoken CTA line", () => {
    const cta = intakeToVideoBrief(upcar).beats.at(-1)!;
    expect(cta.vo?.srtText).toContain("upcar.ai");
    expect(cta.vo?.srtText).not.toContain("https://");
  });
});

describe("launchVideoIntakeSchema", () => {
  it("rejects 0 features and more than the cap", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, features: [] }).success).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ title: `f${i}`, detail: `d${i}` }));
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, features: thirteen }).success).toBe(false);
  });

  it("accepts 1 up to the cap of 12 features, and an optional proof", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, features: [upcar.features[0]] }).success).toBe(true);
    const twelve = Array.from({ length: 12 }, (_, i) => ({ title: `f${i}`, detail: `d${i}` }));
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, features: twelve }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, proof: { stat: "10x", label: "more output" } }).success).toBe(true);
  });

  it("accepts an optional per-feature meta tag (≤40), rejects an over-long one", () => {
    const withMeta = { ...upcar, features: [{ title: "Real hosts", detail: "From locals.", meta: "600+ hosts" }] };
    expect(launchVideoIntakeSchema.safeParse(withMeta).success).toBe(true);
    const tooLong = { ...upcar, features: [{ title: "Real hosts", detail: "From locals.", meta: "x".repeat(41) }] };
    expect(launchVideoIntakeSchema.safeParse(tooLong).success).toBe(false);
  });

  it("accepts an optional 1-3 metrics array, rejects 0 or >3", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, metrics: [{ stat: "600+", label: "active hosts" }] }).success).toBe(true);
    expect(
      launchVideoIntakeSchema.safeParse({
        ...upcar,
        metrics: [
          { stat: "600+", label: "hosts" },
          { stat: "$1.2M", label: "GMV" },
          { stat: "5", label: "cities" },
        ],
      }).success,
    ).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, metrics: [] }).success).toBe(false);
    const four = Array.from({ length: 4 }, (_, i) => ({ stat: `${i}`, label: `l${i}` }));
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, metrics: four }).success).toBe(false);
  });

  it("rejects an invalid tone", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, tone: "fancy" }).success).toBe(false);
  });
});

describe("intakeToVideoBrief — content layer (per-feature meta + multi-metric)", () => {
  it("(a) feature.meta flows through to the card footer", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      features: [
        { title: "Real local hosts", detail: "Cars from real people.", meta: "600+ hosts" },
        { title: "Across cities", detail: "Pick up near you.", meta: "5 cities" },
      ],
    };
    const wall = intakeToVideoBrief(intake).beats.find((b) => b.kind === "cardwall");
    expect(wall?.kind).toBe("cardwall");
    if (wall && wall.kind === "cardwall") {
      expect(wall.cards[0].footer).toBe("600+ hosts");
      expect(wall.cards[1].footer).toBe("5 cities");
      expect(wall.cards[0]).toMatchObject({ headline: "Real local hosts", body: "Cars from real people." });
    }
  });

  it("(b) features WITHOUT meta produce cards with NO footer (no fabrication)", () => {
    const wall = intakeToVideoBrief(upcar).beats.find((b) => b.kind === "cardwall");
    if (wall && wall.kind === "cardwall") {
      for (const c of wall.cards) expect(c.footer).toBeUndefined();
    }
  });

  it("(b') mixed — only the feature with a real meta gets a footer", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      features: [
        { title: "Real local hosts", detail: "Cars from real people.", meta: "600+ hosts" },
        { title: "Fully insured", detail: "Every trip covered." },
      ],
    };
    const wall = intakeToVideoBrief(intake).beats.find((b) => b.kind === "cardwall");
    if (wall && wall.kind === "cardwall") {
      expect(wall.cards[0].footer).toBe("600+ hosts");
      expect(wall.cards[1].footer).toBeUndefined();
    }
  });

  it("(c) intake.metrics → ONE merged metric beat showing ALL stats together (no repeated single-stat slides)", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      metrics: [
        { stat: "600+", label: "active hosts" },
        { stat: "$1.2M", label: "monthly GMV" },
      ],
    };
    const brief = intakeToVideoBrief(intake);
    expect(brief.beats.map((b) => b.kind)).toEqual(["hook", "cardwall", "metric", "cta"]);
    const metricBeats = brief.beats.filter((b) => b.kind === "metric");
    expect(metricBeats).toHaveLength(1);
    expect(metricBeats[0].kind === "metric" && metricBeats[0].metrics).toEqual([
      { stat: "600+", label: "active hosts" },
      { stat: "$1.2M", label: "monthly GMV" },
    ]);
    expect(metricBeats[0].vo?.srtText).toBe("600+, active hosts. $1.2M, monthly GMV.");
  });

  it("(c') metrics supersedes proof when both are present", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      proof: { stat: "10x", label: "ignored" },
      metrics: [{ stat: "600+", label: "active hosts" }],
    };
    const metric = intakeToVideoBrief(intake).beats.find((b) => b.kind === "metric");
    if (metric && metric.kind === "metric") {
      expect(metric.metrics).toEqual([{ stat: "600+", label: "active hosts" }]);
    }
  });

  it("(d) proof-only still works — single metric, back-compat", () => {
    const intake = { ...upcar, proof: { stat: "$1.2M", label: "monthly GMV" } };
    const brief = intakeToVideoBrief(intake);
    expect(brief.beats.map((b) => b.kind)).toEqual(["hook", "cardwall", "metric", "cta"]);
    const metric = brief.beats.find((b) => b.kind === "metric");
    if (metric && metric.kind === "metric") {
      expect(metric.metrics).toEqual([{ stat: "$1.2M", label: "monthly GMV" }]);
    }
  });

  it("(d') no proof and no metrics → no metric beat (no fabrication)", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).not.toContain("metric");
  });

  it("(f) intake.problem → a why-now `problem` beat right after the hook, verbatim", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      problem: "Renting a car still means a counter, a line, and a markup.",
    };
    const brief = intakeToVideoBrief(intake);
    expect(brief.beats.map((b) => b.kind)).toEqual(["hook", "problem", "cardwall", "cta"]);
    const problem = brief.beats[1];
    expect(problem.kind).toBe("problem");
    expect(problem.kind === "problem" && problem.headline).toBe(
      "Renting a car still means a counter, a line, and a markup.",
    );
    expect(problem.vo?.srtText).toBe("Renting a car still means a counter, a line, and a markup.");
  });

  it("(g) no problem line → NO why-now beat (content-adaptive, never padded)", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).not.toContain("problem");
  });

  it("(h) >3 features collapse to ONE wall of the 3 STRONGEST (first-3, never a second wall)", () => {
    const sixFeatures = Array.from({ length: 6 }, (_, i) => ({
      title: `Capability ${i + 1}`,
      detail: `What capability ${i + 1} does.`,
    }));
    const brief = intakeToVideoBrief({ ...upcar, features: sixFeatures });
    const walls = brief.beats.filter((b) => b.kind === "cardwall");
    expect(walls).toHaveLength(1);
    if (walls[0].kind === "cardwall") {
      expect(walls[0].cards).toHaveLength(3);
      expect(walls[0].cards.map((c) => c.label)).toEqual(["01", "02", "03"]);
      expect(walls[0].cards.map((c) => c.headline)).toEqual(["Capability 1", "Capability 2", "Capability 3"]);
      expect(walls[0].vo?.srtText).toBe("Capability 1. Capability 2. Capability 3.");
    }
  });

  it("(h') exactly 3 features → a SINGLE wall of all 3", () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ title: `f${i}`, detail: `d${i}` }));
    const walls = intakeToVideoBrief({ ...upcar, features: three }).beats.filter((b) => b.kind === "cardwall");
    expect(walls).toHaveLength(1);
    if (walls[0].kind === "cardwall") expect(walls[0].cards).toHaveLength(3);
  });

  it("(i) RICH intake → ~7 VARIED beats, NO two adjacent the same (hook,problem,productui,cardwall,coverage,metric,cta)", () => {
    const rich: LaunchVideoIntake = {
      ...upcar,
      problem: "Renting a car still means a counter, a line, and a markup.",
      product_surface: {
        header: { title: "Cars near you", search_placeholder: "Search cars" },
        items: [
          { glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] },
          { glyph: "car", title: "Jeep Wrangler", chips: ["$74/day", "4.8★", "Phoenix AZ"] },
          { glyph: "car", title: "Toyota Camry", chips: ["$43/day", "5.0★", "Tampa FL"] },
        ],
      },
      coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
      features: Array.from({ length: 6 }, (_, i) => ({ title: `Cap ${i + 1}`, detail: `Detail ${i + 1}.` })),
      metrics: [
        { stat: "600+", label: "active hosts" },
        { stat: "$1.2M", label: "monthly GMV" },
      ],
    };
    const kinds = intakeToVideoBrief(rich).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"]);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
  });

  it("(j) productui beat is emitted ONLY when product_surface is supplied, items pass through verbatim", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).not.toContain("productui");
    const withSurface = intakeToVideoBrief({
      ...upcar,
      product_surface: {
        header: { title: "Cars near you" },
        items: [
          { glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] },
          { glyph: "car", title: "Jeep Wrangler", chips: ["$74/day", "4.8★", "Phoenix AZ"] },
        ],
      },
    });
    const kinds = withSurface.beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "productui", "cardwall", "cta"]);
    const pui = withSurface.beats.find((b) => b.kind === "productui");
    if (pui && pui.kind === "productui") {
      expect(pui.header?.title).toBe("Cars near you");
      expect(pui.items).toHaveLength(2);
      expect(pui.items[0]).toEqual({ glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] });
      expect(pui.domain).toBe("upcar.ai");
    }
  });

  it("(j') the SAME productui component renders a NON-marketplace (SaaS dashboard rows) from different data — no car-specific shape", () => {
    const saasSurface = intakeToVideoBrief({
      ...saas,
      product_surface: {
        header: { title: "Your dashboard" },
        items: [
          { glyph: "chart", title: "Monthly revenue", chips: ["$12.4k MRR", "↑ 12%"] },
          { glyph: "bolt", title: "Active users", chips: ["3,210", "↑ 4%"] },
        ],
      },
    });
    const pui = saasSurface.beats.find((b) => b.kind === "productui");
    expect(pui?.kind).toBe("productui");
    if (pui && pui.kind === "productui") {
      expect(pui.items[0].title).toBe("Monthly revenue");
      expect(pui.items[0].glyph).toBe("chart");
    }
  });

  it("(k) coverage beat is emitted ONLY when coverage is supplied; regions pass through verbatim", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).not.toContain("coverage");
    const withCov = intakeToVideoBrief({
      ...upcar,
      coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
    });
    expect(withCov.beats.map((b) => b.kind)).toEqual(["hook", "cardwall", "coverage", "cta"]);
    const cov = withCov.beats.find((b) => b.kind === "coverage");
    if (cov && cov.kind === "coverage") {
      expect(cov.regions).toEqual(["California", "Nevada", "Texas", "Arizona", "Florida"]);
      expect(cov.headline).toBe("Live in 5 states.");
    }
  });

  it("(k') a non-geographic product NEVER gets a coverage scene (omitted by default)", () => {
    expect(intakeToVideoBrief(saas).beats.map((b) => b.kind)).not.toContain("coverage");
    expect(intakeToVideoBrief(dtc).beats.map((b) => b.kind)).not.toContain("coverage");
  });

  it("(l) narration.* overrides per-beat VO (the investor script adds context, doesn't echo)", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      problem: "Renting a car still means a counter, a line, and a markup.",
      metrics: [{ stat: "600+", label: "active hosts" }],
      narration: {
        hook: "Upcar is the deep-density rental marketplace — Turo went wide, we went deep.",
        problem: "Incumbents optimized listings; we optimized local supply economics.",
        metrics: "600 hosts, capital-efficiently, in one year.",
        cta: "If you're investing in marketplaces, find us at upcar.ai.",
      },
    };
    const brief = intakeToVideoBrief(intake);
    const hook = brief.beats.find((b) => b.kind === "hook");
    const problem = brief.beats.find((b) => b.kind === "problem");
    const metric = brief.beats.find((b) => b.kind === "metric");
    const cta = brief.beats.at(-1);
    expect(hook?.vo?.srtText).toBe("Upcar is the deep-density rental marketplace, Turo went wide, we went deep.");
    expect(problem?.vo?.srtText).toBe("Incumbents optimized listings; we optimized local supply economics.");
    expect(metric?.vo?.srtText).toBe("600 hosts, capital-efficiently, in one year.");
    expect(cta?.vo?.srtText).toBe("If you're investing in marketplaces, find us at upcar.ai.");
    expect(hook?.vo?.srtText).not.toBe(upcar.one_liner);
  });

  it("(m) the productui + coverage path injects ZERO narrative terms / no @mention and no chat beat", () => {
    const full: LaunchVideoIntake = {
      ...upcar,
      problem: "Renting a car still means a counter, a line, and a markup.",
      product_surface: {
        header: { title: "Cars near you" },
        items: [
          { glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] },
          { glyph: "car", title: "Jeep Wrangler", chips: ["$74/day", "4.8★", "Phoenix AZ"] },
        ],
      },
      coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
      metrics: [{ stat: "600+", label: "active hosts" }],
    };
    const brief = intakeToVideoBrief(full);
    expect(brief.beats.map((b) => b.kind)).not.toContain("chat");
    const text = briefText(brief);
    for (const term of BANNED) expect(text.includes(term), `injected banned term "${term}"`).toBe(false);
    expect(text.includes("@")).toBe(false);
  });

  it("(e) the dense path still injects ZERO Zavi-narrative terms and no chat beat", () => {
    const dense: LaunchVideoIntake = {
      ...upcar,
      features: [
        { title: "Book in two minutes", detail: "Reserve instantly.", meta: "30s avg" },
        { title: "Real local hosts", detail: "Cars from real people.", meta: "600+ hosts" },
      ],
      metrics: [
        { stat: "600+", label: "active hosts" },
        { stat: "$1.2M", label: "monthly GMV" },
      ],
    };
    const brief = intakeToVideoBrief(dense);
    expect(brief.beats.map((b) => b.kind)).not.toContain("chat");
    const text = briefText(brief);
    for (const term of BANNED) expect(text.includes(term), `injected banned term "${term}"`).toBe(false);
    expect(text.includes("@")).toBe(false);
  });
});

describe("intakeToVideoBrief — product_shape adaptive arc (Phase 1)", () => {
  const richBase: LaunchVideoIntake = {
    ...upcar,
    problem: "Renting a car still means a counter, a line, and a markup.",
    product_surface: {
      header: { title: "Cars near you", search_placeholder: "Search cars" },
      items: [
        { glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] },
        { glyph: "car", title: "Jeep Wrangler", chips: ["$74/day", "4.8★", "Phoenix AZ"] },
      ],
    },
    coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
    metrics: [{ stat: "600+", label: "active hosts" }],
  };

  it("marketplace → full geographic arc (hook,problem,productui,cardwall,coverage,metric,cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "marketplace" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"]);
  });

  it("saas → LEADS with the product demo and OMITS coverage (hook,productui,problem,cardwall,metric,cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "saas" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "productui", "problem", "cardwall", "metric", "cta"]);
    expect(kinds).not.toContain("coverage");
    const cta = intakeToVideoBrief({ ...richBase, product_shape: "saas" }).beats.at(-1);
    if (cta && cta.kind === "cta") {
      for (const c of cta.chips ?? []) expect(c).not.toContain("MARKETS");
    }
  });

  it("dtc → hero,what's-special,reviews,close (hook,productui,cardwall,metric,cta) — no problem, no coverage", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "dtc" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "productui", "cardwall", "metric", "cta"]);
    expect(kinds).not.toContain("problem");
    expect(kinds).not.toContain("coverage");
  });

  it("devtool → why-now,demo,capabilities,benchmarks (hook,problem,productui,cardwall,metric,cta) — no coverage", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "devtool" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "problem", "productui", "cardwall", "metric", "cta"]);
    expect(kinds).not.toContain("coverage");
  });

  it("consumer → general default arc (hook,problem,productui,cardwall,coverage,metric,cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "consumer" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"]);
  });

  it("THE CORE PROOF: three shapes on the SAME intake yield GENUINELY DIFFERENT arcs", () => {
    const mk = intakeToVideoBrief({ ...richBase, product_shape: "marketplace" }).beats.map((b) => b.kind);
    const sa = intakeToVideoBrief({ ...richBase, product_shape: "saas" }).beats.map((b) => b.kind);
    const dt = intakeToVideoBrief({ ...richBase, product_shape: "dtc" }).beats.map((b) => b.kind);
    expect(mk).not.toEqual(sa);
    expect(mk).not.toEqual(dt);
    expect(sa).not.toEqual(dt);
    expect(mk).toContain("coverage");
    expect(sa).not.toContain("coverage");
    expect(sa[1]).toBe("productui");
    expect(mk[1]).toBe("problem");
  });

  it("shape NEVER fabricates: a shape arc only emits scenes whose data was actually supplied", () => {
    const thin = intakeToVideoBrief({ ...upcar, product_shape: "marketplace" }).beats.map((b) => b.kind);
    expect(thin).toEqual(["hook", "cardwall", "cta"]);
  });

  it("ABSENT shape → byte-for-byte legacy behavior (no regression)", () => {
    const withShape = intakeToVideoBrief({ ...richBase, product_shape: "consumer" });
    const noShape = intakeToVideoBrief(richBase);
    expect(noShape.beats.map((b) => b.kind)).toEqual(withShape.beats.map((b) => b.kind));
    expect(noShape.beats.map((b) => b.kind)).toEqual([
      "hook",
      "problem",
      "productui",
      "cardwall",
      "coverage",
      "metric",
      "cta",
    ]);
  });

  it("schema accepts a valid product_shape and rejects an invalid one", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, product_shape: "saas" }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, product_shape: "blockchain" }).success).toBe(false);
    expect(launchVideoIntakeSchema.safeParse(upcar).success).toBe(true);
  });

  it("every shape stays product-neutral (zero injected narrative terms / no @mention)", () => {
    for (const shape of ["marketplace", "saas", "dtc", "devtool", "consumer"] as const) {
      const text = briefText(intakeToVideoBrief({ ...richBase, product_shape: shape }));
      for (const term of BANNED) expect(text.includes(term), `${shape}: injected "${term}"`).toBe(false);
      expect(text.includes("@"), `${shape}: injected @mention`).toBe(false);
      expect(text.includes("—"), `${shape}: leaked em-dash`).toBe(false);
    }
  });
});

describe("intakeToVideoBrief — image prompts (Phase 3)", () => {
  it("hero_image_prompt → hook.imagePrompt; item image_prompt → productui item.imagePrompt", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      hero_image_prompt: "a row of cars on a sunny street, photoreal, 16:9",
      product_surface: {
        header: { title: "Cars near you" },
        items: [
          { glyph: "car", title: "Tesla Model 3", chips: ["$61/day"], image_prompt: "a silver Tesla Model 3, photoreal" },
          { glyph: "car", title: "Jeep Wrangler", chips: ["$74/day"] },
        ],
      },
    };
    const brief = intakeToVideoBrief(intake);
    const hook = brief.beats.find((b) => b.kind === "hook");
    expect(hook?.kind === "hook" && hook.imagePrompt).toBe("a row of cars on a sunny street, photoreal, 16:9");
    const pui = brief.beats.find((b) => b.kind === "productui");
    if (pui && pui.kind === "productui") {
      expect(pui.items[0].imagePrompt).toBe("a silver Tesla Model 3, photoreal");
      expect(pui.items[1].imagePrompt).toBeUndefined();
    }
  });

  it("NO image prompts → no imagePrompt anywhere (the no-credit glyph path)", () => {
    const brief = intakeToVideoBrief({
      ...upcar,
      product_surface: { header: { title: "Cars" }, items: [{ glyph: "car", title: "Tesla", chips: ["$61/day"] }] },
    });
    const hook = brief.beats.find((b) => b.kind === "hook");
    const pui = brief.beats.find((b) => b.kind === "productui");
    expect(hook?.kind === "hook" && hook.imagePrompt).toBeUndefined();
    if (pui && pui.kind === "productui") expect(pui.items[0].imagePrompt).toBeUndefined();
  });

  it("authored scenes carry image prompts too (hook hero + productui item)", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      scenes: [
        { kind: "hook", image_prompt: "hero shot of the product" },
        {
          kind: "productui",
          items: [{ title: "Tesla", chips: ["$61/day"], image_prompt: "a silver tesla" }],
        },
        { kind: "cta" },
      ],
    };
    const brief = intakeToVideoBrief(intake);
    const hook = brief.beats[0];
    expect(hook.kind === "hook" && hook.imagePrompt).toBe("hero shot of the product");
    const pui = brief.beats[1];
    if (pui.kind === "productui") expect(pui.items[0].imagePrompt).toBe("a silver tesla");
  });

  it("schema accepts image_prompt fields", () => {
    expect(
      launchVideoIntakeSchema.safeParse({
        ...upcar,
        hero_image_prompt: "x",
        product_surface: {
          items: [
            { title: "T", chips: ["a"], image_prompt: "y" },
            { title: "U", chips: ["b"] },
          ],
        },
      }).success,
    ).toBe(true);
  });
});

describe("intakeToVideoBrief — b-roll prompt (Phase 4)", () => {
  it("broll_prompt → a broll beat with videoPrompt, inserted right after the hook", () => {
    const brief = intakeToVideoBrief({ ...upcar, broll_prompt: "slow dolly past cars at golden hour" });
    const kinds = brief.beats.map((b) => b.kind);
    expect(kinds[0]).toBe("hook");
    expect(kinds[1]).toBe("broll");
    const broll = brief.beats[1];
    expect(broll.kind === "broll" && broll.videoPrompt).toBe("slow dolly past cars at golden hour");
    expect(broll.kind === "broll" && broll.video).toBeUndefined();
  });

  it("no broll_prompt → no broll beat (no fabrication)", () => {
    expect(intakeToVideoBrief(upcar).beats.map((b) => b.kind)).not.toContain("broll");
  });

  it("authored broll scene carries its video_prompt at the authored position", () => {
    const brief = intakeToVideoBrief({
      ...upcar,
      scenes: [{ kind: "hook" }, { kind: "broll", video_prompt: "aerial over a city" }, { kind: "cta" }],
    });
    const kinds = brief.beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "broll", "cta"]);
    expect(brief.beats[1].kind === "broll" && brief.beats[1].videoPrompt).toBe("aerial over a city");
  });

  it("schema accepts broll_prompt + an authored broll scene", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, broll_prompt: "x" }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, scenes: [{ kind: "broll", video_prompt: "y" }, { kind: "cta" }] }).success).toBe(true);
  });
});

describe("intakeToVideoBrief — authored scenes[] (Phase 2)", () => {
  const richBase: LaunchVideoIntake = {
    ...upcar,
    problem: "Renting a car still means a counter, a line, and a markup.",
    product_surface: {
      header: { title: "Cars near you" },
      items: [{ glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] }],
    },
    coverage: { regions: ["California", "Nevada", "Texas"] },
    metrics: [{ stat: "600+", label: "active hosts" }],
  };

  it("renders authored scenes in THE EXACT authored order (overrides the shape arc)", () => {
    const intake: LaunchVideoIntake = {
      ...richBase,
      product_shape: "marketplace",
      scenes: [
        { kind: "hook" },
        { kind: "metric" },
        { kind: "cardwall" },
        { kind: "productui" },
        { kind: "cta" },
      ],
    };
    const kinds = intakeToVideoBrief(intake).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "metric", "cardwall", "productui", "cta"]);
    expect(kinds).not.toEqual(["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"]);
  });

  it("a scene's OWN authored content + vo wins over the intake fields", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      scenes: [
        { kind: "hook", headline: "There's a car parked near you.", vo: "We built Upcar so you never drive to a counter." },
        {
          kind: "cardwall",
          headline: "Closer. Local. Covered.",
          cards: [{ title: "A car nearby", detail: "Parked on your street." }],
          vo: "Three reasons it works.",
        },
        { kind: "cta", headline: "Find a car near you", chips: ["LIVE NOW"] },
      ],
    };
    const brief = intakeToVideoBrief(intake);
    const hook = brief.beats[0];
    expect(hook.kind === "hook" && hook.headline).toBe("There's a car parked near you.");
    expect(hook.vo?.srtText).toBe("We built Upcar so you never drive to a counter.");
    const wall = brief.beats[1];
    expect(wall.kind === "cardwall" && wall.headline).toBe("Closer. Local. Covered.");
    if (wall.kind === "cardwall") expect(wall.cards[0]).toMatchObject({ headline: "A car nearby", body: "Parked on your street." });
    const cta = brief.beats[2];
    expect(cta.kind === "cta" && cta.chips).toEqual(["LIVE NOW"]);
  });

  it("a {kind}-only authored scene fills from the matching intake field", () => {
    const intake: LaunchVideoIntake = { ...richBase, scenes: [{ kind: "hook" }, { kind: "coverage" }, { kind: "cta" }] };
    const brief = intakeToVideoBrief(intake);
    const cov = brief.beats.find((b) => b.kind === "coverage");
    expect(cov?.kind).toBe("coverage");
    if (cov && cov.kind === "coverage") expect(cov.regions).toEqual(["California", "Nevada", "Texas"]);
  });

  it("an un-renderable authored scene is SKIPPED (no empty productui/coverage/metric reaches the engine)", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      scenes: [{ kind: "hook" }, { kind: "productui" }, { kind: "coverage" }, { kind: "metric" }, { kind: "cardwall" }, { kind: "cta" }],
    };
    const kinds = intakeToVideoBrief(intake).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "cta"]);
  });

  it("THIN authored input (nothing renderable) → falls back to the shape arc", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      product_shape: "dtc",
      scenes: [{ kind: "coverage" }, { kind: "metric" }],
    };
    const kinds = intakeToVideoBrief(intake).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "cta"]);
  });

  it("authored productui from SaaS data renders dashboard rows (product-agnostic)", () => {
    const intake: LaunchVideoIntake = {
      ...saas,
      scenes: [
        { kind: "hook" },
        {
          kind: "productui",
          header: { title: "Your dashboard" },
          items: [{ glyph: "chart", title: "Monthly revenue", chips: ["$12.4k MRR", "↑ 12%"] }],
        },
        { kind: "cta" },
      ],
    };
    const pui = intakeToVideoBrief(intake).beats.find((b) => b.kind === "productui");
    if (pui && pui.kind === "productui") {
      expect(pui.items[0].title).toBe("Monthly revenue");
      expect(pui.items[0].glyph).toBe("chart");
    }
  });

  it("authored scenes stay product-neutral + em-dash-free (guards hold)", () => {
    const intake: LaunchVideoIntake = {
      ...richBase,
      scenes: [
        { kind: "hook", headline: "A car nearby — rent it.", vo: "We built this — for you." },
        { kind: "cardwall" },
        { kind: "cta" },
      ],
    };
    const text = briefText(intakeToVideoBrief(intake));
    for (const term of BANNED) expect(text.includes(term)).toBe(false);
    expect(text.includes("@")).toBe(false);
    expect(text.includes("—"), "authored scene leaked an em-dash").toBe(false);
  });

  it("schema accepts a valid scenes[] and rejects a bad scene kind / over-long list", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, scenes: [{ kind: "hook" }, { kind: "cta" }] }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, scenes: [{ kind: "banner" }] }).success).toBe(false);
    const twentyFour = Array.from({ length: 24 }, () => ({ kind: "hook" as const }));
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, scenes: twentyFour }).success).toBe(true);
    const twentyFive = Array.from({ length: 25 }, () => ({ kind: "hook" as const }));
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, scenes: twentyFive }).success).toBe(false);
    expect(launchVideoIntakeSchema.safeParse(upcar).success).toBe(true);
  });
});

describe("em-dash guard — no em-dash reaches any rendered string (on-screen + VO)", () => {
  it("stripDashes replaces em-dash / horizontal-bar with a comma and tidies spacing", () => {
    expect(stripDashes("booking a place to stay — so we built that")).toBe(
      "booking a place to stay, so we built that",
    );
    expect(stripDashes("Found it — a null guard was missing.")).toBe("Found it, a null guard was missing.");
    expect(stripDashes("routes — grounded in data")).toBe("routes, grounded in data");
    expect(stripDashes("$3-10/day")).toBe("$3-10/day");
    expect(stripDashes("9–5 weekdays")).toBe("9–5 weekdays");
  });

  it("sanitizeBrief deep-strips em-dashes from every string but leaves other content intact", () => {
    const dirty = { a: "x — y", b: ["p — q", { c: "r — s" }], n: 3, u: "https://up.ai" };
    expect(sanitizeBrief(dirty)).toEqual({ a: "x, y", b: ["p, q", { c: "r, s" }], n: 3, u: "https://up.ai" });
  });

  it("the mapper output (every product shape) contains ZERO em-dashes — even when the intake is full of them", () => {
    const dashy: LaunchVideoIntake = {
      ...upcar,
      one_liner: "Rent a car — from a local host.",
      problem: "Renting a car still means a counter — and a line — and a markup.",
      features: [
        { title: "Book fast — really fast", detail: "Reserve in two minutes — no counter.", meta: "30s — avg" },
        { title: "Real hosts — local", detail: "Owned by people — in your city." },
      ],
      product_surface: {
        header: { title: "Cars near you — today", search_placeholder: "Search — by city" },
        items: [{ glyph: "car", title: "Tesla — Model 3", chips: ["$61/day — incl. fees", "Austin TX"] }],
      },
      coverage: { headline: "Live in 5 states — and growing.", regions: ["California — CA", "Nevada"] },
      narration: { hook: "There's a car nearby — rent it.", cta: "Upcar is live — find a car." },
      metrics: [{ stat: "600+", label: "active hosts — earning" }],
      cta_text: "Find a car — near you",
    };
    const blob = briefText(intakeToVideoBrief(dashy));
    expect(blob.includes("—"), "mapper leaked an em-dash into a rendered string").toBe(false);
    expect(blob).toContain("rent a car, from a local host");
  });

  it("none of the canonical fixtures emit an em-dash (regression net for the example briefs)", () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const blob = briefText(intakeToVideoBrief(fx));
      expect(blob.includes("—"), `${name} emitted an em-dash`).toBe(false);
    }
  });

  it("the SaaS shape still renders correctly from data after sanitize (no over-stripping)", () => {
    const saasSurface = intakeToVideoBrief({
      ...saas,
      product_surface: {
        header: { title: "Your dashboard" },
        items: [{ glyph: "chart", title: "Monthly revenue", chips: ["$12.4k MRR", "↑ 12%"] }],
      },
      metrics: [{ stat: "$12.4k", label: "MRR" }],
    });
    const kinds = saasSurface.beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "productui", "cardwall", "metric", "cta"]);
    const pui = saasSurface.beats.find((b) => b.kind === "productui");
    if (pui && pui.kind === "productui") {
      expect(pui.items[0]).toEqual({ glyph: "chart", title: "Monthly revenue", chips: ["$12.4k MRR", "↑ 12%"] });
    }
    expect(briefText(saasSurface).includes("—")).toBe(false);
  });
});

describe("video_type engine — profile table + arc selection", () => {
  const richBase: LaunchVideoIntake = {
    ...upcar,
    problem: "Renting a car still means a counter, a line, and a markup.",
    product_surface: {
      header: { title: "Cars near you" },
      items: [{ glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "4.9★", "Austin TX"] }],
    },
    coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
    metrics: [{ stat: "600+", label: "active hosts" }],
  };

  it("the profile table covers all 5 video types; each arc is a subset of its scenePalette", () => {
    for (const t of VIDEO_TYPE_VALUES) {
      const p = VIDEO_TYPE_PROFILES[t];
      expect(p, `missing profile for ${t}`).toBeTruthy();
      expect(typeof p.scriptObjective).toBe("string");
      expect(p.scriptObjective.length).toBeGreaterThan(0);
      expect(typeof p.ctaStyle).toBe("string");
      expect(p.pacingScalar).toBeGreaterThan(0);
      expect(p.lengthTargetSec).toBeGreaterThan(0);
      if (p.arc) for (const slot of p.arc) expect(p.scenePalette, `${t}: arc slot ${slot} not in palette`).toContain(slot);
    }
    expect(VIDEO_TYPE_PROFILES.launch.arc).toBeNull();
    expect(VIDEO_TYPE_PROFILES.launch.pacingScalar).toBe(1);
  });

  it("video_type omitted === 'launch' — output is BYTE-IDENTICAL (rich + thin)", () => {
    const omitted = intakeToVideoBrief(richBase);
    const explicit = intakeToVideoBrief({ ...richBase, video_type: "launch" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
    const thinOmit = intakeToVideoBrief(upcar);
    const thinLaunch = intakeToVideoBrief({ ...upcar, video_type: "launch" });
    expect(JSON.stringify(thinLaunch)).toBe(JSON.stringify(thinOmit));
  });

  it("launch path leaves durationFrames UNSET on every beat (byte-identical pacing)", () => {
    for (const b of intakeToVideoBrief({ ...richBase, video_type: "launch" }).beats) {
      expect((b as { durationFrames?: number }).durationFrames).toBeUndefined();
    }
  });

  it("'ad' → hook→value→proof→cta arc (hook, cardwall, metric, cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, video_type: "ad" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "metric", "cta"]);
  });

  it("'explainer' → problem→how-it-works→features→cta arc (problem, productui, cardwall, cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, video_type: "explainer" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["problem", "productui", "cardwall", "cta"]);
  });

  it("'social' → hook→one-point→cta arc (hook, cardwall, cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, video_type: "social" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "cta"]);
  });

  it("'story' → hook→problem→journey→outcome→cta arc (hook, problem, productui, metric, cta)", () => {
    const kinds = intakeToVideoBrief({ ...richBase, video_type: "story" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "problem", "productui", "metric", "cta"]);
  });

  it("a non-launch type's arc WINS over the product_shape arc", () => {
    const kinds = intakeToVideoBrief({ ...richBase, product_shape: "marketplace", video_type: "ad" }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "cardwall", "metric", "cta"]);
  });

  it("an LLM-authored scenes[] still overrides the video_type arc (most specific intent wins)", () => {
    const kinds = intakeToVideoBrief({
      ...richBase,
      video_type: "ad",
      scenes: [{ kind: "hook" }, { kind: "coverage" }, { kind: "cta" }],
    }).beats.map((b) => b.kind);
    expect(kinds).toEqual(["hook", "coverage", "cta"]);
  });

  it("a non-launch type stamps an explicit durationFrames (= floor × pacingScalar) on every beat", () => {
    const beats = intakeToVideoBrief({ ...richBase, video_type: "ad" }).beats;
    for (const b of beats) {
      const df = (b as { durationFrames?: number }).durationFrames;
      expect(df, "ad beat should have an explicit durationFrames").toBeGreaterThan(0);
    }
    const hook = beats.find((b) => b.kind === "hook") as { durationFrames?: number };
    expect(hook.durationFrames).toBe(Math.round(120 * 0.7));
  });

  it("a non-launch type stays product-neutral + em-dash-free (guards still hold)", () => {
    for (const t of ["ad", "explainer", "social", "story"] as const) {
      const text = briefText(intakeToVideoBrief({ ...richBase, video_type: t }));
      for (const term of BANNED) expect(text.includes(term), `${t}: injected "${term}"`).toBe(false);
      expect(text.includes("@"), `${t}: injected @mention`).toBe(false);
      expect(text.includes("—"), `${t}: leaked em-dash`).toBe(false);
    }
  });

  it("schema accepts a valid video_type, rejects an invalid one, and omitted is fine", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, video_type: "ad" }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, video_type: "explainer" }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, video_type: "documentary" }).success).toBe(false);
    expect(launchVideoIntakeSchema.safeParse(upcar).success).toBe(true);
  });
});

describe("video_type engine — per-tenant brand kit", () => {
  it("no brand kit → DEFAULT_BRAND (no logoUrl key)", () => {
    const brand = intakeToVideoBrief(upcar).brand;
    expect(brand).toEqual({ primaryColor: "#5B6CFF", accentColor: "#22D3EE", bgColor: "#0B0E14" });
    expect("logoUrl" in brand).toBe(false);
  });

  it("a supplied brand kit overrides colors + carries the logo (voiceId is NOT in the brief)", () => {
    const brief = intakeToVideoBrief(upcar, {
      brandKit: {
        colors: { primary: "#123456", accent: "#abcdef", bg: "#000000" },
        logoUrl: "https://cdn.example.com/logo.png",
        voiceId: "voice-123",
      },
    });
    expect(brief.brand).toEqual({
      primaryColor: "#123456",
      accentColor: "#abcdef",
      bgColor: "#000000",
      logoUrl: "https://cdn.example.com/logo.png",
    });
    expect(JSON.stringify(brief)).not.toContain("voice-123");
  });

  it("an invalid (non-hex) color falls back to the DEFAULT for that slot; valid slots still apply", () => {
    const brief = intakeToVideoBrief(upcar, { brandKit: { colors: { primary: "red", accent: "#00FF00" } } });
    expect(brief.brand.primaryColor).toBe("#5B6CFF");
    expect(brief.brand.accentColor).toBe("#00FF00");
    expect(brief.brand.bgColor).toBe("#0B0E14");
  });

  it("a partial brand kit (logo only) keeps default colors and adds the logo", () => {
    const brief = intakeToVideoBrief(upcar, { brandKit: { logoUrl: "https://x/l.png" } });
    expect(brief.brand).toEqual({
      primaryColor: "#5B6CFF",
      accentColor: "#22D3EE",
      bgColor: "#0B0E14",
      logoUrl: "https://x/l.png",
    });
  });

  it("brand kit applies to a non-launch type too", () => {
    const brief = intakeToVideoBrief({ ...upcar, video_type: "ad" }, { brandKit: { colors: { primary: "#111111" } } });
    expect(brief.brand.primaryColor).toBe("#111111");
  });
});

describe("intakeToVideoBrief — user-intent (Phase P1)", () => {
  const richBase: LaunchVideoIntake = {
    ...upcar,
    problem: "Renting a car still means a counter, a line, and a markup.",
    product_surface: {
      header: { title: "Cars near you" },
      items: [
        { glyph: "car", title: "Tesla Model 3", chips: ["$61/day", "Austin TX"] },
        { glyph: "car", title: "Budget sedan", chips: ["$29/day", "Reno NV"] },
      ],
    },
    coverage: { headline: "Live in 5 states.", regions: ["California", "Nevada", "Texas", "Arizona", "Florida"] },
    metrics: [
      { stat: "600+", label: "active hosts" },
      { stat: "$1.2M", label: "monthly GMV" },
    ],
  };

  it("aspectForPlatform maps each platform to its native aspect", () => {
    expect(aspectForPlatform("tiktok")).toBe("9:16");
    expect(aspectForPlatform("instagram")).toBe("9:16");
    expect(aspectForPlatform("instagram_reels")).toBe("9:16");
    expect(aspectForPlatform("youtube_shorts")).toBe("9:16");
    expect(aspectForPlatform("instagram_feed")).toBe("1:1");
    expect(aspectForPlatform("youtube")).toBe("16:9");
    expect(aspectForPlatform("linkedin")).toBe("16:9");
    expect(aspectForPlatform("web")).toBe("16:9");
    expect(aspectForPlatform("x")).toBe("16:9");
    expect(aspectForPlatform(undefined)).toBe("16:9");
  });

  it("platform sets the brief's primary aspect; omitted → 16:9 (launch default)", () => {
    expect(intakeToVideoBrief({ ...upcar, platform: "tiktok" }).aspect).toBe("9:16");
    expect(intakeToVideoBrief({ ...upcar, platform: "instagram_feed" }).aspect).toBe("1:1");
    expect(intakeToVideoBrief({ ...upcar, platform: "linkedin" }).aspect).toBe("16:9");
    expect(intakeToVideoBrief(upcar).aspect).toBe("16:9");
  });

  it("schema accepts platform + length_seconds + aspects, rejects bad values", () => {
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, platform: "tiktok", length_seconds: 15 }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, platform: "myspace" }).success).toBe(false);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, length_seconds: 3 }).success).toBe(false);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, aspects: ["9:16", "16:9"] }).success).toBe(true);
    expect(launchVideoIntakeSchema.safeParse({ ...upcar, aspects: ["4:3"] }).success).toBe(false);
  });

  it("highlight pulls a matching feature into the shown 3 (stable reorder, no fabrication)", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      features: [
        { title: "Slow boring thing", detail: "d1" },
        { title: "Another filler", detail: "d2" },
        { title: "Yet more filler", detail: "d3" },
        { title: "Instant booking magic", detail: "Book in two minutes." },
      ],
      highlight: ["instant booking"],
    };
    const wall = intakeToVideoBrief(intake).beats.find((b) => b.kind === "cardwall");
    if (wall && wall.kind === "cardwall") {
      expect(wall.cards[0].headline).toBe("Instant booking magic");
      expect(wall.cards).toHaveLength(3);
    }
  });

  it("de_emphasize sinks a feature out of the shown 3", () => {
    const intake: LaunchVideoIntake = {
      ...upcar,
      features: [
        { title: "Enterprise SSO", detail: "d1" },
        { title: "Keeper one", detail: "d2" },
        { title: "Keeper two", detail: "d3" },
        { title: "Keeper three", detail: "d4" },
      ],
      de_emphasize: ["enterprise sso"],
    };
    const wall = intakeToVideoBrief(intake).beats.find((b) => b.kind === "cardwall");
    if (wall && wall.kind === "cardwall") {
      expect(wall.cards.map((c) => c.headline)).not.toContain("Enterprise SSO");
      expect(wall.cards).toHaveLength(3);
    }
  });

  it("NO highlight/de_emphasize → feature order byte-identical (back-compat)", () => {
    const withEmpty = intakeToVideoBrief(richBase);
    const plain = intakeToVideoBrief(richBase);
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(plain));
  });

  it("avoid HARD-EXCLUDES a feature, a region, a metric, a product item, and a chip", () => {
    const intake: LaunchVideoIntake = {
      ...richBase,
      avoid: ["gmv", "nevada", "reno", "budget sedan"],
    };
    const brief = intakeToVideoBrief(intake);
    const blob = briefText(brief).toLowerCase();
    for (const term of ["gmv", "nevada", "reno", "budget sedan"]) {
      expect(blob.includes(term.toLowerCase()), `avoided term "${term}" survived`).toBe(false);
    }
    expect(blob).toContain("california");
    expect(blob).toContain("tesla model 3");
    const metric = brief.beats.find((b) => b.kind === "metric");
    if (metric && metric.kind === "metric") {
      expect(metric.metrics?.some((m) => m.label.includes("GMV"))).toBe(false);
      expect(metric.metrics?.some((m) => m.label.includes("active hosts"))).toBe(true);
    }
  });

  it("avoid drops a whole conditional beat when all its content matches (coverage fully avoided)", () => {
    const intake: LaunchVideoIntake = {
      ...richBase,
      product_shape: "marketplace",
      avoid: ["california", "nevada", "texas", "arizona", "florida"],
    };
    const kinds = intakeToVideoBrief(intake).beats.map((b) => b.kind);
    expect(kinds).not.toContain("coverage");
    const cta = intakeToVideoBrief(intake).beats.at(-1);
    if (cta && cta.kind === "cta") for (const c of cta.chips ?? []) expect(c).not.toContain("MARKETS");
  });

  it("avoid never leaks into the derived VO/caption line either", () => {
    const intake: LaunchVideoIntake = { ...richBase, avoid: ["gmv"] };
    for (const b of intakeToVideoBrief(intake).beats) {
      expect((b.vo?.srtText ?? "").toLowerCase().includes("gmv")).toBe(false);
    }
  });

  it("NO avoid list → byte-identical output (back-compat)", () => {
    const withAbsent = intakeToVideoBrief({ ...richBase, avoid: undefined });
    const plain = intakeToVideoBrief(richBase);
    expect(JSON.stringify(withAbsent)).toBe(JSON.stringify(plain));
  });

  it("length_seconds tightens a NON-launch type's pacing (shorter target → smaller durationFrames)", () => {
    const adDefault = intakeToVideoBrief({ ...richBase, video_type: "ad" });
    const adShort = intakeToVideoBrief({ ...richBase, video_type: "ad", length_seconds: 11 });
    const hookDefault = adDefault.beats.find((b) => b.kind === "hook") as { durationFrames?: number };
    const hookShort = adShort.beats.find((b) => b.kind === "hook") as { durationFrames?: number };
    expect(hookShort.durationFrames!).toBeLessThan(hookDefault.durationFrames!);
  });

  it("length_seconds does NOT affect the launch path (stays byte-identical, no durationFrames)", () => {
    const a = intakeToVideoBrief({ ...richBase, length_seconds: 30 });
    const b = intakeToVideoBrief(richBase);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const beat of a.beats) expect((beat as { durationFrames?: number }).durationFrames).toBeUndefined();
  });
});
