import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chooseTemplate,
  extractFilmFacts,
  ungroundedNumbers,
  validateFilmFacts,
  STATION_KINDS,
  IN_USE_BLOCKS,
} from "../film-facts";
import { IN_USE_TYPE, JOURNEY_TYPE } from "../film-facts-schemas";

const PKG = join(__dirname, "../../../../../../packages/launch-video");
const load = (f: string) => JSON.parse(readFileSync(join(PKG, "examples", f), "utf8"));
const everything = (v: unknown) => JSON.stringify(v);

describe("the prompt's copy of the film types matches the engine package", () => {
  it("is regenerated, not hand-edited", () => {
    const plan = readFileSync(join(PKG, "src/themes/in-use/plan.ts"), "utf8");
    const types = readFileSync(join(PKG, "src/themes/journey/types.ts"), "utf8");
    const inUse = plan.slice(plan.indexOf("export type InUseCard"), plan.indexOf("/** The minimum the film needs")).trimEnd() + "\n";
    const journey = types.slice(types.indexOf("export type Station ="), types.indexOf("export type StationKind")).trimEnd() + "\n";
    if (process.env.UPDATE_FILM_SCHEMAS === "1") {
      const file = join(__dirname, "../film-facts-schemas.ts");
      const src = readFileSync(file, "utf8");
      const head = src.slice(0, src.indexOf("export const IN_USE_TYPE"));
      writeFileSync(file, `${head}export const IN_USE_TYPE = ${JSON.stringify(inUse)};\n\nexport const JOURNEY_TYPE = ${JSON.stringify(journey)};\n`);
      return;
    }
    expect(IN_USE_TYPE).toBe(inUse);
    expect(JOURNEY_TYPE).toBe(journey);
  });

  it("validates every station kind the film draws, and every IN USE block", () => {
    const kinds = [...JOURNEY_TYPE.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]).sort();
    expect([...STATION_KINDS].sort()).toEqual(kinds);
    for (const k of Object.keys(IN_USE_BLOCKS)) expect(IN_USE_TYPE).toMatch(new RegExp(`\\b${k}\\?:`));
  });
});

describe("validateFilmFacts keeps well-formed, grounded content", () => {
  it("keeps every block of the worked examples", () => {
    for (const [d, e] of [
      ["bakeoff-d-apna.json", "bakeoff-e-apna.json"],
      ["bakeoff-d-fixture.json", "bakeoff-e-fixture.json"],
    ] as const) {
      const inUse = load(d).in_use;
      const journey = load(e).journey;
      const out = validateFilmFacts({ in_use: inUse, journey }, everything({ inUse, journey }));
      const inUseDrops = out.dropped.filter((x) => x.startsWith("in_use"));
      expect(inUseDrops).toEqual([]);
      for (const k of Object.keys(inUse)) if (k !== "brand") expect(out.in_use).toHaveProperty(k);
      if (journey) expect(out.journey).toHaveLength(journey.length);
    }
  });

  it("drops a block carrying a number the site never states, and only that block", () => {
    const inUse = load("bakeoff-d-apna.json").in_use;
    const source = everything(inUse);
    const out = validateFilmFacts(
      { in_use: { ...inUse, anchor: { ...inUse.anchor, us: { value: "$3", label: "per session" } } } },
      source,
    );
    expect(out.in_use).not.toHaveProperty("anchor");
    expect(out.in_use).toHaveProperty("find");
    expect(out.dropped.join(" ")).toMatch(/anchor \(numbers not on the site: \$3\)/);
  });

  it("drops the whole IN USE block when a required part is malformed", () => {
    const inUse = load("bakeoff-d-apna.json").in_use;
    const out = validateFilmFacts({ in_use: { ...inUse, steps: [] } }, everything(inUse));
    expect(out.in_use).toBeUndefined();
  });

  it("drops a malformed station and a journey without its open and close", () => {
    const j = load("bakeoff-e-apna.json").journey;
    const src = everything(j);
    const bad = validateFilmFacts({ journey: [...j.slice(0, 3), { kind: "wall", title: "x", items: ["a"], countLabel: "y" }, ...j.slice(3)] }, src);
    expect(bad.journey).toHaveLength(j.length);
    expect(bad.dropped).toContain("journey[3] (shape)");
    expect(validateFilmFacts({ journey: j.slice(0, -1) }, src).journey).toBeUndefined();
  });

  it("does not treat a list index as a claim", () => {
    expect(ungroundedNumbers({ a: "From $5" }, "from $5 a session")).toEqual([]);
    expect(ungroundedNumbers({ a: "1,200 users" }, "over 1200 users")).toEqual([]);
    expect(ungroundedNumbers({ a: "4.9 stars" }, "rated by parents")).toEqual(["4.9"]);
  });
});

