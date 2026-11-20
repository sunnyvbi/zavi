import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: { responseText: string } = { responseText: "{}" };
  const create = vi.fn(async () => ({ content: [{ type: "text", text: state.responseText }] }));
  const getAnthropic = vi.fn(() => ({ messages: { create } }));
  return { state, create, getAnthropic };
});

vi.mock("@/services/anthropic", () => ({ getAnthropic: m.getAnthropic, DEFAULT_MODEL: "claude-test" }));
vi.mock("@/services/agents/prompt-injection", () => ({
  renderUntrustedBlock: (label: string, content: string) => `<untrusted ${label}>${content}</untrusted>`,
}));

import { distillCard } from "../../services/memory-cards/distill";

beforeEach(() => {
  m.state.responseText = "{}";
  m.create.mockClear();
});

describe("distillCard", () => {
  it("parses a valid card", async () => {
    m.state.responseText = JSON.stringify({
      title: "Credit-score threshold for subscriptions is 550",
      body: "Below 550 blocked; admin can override.",
      confidence: "medium",
      source_excerpt: "threshold is 550",
      worth_remembering: true,
    });
    const c = await distillCard({ text: "we decided the credit threshold stays at 550, admin can override" });
    expect(c).not.toBeNull();
    expect(c!.title).toContain("550");
    expect(c!.confidence).toBe("medium");
  });

  it("returns null when the model says nothing worth remembering", async () => {
    m.state.responseText = JSON.stringify({ title: "n/a", worth_remembering: false });
    const c = await distillCard({ text: "ok thanks see you tomorrow" });
    expect(c).toBeNull();
  });

  it("returns null on unparseable output (never throws)", async () => {
    m.state.responseText = "I cannot produce JSON";
    expect(await distillCard({ text: "some real content here to distill" })).toBeNull();
  });

  it("skips the LLM on near-empty input", async () => {
    expect(await distillCard({ text: "hi" })).toBeNull();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("strips markdown fences", async () => {
    m.state.responseText =
      '```json\n{"title":"Jay owns the Stripe webhook fix by Friday","confidence":"high","source_excerpt":"Jay owns it","worth_remembering":true}\n```';
    const c = await distillCard({ text: "Jay owns the Stripe webhook fix, due Friday" });
    expect(c?.title).toContain("Jay");
  });
});

describe("detectRemember", () => {
  it("matches remember/save intent verbs", async () => {
    const { detectRemember } = await import("../../services/memory-cards/remember-detect");
    expect(detectRemember("<@U1> remember this")).toBe(true);
    expect(detectRemember("hey zavi save this for later")).toBe(true);
    expect(detectRemember("add to memory: the threshold is 550")).toBe(true);
    expect(detectRemember("note this down please")).toBe(true);
  });
  it("does NOT match questions or bare mentions", async () => {
    const { detectRemember } = await import("../../services/memory-cards/remember-detect");
    expect(detectRemember("<@U1> what do we know about Acme?")).toBe(false);
    expect(detectRemember("<@U1>")).toBe(false);
    expect(detectRemember("can you summarize the thread")).toBe(false);
    expect(detectRemember("")).toBe(false);
  });
});
