import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, alertMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  alertMock: vi.fn(),
}));

vi.mock("@/services/openai", () => ({
  getOpenAi: () => ({ chat: { completions: { create: createMock } } }),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({}),
  heliconePropertyHeaders: () => ({}),
}));
vi.mock("@/services/logging/alert", () => ({ alert: alertMock, deliverOpsAlert: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}));

import { scoreRun } from "../run-scorer";

beforeEach(() => {
  createMock.mockReset();
  alertMock.mockReset();
  alertMock.mockResolvedValue(undefined);
  createMock.mockResolvedValue({
    choices: [{ message: { content: '{"score":72,"rationale":"ok"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

const RUN = {
  id: "run-1",
  agent_slug: "pm",
  status: "success",
  output_text: "Shipped the thing.",
  error: null,
  model_used: "claude-opus-5",
  cost_usd: 0.02,
  tool_calls: [],
};

describe("scoreRun → callModel → OpenAI wire", () => {
  it("sends NO temperature for the default judge and does not trip the drop-alert", async () => {
    const res = await scoreRun(RUN);
    expect(res.score).toBe(72);

    const payload = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("temperature");
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.max_completion_tokens).toBe(2000);

    expect(alertMock).not.toHaveBeenCalled();
  });
});