describe("chooseTemplate", () => {
  it("picks IN USE when the site supports a full usage flow", () => {
    expect(chooseTemplate({ in_use: load("bakeoff-d-apna.json").in_use, journey: load("bakeoff-e-apna.json").journey })).toBe("in_use");
  });
  it("picks the journey when there is no usage flow to draw", () => {
    const thin = { hook: { headline: "h" }, steps: [{ title: "a", detail: "b" }, { title: "c", detail: "d" }], close: { headline: "x", cta: "y", url: "z" } };
    expect(chooseTemplate({ in_use: thin, journey: load("bakeoff-e-apna.json").journey })).toBe("journey");
  });
  it("picks IN USE when neither block came back (it stretches a thin plan best)", () => {
    expect(chooseTemplate({})).toBe("in_use");
  });
});

describe("extractFilmFacts", () => {
  const pages = async () =>
    ({ ok: true as const, finalUrl: new URL("https://acme.test/"), pages: [{ url: "https://acme.test/", title: "Acme", text: "Acme plans start at $9 a month." }] });

  it("never throws: a dead site, a bad reply and a throwing model all come back as reasons", async () => {
    const dead = await extractFilmFacts({ url: "https://x.test", intake: {}, readPages: async () => ({ ok: false, reason: "unreachable" }) });
    expect(dead).toEqual({ dropped: ["site unreachable"] });
    const prose = await extractFilmFacts({ url: "https://x.test", intake: {}, readPages: pages, complete: async () => "sorry" });
    expect(prose.dropped).toEqual(["unparseable reply"]);
    const boom = await extractFilmFacts({ url: "https://x.test", intake: {}, readPages: pages, complete: async () => { throw new Error("529"); } });
    expect(boom.dropped[0]).toMatch(/error: 529/);
  });

  it("grounds against the site AND the intake, and sends both as data", async () => {
    let user = "";
    const reply = {
      journey: [
        { kind: "title", kicker: "Acme", headline: "Plans from $9" },
        { kind: "numeral", label: "Teams", value: "40", unit: "seats" },
        { kind: "cta", headline: "Start", button: "Start", url: "acme.test" },
      ],
    };
    const out = await extractFilmFacts({
      url: "https://acme.test",
      intake: { product_name: "Acme", one_liner: "Up to 40 seats" },
      readPages: pages,
      complete: async (_s, u) => {
        user = u;
        return "```json\n" + JSON.stringify(reply) + "\n```";
      },
    });
    expect(user).toContain("<page url=");
    expect(user).toContain("<intake>");
    expect(out.journey?.map((s) => s.kind)).toEqual(["title", "numeral", "cta"]);
  });
});

describe("counting a list is not an invented number", () => {
  it("lets a block state the length of a list it carries, and nothing else", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    expect(ungroundedNumbers({ countLabel: "7 subjects", items }, "")).toEqual([]);
    expect(ungroundedNumbers({ countLabel: "8 subjects", items }, "")).toEqual(["8"]);
    expect(ungroundedNumbers({ countLabel: "$7", items }, "")).toEqual(["$7"]);
  });
});

