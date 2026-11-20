
import { describe, it, expect, vi, beforeEach } from "vitest";

let llmJson = "";
let authOn = true;

vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "claude-haiku-test",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
  hasAnthropicAuth: () => authOn,
  createMessageWithFailover: async () => ({
    content: [{ type: "text", text: `<classification_json>${llmJson}</classification_json>` }],
  }),
}));

import { classifyShapeStage, extractClassification, COMPANY_SHAPES } from "../classify-shape-stage";

const FAT_CONTEXT =
  "Acme connects car owners with renters in a two-sided peer-to-peer marketplace. " +
  "Hosts list their vehicles; guests book them by the day. We operate live across five states.".repeat(
    3,
  );

describe("classifyShapeStage", () => {
  beforeEach(() => {
    llmJson = "";
    authOn = true;
  });

  it("returns a valid in-set shape + stage for a clear marketplace site", async () => {
    llmJson = JSON.stringify({ shape: "marketplace", stage: 4, confidence: "high" });
    const out = await classifyShapeStage(FAT_CONTEXT);
    expect(out.shape).toBe("marketplace");
    expect(COMPANY_SHAPES).toContain(out.shape);
    expect(out.stage).toBe(4);
    expect(out.confidence).toBe("high");
  });

  it("returns low-confidence best guess on thin input WITHOUT calling the LLM", async () => {
    const { createMessageWithFailover } = await import("@/services/anthropic");
    const spy = createMessageWithFailover as unknown as ReturnType<typeof vi.fn>;
    const out = await classifyShapeStage("too short");
    expect(out.confidence).toBe("low");
    expect(COMPANY_SHAPES).toContain(out.shape);
    expect(out.stage).toBeGreaterThanOrEqual(0);
    expect(out.stage).toBeLessThanOrEqual(6);
    void spy;
  });

  it("returns low-confidence fallback when anthropic auth is unavailable", async () => {
    authOn = false;
    const out = await classifyShapeStage(FAT_CONTEXT);
    expect(out.confidence).toBe("low");
    expect(out.shape).toBe("other");
    expect(out.stage).toBe(0);
  });

  it("clamps an out-of-range stage to 0..6 (high)", async () => {
    llmJson = JSON.stringify({ shape: "saas", stage: 99, confidence: "high" });
    const hi = await classifyShapeStage(FAT_CONTEXT);
    expect(hi.stage).toBe(6);
    expect(hi.shape).toBe("saas");

    llmJson = JSON.stringify({ shape: "saas", stage: -5, confidence: "low" });
    const lo = await classifyShapeStage(FAT_CONTEXT);
    expect(lo.stage).toBe(0);
  });

  it("never emits an out-of-set shape — an invalid LLM shape falls back to 'other' + low", async () => {
    llmJson = JSON.stringify({ shape: "crypto-defi-dao", stage: 2, confidence: "high" });
    const out = await classifyShapeStage(FAT_CONTEXT);
    expect(out.shape).toBe("other");
    expect(COMPANY_SHAPES).toContain(out.shape);
    expect(out.confidence).toBe("low");
    expect(out.stage).toBe(2);
  });

  it("falls back to a low-confidence best guess on unparseable model output", async () => {
    llmJson = "not json at all, no braces";
    const out = await classifyShapeStage(FAT_CONTEXT);
    expect(out.confidence).toBe("low");
    expect(COMPANY_SHAPES).toContain(out.shape);
  });
});

describe("extractClassification (pure parse)", () => {
  it("parses the asked-for tag-wrapped shape", () => {
    const out = extractClassification('<classification_json>{"shape":"fintech","stage":3,"confidence":"high"}</classification_json>');
    expect(out).toEqual({ shape: "fintech", stage: 3, confidence: "high" });
  });

  it("parses a bare object with no wrapper", () => {
    const out = extractClassification('here you go {"shape":"ecommerce","stage":1,"confidence":"low"}');
    expect(out).toEqual({ shape: "ecommerce", stage: 1, confidence: "low" });
  });

  it("coerces a string stage and rounds", () => {
    const out = extractClassification('{"shape":"services","stage":"2.6","confidence":"high"}');
    expect(out).toEqual({ shape: "services", stage: 3, confidence: "high" });
  });

  it("returns null when there is no parseable JSON", () => {
    expect(extractClassification("completely empty")).toBeNull();
  });
});
