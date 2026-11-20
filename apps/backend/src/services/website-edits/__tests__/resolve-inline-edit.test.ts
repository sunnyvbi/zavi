import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: mocks.create } }),
  heliconePropertyHeaders: () => ({}),
}));

import {
  resolveInlineEdit,
  isStyleOnlyAsk,
  resolveChatEditFromOutline,
  extractJsonObject,
  withAbortTimeout,
} from "../resolve-inline-edit";

const reply = (text: string) => ({ content: [{ type: "text", text }] });

beforeEach(() => mocks.create.mockReset());

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    expect(extractJsonObject('{"text":"Hi"}')).toEqual({ text: "Hi" });
  });
  it("strips a ```json fence", () => {
    expect(extractJsonObject('```json\n{"style":{"color":"#000"}}\n```')).toEqual({
      style: { color: "#000" },
    });
  });
  it("slices surrounding prose to the outer braces", () => {
    expect(extractJsonObject('Sure: {"text":"X"} done')).toEqual({ text: "X" });
  });
  it("throws when there is no object", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});

describe("resolveInlineEdit", () => {
  it("returns the parsed patch object from the model", async () => {
    mocks.create.mockResolvedValue(reply('{"text":"Clothes worth keeping."}'));
    const out = await resolveInlineEdit({
      tag: "p",
      text: "old",
      style: {},
      message: "change to Clothes worth keeping",
    });
    expect(out).toEqual({ text: "Clothes worth keeping." });
  });

  it("throws on unparseable output so the caller can degrade", async () => {
    mocks.create.mockResolvedValue(reply("I cannot do that"));
    await expect(
      resolveInlineEdit({ tag: "p", text: "x", style: {}, message: "..." }),
    ).rejects.toThrow();
  });

  it("passes the element context + instruction to the model", async () => {
    mocks.create.mockResolvedValue(reply("{}"));
    await resolveInlineEdit({
      tag: "h1",
      text: "Hi",
      style: { color: "#111" },
      message: "make it navy",
    });
    const arg = mocks.create.mock.calls[0][0] as { messages: { content: string }[] };
    const userMsg = arg.messages[0].content;
    expect(userMsg).toContain("make it navy");
    expect(userMsg).toContain("h1");
  });
});

describe("resolveChatEditFromOutline", () => {
  it("returns the model's {selector, patch}", async () => {
    mocks.create.mockResolvedValue(
      reply('{"selector":"footer p","patch":{"text":"Clothes worth keeping."}}'),
    );
    const out = await resolveChatEditFromOutline(
      [{ selector: "footer p", tag: "p", text: "old" }],
      "change the tagline to Clothes worth keeping",
    );
    expect(out).toEqual({ selector: "footer p", patch: { text: "Clothes worth keeping." } });
  });

  it("sends the outline + instruction + brand_context to the model", async () => {
    mocks.create.mockResolvedValue(reply("{}"));
    await resolveChatEditFromOutline(
      [{ selector: "h1.hero", tag: "h1", text: "Considered clothes" }],
      "use a real brand name",
      { companyContext: "Acme is a small-batch clothing brand" },
    );
    const arg = mocks.create.mock.calls[0][0] as { messages: { content: string }[] };
    const userMsg = arg.messages[0].content;
    expect(userMsg).toContain("h1.hero");
    expect(userMsg).toContain("use a real brand name");
    expect(userMsg).toContain("small-batch clothing brand");
  });
});

describe("resolveInlineEdit prompt — a general improve ask is a text rewrite", () => {
  it("tells the model that feedback-style improve asks rewrite current_text (guard, not evidence: the live model was probed separately)", async () => {
    mocks.create.mockResolvedValue(reply("{}"));
    await resolveInlineEdit({
      tag: "h1",
      text: "A calmer place to put your tinnitus.",
      style: {},
      message: "This is good. We need to improve it further.",
    });
    const params = mocks.create.mock.calls[0][0] as { system: string; model: string; temperature?: number };
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.temperature).toBe(0);
    expect(params.system).toMatch(/improve, polish, refine, tighten, strengthen, make better/);
    expect(params.system).toMatch(/Returning the current words unchanged is a failure/);
    expect(params.system).toMatch(/IS a text instruction when current_text is non-empty/);
    expect(params.system).toMatch(/Praise or commentary attached to such an ask does not cancel it/);
    const returnEmpty = params.system.indexOf("return {}");
    const improveRule = params.system.indexOf("A general ask to improve");
    expect(improveRule).toBeGreaterThan(-1);
    expect(improveRule).toBeLessThan(returnEmpty);
  });

  it("a style-only ask on an element with runs stays on the fast model", async () => {
    mocks.create.mockResolvedValue(reply('{"style":{"fontWeight":"bold"}}'));
    await resolveInlineEdit({
      tag: "div",
      text: "Volvo XC40 260 mi range",
      segments: ["Volvo XC40", "260 mi range"],
      style: {},
      message: "make the background light grey",
    });
    const params = mocks.create.mock.calls[0][0] as { model: string; temperature?: number; messages: { content: string }[] };
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.temperature).toBe(0);
    expect(JSON.parse(params.messages[0].content).current_segments).toEqual(["Volvo XC40", "260 mi range"]);
  });

  it("tells a style ask from a wording ask", () => {
    for (const m of ["make it bold", "make the background light grey", "center it", "make the text navy", "bigger font"]) {
      expect(isStyleOnlyAsk(m)).toBe(true);
    }
    for (const m of ["polish it", "This is good. We need to improve it further.", "make it bold and punchier", "make the copy shorter", "fix the typo", "can you do this, do that"]) {
      expect(isStyleOnlyAsk(m)).toBe(false);
    }
  });

  it("sends the formatted runs of a heading so the model can rewrite them without flattening", async () => {
    mocks.create.mockResolvedValue(reply('{"segments":["Rent a car, quietly. ","Northline is almost here."]}'));
    const out = await resolveInlineEdit({
      tag: "h1",
      text: "A quieter way to rent a car. Northline opens the road soon.",
      segments: ["A quieter way to rent a car. ", "Northline opens the road soon."],
      style: {},
      message: "polish it further",
    });
    const params = mocks.create.mock.calls[0][0] as {
      model: string;
      temperature?: number;
      messages: { content: string }[];
    };
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params).not.toHaveProperty("temperature");
    expect(JSON.parse(params.messages[0].content).current_segments).toEqual([
      "A quieter way to rent a car. ",
      "Northline opens the road soon.",
    ]);
    expect(out).toEqual({ segments: ["Rent a car, quietly. ", "Northline is almost here."] });
  });
});

describe("a timed-out model call is aborted, not just abandoned", () => {
  it("aborts the request's signal at the timeout and rejects with a timeout error", async () => {
    let seen: AbortSignal | undefined;
    const hung = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    };
    await expect(withAbortTimeout("probe", 20, hung)).rejects.toThrow(/probe timeout after 20ms/);
    expect(seen?.aborted).toBe(true);
  });

  it("both resolvers hand the request an abort signal", async () => {
    mocks.create.mockResolvedValueOnce(reply("{}"));
    await resolveInlineEdit({ tag: "p", text: "hi", style: {}, message: "bold" });
    expect(mocks.create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("the chat-edit resolver passes an abort signal too", async () => {
    mocks.create.mockResolvedValueOnce(reply('{"selector":"h1","patch":{"text":"x"}}'));
    await resolveChatEditFromOutline([{ selector: "h1", tag: "h1", text: "a" }], "rename");
    expect(mocks.create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
