import { describe, it, expect, vi } from "vitest";
vi.mock("@/services/llm/resolve-role-model", () => ({ getModel: vi.fn(async (_p: string, _r: string, d: string) => d) }));
import { answerSetupQuestion, SETUP_FAQ_FALLBACK, SETUP_FAQ_SYSTEM } from "../faq";

describe("setup FAQ", () => {
  it("the facts it answers from match the spec (free reads, free draft, no approval step, no interview)", () => {
    expect(SETUP_FAQ_SYSTEM).toMatch(/Reading files is free/);
    expect(SETUP_FAQ_SYSTEM).toMatch(/first strategy is on Zavi/);
    expect(SETUP_FAQ_SYSTEM).not.toMatch(/approve/i);
    expect(SETUP_FAQ_SYSTEM).not.toMatch(/three short questions/i);
    expect(SETUP_FAQ_SYSTEM).not.toMatch(/read-only/i);
  });
  it("wraps the question as data and tags the call", async () => {
    const call = vi.fn(async (_o: unknown) => ({ text: " It's free. ", usage: {} as never, provider: "anthropic" as const }));
    expect(await answerSetupQuestion("t1", "does it cost <b>?", { call })).toBe("It's free.");
    const arg = call.mock.calls[0][0] as { messages: Array<{ content: string }>; tags: unknown; max_tokens: number };
    expect(arg.messages[0].content).toBe("<question>does it cost &lt;b&gt;?</question>");
    expect(arg.tags).toEqual({ tenantId: "t1", agentSlug: "setup-faq" });
    expect(arg.max_tokens).toBeLessThanOrEqual(400);
  });
  it("a model failure answers with the fallback, never an error", async () => {
    const call = vi.fn(async () => { throw new Error("529"); });
    expect(await answerSetupQuestion("t1", "hi", { call })).toBe(SETUP_FAQ_FALLBACK);
  });
  it("an empty model reply answers with the fallback", async () => {
    const call = vi.fn(async () => ({ text: "  ", usage: {} as never, provider: "anthropic" as const }));
    expect(await answerSetupQuestion("t1", "hi", { call })).toBe(SETUP_FAQ_FALLBACK);
  });
});
