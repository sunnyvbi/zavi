import { describe, it, expect } from "vitest";
import {
  extractJsonObject,
  parseAuthoredIntake,
  parseModerationVerdict,
  authorIntake,
  moderateForm,
  type PublicLaunchVideoForm,
  type Completer,
} from "../authoring";

const VALID_INTAKE = {
  product_name: "Acme",
  one_liner: "Ship faster than ever",
  url: "https://acme.com",
  audience: "founders and marketplace operators",
  tone: "clean",
  features: [{ title: "Fast builds", detail: "Builds finish in seconds, not minutes" }],
  cta_text: "Try it free",
  cta_url: "https://acme.com/start",
};

const FORM: PublicLaunchVideoForm = {
  product_name: "Acme",
  one_liner: "Ship faster",
  features: "Fast builds\nNo config",
  audience: "founders",
  tone: "clean",
  theme: "swiss",
  problem: "",
  metrics: "",
  regions: "",
  screen: "",
  cta_text: "Try it",
  cta_url: "https://acme.com",
};

describe("extractJsonObject", () => {
  it("pulls JSON from a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("pulls a bare object", () => {
    expect(extractJsonObject('noise {"a":2} tail')).toEqual({ a: 2 });
  });
  it("returns null on no/!invalid json", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("```json\n{bad}\n```")).toBeNull();
  });
});

describe("parseAuthoredIntake", () => {
  it("accepts a schema-valid intake", () => {
    const r = parseAuthoredIntake("```json\n" + JSON.stringify(VALID_INTAKE) + "\n```");
    expect(r.ok).toBe(true);
  });
  it("fails closed on no json", () => {
    expect(parseAuthoredIntake("sorry, I can't")).toEqual({ ok: false, error: "author_no_json" });
  });
  it("fails closed + names the bad field on schema miss", () => {
    const bad = { ...VALID_INTAKE, tone: "sarcastic" };
    const r = parseAuthoredIntake(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^author_schema:tone/);
  });
});

describe("parseModerationVerdict — fail closed", () => {
  it("allows on explicit allowed:true", () => {
    expect(parseModerationVerdict('{"allowed":true,"reason":"ok"}')).toEqual({ allowed: true, reason: "ok" });
  });
  it("blocks on allowed:false", () => {
    expect(parseModerationVerdict('{"allowed":false,"reason":"hate"}')).toMatchObject({ allowed: false });
  });
  it("blocks on unparseable output", () => {
    expect(parseModerationVerdict("hmm maybe")).toEqual({ allowed: false, reason: "moderation_unparseable" });
  });
});

describe("authorIntake / moderateForm with injected LLM", () => {
  it("authorIntake returns ok on a good completion", async () => {
    const complete: Completer = async () => "```json\n" + JSON.stringify(VALID_INTAKE) + "\n```";
    const r = await authorIntake(FORM, { complete });
    expect(r.ok).toBe(true);
  });
  it("authorIntake fails closed when the model errors", async () => {
    const complete: Completer = async () => {
      throw new Error("overloaded");
    };
    const r = await authorIntake(FORM, { complete });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^author_llm_error/);
  });
  it("moderateForm blocks when the model errors (fail closed)", async () => {
    const complete: Completer = async () => {
      throw new Error("down");
    };
    expect(await moderateForm(FORM, { complete })).toEqual({ allowed: false, reason: "moderation_llm_error" });
  });
});