describe("the accent comes from the site's own colours", () => {
  const inUse = { hook: { headline: "h" }, steps: [{ title: "a", detail: "b" }, { title: "c", detail: "d" }], close: { headline: "x", cta: "y", url: "z" } };
  const colours = [{ hex: "#FE4D93", count: 3 }, { hex: "#25D366", count: 2 }];

  it("keeps a pick that is on the list, and gives IN USE an ink dark enough for small type", () => {
    const out = validateFilmFacts({ in_use: inUse, brand: { accent: "#fe4d93" } }, "", colours);
    expect(out.brand?.accent).toBe("#FE4D93");
    expect(out.in_use?.brand).toEqual({ accent: "#FE4D93", accent_ink: out.brand?.accent_ink });
    expect(out.brand?.accent_ink).not.toBe("#FE4D93");
  });

  it("refuses a colour the site does not use, and falls back to the site's own", () => {
    const out = validateFilmFacts({ brand: { accent: "#123456" } }, "", colours);
    expect(out.brand?.accent).toBe("#FE4D93");
    expect(out.dropped.join(" ")).toMatch(/not one of the site's colours/);
    expect(validateFilmFacts({}, "", [{ hex: "#25D366", count: 9 }, { hex: "#0055FF", count: 1, meta: true }]).brand?.accent).toBe("#0055FF");
    expect(validateFilmFacts({}, "", []).brand).toBeUndefined();
  });

  it("clamps a listing pick instead of throwing the listings away", () => {
    const inUse2 = { ...inUse, results: { title: "t", noun: "n", action: "a", pick: 3, cards: [{ title: "c", sub: "s", tags: [], rows: [] }] } };
    expect((validateFilmFacts({ in_use: inUse2 }, "", []).in_use?.results as { pick: number }).pick).toBe(0);
  });

  it("does not let a price ground a bare number", () => {
    expect(ungroundedNumbers({ a: "5 years experience" }, "From $5 a session")).toEqual(["5"]);
  });
});

describe("figure fields hold figures", () => {
  it("drops a giant-numeral or versus station whose figure is a phrase", () => {
    const j = [
      { kind: "title", kicker: "k", headline: "h" },
      { kind: "numeral", label: "Rated", value: "Highly-rated" },
      { kind: "versus", title: "t", left: { label: "a", value: "Feeding, water, potty breaks" }, right: { label: "b", value: "$25" } },
      { kind: "numeral", label: "Reviews", value: "35,000+" },
      { kind: "cta", headline: "c", button: "b", url: "u" },
    ];
    const out = validateFilmFacts({ journey: j }, "35,000 reviews $25");
    expect(out.journey?.map((x) => x.kind)).toEqual(["title", "numeral", "cta"]);
  });
});

describe("Codex review fixes", () => {
  it("binds a count to a list beside it, not to any list in the block (F4)", () => {
    expect(ungroundedNumbers({ kind: "numeral", label: "Experts", value: "3 certified experts", notes: ["a", "b", "c"] }, "")).toEqual(["3"]);
    expect(ungroundedNumbers({ title: "3 steps", steps: [{}, {}, {}] }, "")).toEqual([]);
    expect(ungroundedNumbers({ title: "2 steps", steps: [{}, {}] }, "")).toEqual([]);
  });

  it("drops a station whose copy breaks the public lint, and turns em dashes into en dashes (F2)", () => {
    const j = [
      { kind: "title", kicker: "k", headline: "Fast — and simple" },
      { kind: "chat", title: "t", from: "f", message: "Guaranteed results for every family", checks: [] },
      { kind: "chat", title: "t", from: "f", message: "Mentions Acme", checks: [] },
      { kind: "cta", headline: "c", button: "b", url: "u" },
    ];
    const out = validateFilmFacts({ journey: j }, "", [], { avoid: ["acme"] });
    expect(out.journey?.map((x) => x.kind)).toEqual(["title", "cta"]);
    expect((out.journey?.[0] as { headline: string }).headline).toBe("Fast – and simple");
    expect(out.dropped.join(" ")).toMatch(/superlative/);
    expect(out.dropped.join(" ")).toMatch(/avoid_violation/);
  });
});

describe("journey variety", () => {
  it("keeps at most two stations of one kind", () => {
    const wall = (t: string) => ({ kind: "wall", title: t, items: ["a", "b", "c", "d", "e", "f"], countLabel: "things" });
    const j = [{ kind: "title", kicker: "k", headline: "h" }, wall("one"), wall("two"), wall("three"), { kind: "cta", headline: "c", button: "b", url: "u" }];
    const out = validateFilmFacts({ journey: j }, "");
    expect(out.journey?.map((x) => (x as { title?: string }).title ?? x.kind)).toEqual(["title", "one", "two", "cta"]);
  });
});

describe("a count must name its list (final review F1)", () => {
  it("grounds '2 steps' beside steps, never '2x faster' beside an unrelated pair", () => {
    expect(ungroundedNumbers({ kind: "options", title: "2x faster", items: ["Slack", "Teams"], caption: "c" }, "")).toEqual(["2"]);
    expect(ungroundedNumbers({ title: "2 integrations", items: ["Slack", "Teams"] }, "")).toEqual(["2"]);
    expect(ungroundedNumbers({ title: "2 steps", steps: [{}, {}] }, "")).toEqual([]);
    expect(ungroundedNumbers({ countLabel: "6 subjects", items: ["a", "b", "c", "d", "e", "f"] }, "")).toEqual([]);
  });
});
