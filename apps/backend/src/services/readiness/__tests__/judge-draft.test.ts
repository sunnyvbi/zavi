import { describe, it, expect } from "vitest";
import {
  parseJudgeVerdict,
  judgeDraftWith,
  buildJudgePrompt,
  type DraftToJudge,
  type JudgeFn,
} from "../judge-draft";

const draft = (over: Partial<DraftToJudge> = {}): DraftToJudge => ({
  slug: "policies",
  body_markdown: "**Pricing:** flat $60 fee. 30-day money-back guarantee.",
  cited_sources: [{ url: "https://acme.co/pricing", note: "$60 fee, 30-day money-back guarantee" }],
  ...over,
});

describe("parseJudgeVerdict — fail-closed", () => {
  it("promotes only on an explicit promote verdict with no unsupported claims", () => {
    const v = parseJudgeVerdict('{"verdict":"promote","reason":"all backed","unsupported_claims":[]}');
    expect(v.verdict).toBe("promote");
  });

  it("holds on an explicit hold", () => {
    expect(parseJudgeVerdict('{"verdict":"hold","reason":"x","unsupported_claims":["$99 fee"]}').verdict).toBe("hold");
  });

  it("holds when the model returns no JSON at all", () => {
    expect(parseJudgeVerdict("I think this looks fine!").verdict).toBe("hold");
  });

  it("holds on invalid JSON", () => {
    expect(parseJudgeVerdict('{"verdict":"promote", oops}').verdict).toBe("hold");
  });

  it("holds a self-contradictory promote (promote label but unsupported claims listed)", () => {
    const v = parseJudgeVerdict('{"verdict":"promote","reason":"mostly","unsupported_claims":["$99 fee not on page"]}');
    expect(v.verdict).toBe("hold");
    expect(v.unsupported_claims).toEqual(["$99 fee not on page"]);
  });

  it("treats an unknown/typo verdict as hold", () => {
    expect(parseJudgeVerdict('{"verdict":"maybe","reason":"x"}').verdict).toBe("hold");
  });

  it("holds a partial promote that omits unsupported_claims (malformed → fail-closed)", () => {
    const v = parseJudgeVerdict('{"verdict":"promote","reason":"ok"}');
    expect(v.verdict).toBe("hold");
    expect(v.reason).toMatch(/missing unsupported_claims/);
  });

  it("holds a promote whose unsupported_claims is a non-array", () => {
    expect(parseJudgeVerdict('{"verdict":"promote","reason":"ok","unsupported_claims":"none"}').verdict).toBe("hold");
  });
});

describe("judgeDraftWith — the verdict core", () => {
  const promoteJudge: JudgeFn = async () => '{"verdict":"promote","reason":"backed","unsupported_claims":[]}';
  const holdJudge: JudgeFn = async () => '{"verdict":"hold","reason":"unsourced number","unsupported_claims":["$60"]}';
  const throwJudge: JudgeFn = async () => {
    throw new Error("model down");
  };

  it("never calls the judge for a draft with no cited sources — holds outright", async () => {
    let called = false;
    const spy: JudgeFn = async (p) => {
      called = true;
      return p;
    };
    const v = await judgeDraftWith(draft({ cited_sources: [] }), spy);
    expect(v.verdict).toBe("hold");
    expect(called).toBe(false);
  });

  it("holds an empty body without calling the judge", async () => {
    const v = await judgeDraftWith(draft({ body_markdown: "   " }), promoteJudge);
    expect(v.verdict).toBe("hold");
  });

  it("promotes a well-sourced draft", async () => {
    expect((await judgeDraftWith(draft(), promoteJudge)).verdict).toBe("promote");
  });

  it("holds when the judge flags an unsupported claim", async () => {
    expect((await judgeDraftWith(draft(), holdJudge)).verdict).toBe("hold");
  });

  it("fails CLOSED when the judge call throws", async () => {
    const v = await judgeDraftWith(draft(), throwJudge);
    expect(v.verdict).toBe("hold");
    expect(v.reason).toMatch(/judge call failed/);
  });
});

describe("buildJudgePrompt", () => {
  it("includes the anchor body, the cited urls + notes, and a skeptical instruction", () => {
    const p = buildJudgePrompt(draft());
    expect(p).toContain("$60 fee");
    expect(p).toContain("https://acme.co/pricing");
    expect(p).toContain("SKEPTICAL");
    expect(p).toContain("HOLD");
  });

  it("says explicitly when no sources were cited", () => {
    expect(buildJudgePrompt(draft({ cited_sources: [] }))).toContain("NO sources were cited");
  });
});
