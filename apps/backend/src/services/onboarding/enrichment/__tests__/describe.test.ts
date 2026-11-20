
import { describe, it, expect, vi, beforeEach } from "vitest";

let authPresent = true;
let llmText = "";

vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "claude-haiku-test",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
  hasAnthropicAuth: () => authPresent,
  getAnthropic: () => ({
    messages: {
      create: async () => ({ content: [{ type: "text", text: llmText }] }),
    },
  }),
  createMessageWithFailover: async () => ({ content: [{ type: "text", text: llmText }] }),
}));

import { describeCompany, extractDescription } from "../describe";

const longContext =
  "Linear is a purpose-built tool for planning and building products. " +
  "It streamlines issues, projects, and product roadmaps for software teams. ".repeat(6);

describe("describeCompany", () => {
  beforeEach(() => {
    authPresent = true;
  });

  it("returns the grounded description parsed from the LLM tag", async () => {
    llmText =
      '<description_json>{"description":"Linear is a project planning and issue tracking tool for software teams. It helps teams manage roadmaps and ship faster."}</description_json>';
    const out = await describeCompany("Linear", "linear.app", longContext);
    expect(out).toBe(
      "Linear is a project planning and issue tracking tool for software teams. It helps teams manage roadmaps and ship faster.",
    );
  });

  it("returns undefined when no auth (→ caller falls back to excerpt)", async () => {
    authPresent = false;
    const out = await describeCompany("Linear", "linear.app", longContext);
    expect(out).toBeUndefined();
  });

  it("returns undefined when the crawled context is too thin to ground", async () => {
    llmText = '<description_json>{"description":"whatever"}</description_json>';
    const out = await describeCompany("Obscure", "obscure.io", "tiny");
    expect(out).toBeUndefined();
  });

  it("returns undefined when the model omits the tag (no fabrication leaks through)", async () => {
    llmText = "I could not find enough information.";
    const out = await describeCompany("Linear", "linear.app", longContext);
    expect(out).toBeUndefined();
  });

  it("returns undefined when the model returns an empty description", async () => {
    llmText = '<description_json>{"description":""}</description_json>';
    const out = await describeCompany("Linear", "linear.app", longContext);
    expect(out).toBeUndefined();
  });

  it("recovers a bare {...} description the model returned without the tag", async () => {
    llmText = 'Sure — {"description":"Upcar is a peer-to-peer car rental marketplace connecting local hosts with travelers."}';
    const out = await describeCompany("Upcar", "upcar.ai", longContext);
    expect(out).toBe(
      "Upcar is a peer-to-peer car rental marketplace connecting local hosts with travelers.",
    );
  });
});

const GOOD =
  "Upcar is a peer-to-peer car rental marketplace where local hosts list their vehicles and travelers book them by the day.";

describe("extractDescription — tolerates real fast-model output shapes", () => {
  it("parses the asked-for <description_json> wrapper", () => {
    expect(
      extractDescription(`Here you go:\n<description_json>{"description":"${GOOD}"}</description_json>`),
    ).toEqual({ description: GOOD });
  });

  it("parses a ```json fenced block with no wrapper", () => {
    expect(extractDescription("```json\n{\"description\":\"" + GOOD + "\"}\n```")).toEqual({
      description: GOOD,
    });
  });

  it("parses a fenced block INSIDE the wrapper", () => {
    expect(
      extractDescription(
        "<description_json>```json\n{\"description\":\"" + GOOD + "\"}\n```</description_json>",
      ),
    ).toEqual({ description: GOOD });
  });

  it("parses a bare {...} object surrounded by prose", () => {
    expect(extractDescription(`Sure! {"description":"${GOOD}"} Hope that helps.`)).toEqual({
      description: GOOD,
    });
  });

  it("slices an over-long description to 600 chars instead of dropping it", () => {
    const r = extractDescription(`{"description":"${"A".repeat(900)}"}`);
    expect("description" in r && r.description.length).toBe(600);
  });

  it("reports model_empty for valid JSON with an empty/too-short description", () => {
    expect(extractDescription(`{"description":""}`)).toEqual({ reason: "model_empty" });
    expect(extractDescription(`{"description":"tiny"}`)).toEqual({ reason: "model_empty" });
  });

  it("reports no_json when there is no parseable JSON at all", () => {
    expect(extractDescription("I could not determine what this company does.")).toEqual({
      reason: "no_json",
    });
  });
});
