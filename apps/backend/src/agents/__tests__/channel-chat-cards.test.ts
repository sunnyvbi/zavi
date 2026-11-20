import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ heal: vi.fn(), emit: vi.fn(), count: { n: 0 } }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ count: m.count.n, error: null }) }) }) }),
}));
vi.mock("@/services/channels/direct-run", () => ({ healChatRunStamp: m.heal }));

import { dispatchers, postProcessors } from "@/agents/index";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const channels = ["linkedin_organic", "x_ads", "tiktok_organic", "tiktok_ads", "chatgpt_ads", "instagram_organic", "x_organic", "meta_ads"];
const ctx = { tenant_id: "t1", runId: "r1", trigger: "chat" } as unknown as AgentContext;
const withSteps = () =>
  ({
    parse_ok: true,
    parsed: { rendered_markdown: "x", steps: [{ title: "Pause X", body: "b", blocking: false, effort: "minutes", evidence: ["e"] }] },
    output_text: "",
  }) as unknown as DispatcherResult;

beforeEach(() => {
  m.heal.mockReset();
  m.emit.mockReset().mockImplementation(async (_c: unknown, r: unknown) => r);
  for (const slug of channels) (dispatchers[slug] as unknown as { emitAfterRun: unknown }).emitAfterRun = m.emit;
  m.count.n = 0;
});

describe("channelChatCards", () => {
  it("a prose reply files nothing and reads nothing", async () => {
    await postProcessors.meta_ads(ctx, { parse_ok: false, parsed: null, output_text: "hi" } as unknown as DispatcherResult, {});
    expect(m.heal).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it.each(channels)("%s files once the stamp is confirmed, retrying an unreadable row once", async (slug) => {
    m.heal.mockResolvedValueOnce("unreadable").mockResolvedValueOnce("meta_ads");
    await postProcessors[slug](ctx, withSteps(), {});
    expect(m.heal).toHaveBeenCalledTimes(2);
    expect(m.emit).toHaveBeenCalledTimes(1);
  });

  it.each([["failed"], ["unreadable"]])("refuses loudly (no cards) when the stamp stays %s", async (outcome) => {
    m.heal.mockResolvedValue(outcome);
    await expect(postProcessors.meta_ads(ctx, withSteps(), {})).rejects.toThrow(/cards not filed/);
    expect(m.emit).not.toHaveBeenCalled();
  });
});

it("removes success claims when dedup saves no new cards", async () => {
  m.heal.mockResolvedValue("meta_ads");
  m.emit.mockImplementation(async (_c, r) => { r.side_effect = { kind: "shipped", detail: "" }; return r; });
  const result = withSteps();
  await postProcessors.meta_ads(ctx, result, {});
  expect(result.output_text).toContain("no new cards");
  expect(result.parsed).toMatchObject({ steps: [], rendered_markdown: result.output_text });
});

it("a card the turn's propose tool saved counts, but a count never keeps the model's own claim", async () => {
  m.heal.mockResolvedValue("meta_ads");
  m.count.n = 1;
  m.emit.mockImplementation(async (_c, r) => { r.side_effect = { kind: "shipped", detail: "" }; return r; });
  const result = withSteps();
  result.output_text = "Filed the pause card.";
  await postProcessors.meta_ads(ctx, result, {});
  expect(result.output_text).toBe("Saved 1 card from this reply. The channel's Actions list shows them.");
  expect(result.parsed).toMatchObject({ steps: [], rendered_markdown: result.output_text });
});

it("keeps the reply when every step was saved", async () => {
  m.heal.mockResolvedValue("meta_ads");
  m.emit.mockImplementation(async (_c, r) => { r.side_effect = { kind: "shipped", detail: "card-1" }; return r; });
  const result = withSteps();
  result.output_text = "Filed the pause card.";
  await postProcessors.meta_ads(ctx, result, {});
  expect(result.output_text).toBe("Filed the pause card.");
});

it("an unreadable card count is unknown, not zero", async () => {
  m.heal.mockResolvedValue("meta_ads");
  m.count.n = null as unknown as number;
  m.emit.mockImplementation(async (_c, r) => { r.side_effect = { kind: "shipped", detail: "" }; return r; });
  const result = withSteps();
  await postProcessors.meta_ads(ctx, result, {});
  expect(result.output_text).toContain("could not confirm");
});

describe("channelChatCards on a turn that asked no card", () => {
  const answerCtx = { ...ctx, chat_turn_verdict: "answer" } as unknown as AgentContext;

  it("drops the steps, keeps the answer and offers the card", async () => {
    const result = withSteps();
    result.output_text = "CPC is high because the audience is narrow.";
    (result.parsed as { rendered_markdown: string }).rendered_markdown = "CPC is high because the audience is narrow.";
    await postProcessors.meta_ads(answerCtx, result, {});
    expect(m.heal).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
    expect(result.output_text).toBe("CPC is high because the audience is narrow.\n\nWant me to make this a card?");
    expect(result.parsed).toMatchObject({ steps: [], rendered_markdown: result.output_text });
  });

  it("does not repeat an offer the reply already makes", async () => {
    const result = withSteps();
    result.output_text = "Widen the audience.\n\nWant me to make this a card?";
    await postProcessors.meta_ads(answerCtx, result, {});
    expect(result.output_text).toBe("Widen the audience.\n\nWant me to make this a card?");
  });

  it("an action turn still files its cards", async () => {
    m.heal.mockResolvedValue("meta_ads");
    m.emit.mockImplementation(async (_c, r) => { r.side_effect = { kind: "shipped", detail: "card-1" }; return r; });
    await postProcessors.meta_ads({ ...ctx, chat_turn_verdict: "action" } as unknown as AgentContext, withSteps(), {});
    expect(m.emit).toHaveBeenCalledTimes(1);
  });
});
