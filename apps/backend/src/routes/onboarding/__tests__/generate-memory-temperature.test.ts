
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: (...args: unknown[]) => createMock(...args),
  hasAnthropicAuth: () => true,
  DEFAULT_MODEL: "claude-sonnet-4-6",
  cachedSystemBlock: (text: string) => ({
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  }),
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () => ({
    user_id: "user-1",
    access_token: "tok",
  })),
}));

vi.mock("@/services/auth/closedBetaGate", () => ({
  requireClosedBetaGrant: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { blob: {} }, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));

import { onboardingGenerateMemory } from "../generate-memory";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res as unknown as import("express").Response & {
    statusCode: number;
    body: unknown;
  };
}

const okMemory = `<memory>${JSON.stringify({
  company: "# Company\n\nWe do X.",
  ops: "# Ops\n\nWe prioritize Y.",
  policies: "# Policies\n\nWe refund Z.",
  disputes: "# Disputes\n\nWe defend A.",
  support: "# Support\n\nWe reply in B.",
})}</memory>`;

const reqBody = {
  wizard: {
    role: "founder",
    marketplaceShape: "saas",
    stage: 1,
    orgName: "Acme",
    customerId: "acme",
    freeText: "thin profile, no metrics stated",
  },
};

describe("onboardingGenerateMemory — temperature pinning (F1)", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      content: [{ type: "text", text: okMemory }],
    });
  });

  it("passes temperature: 0.2 to the Anthropic create call", async () => {
    const req = { body: reqBody, headers: {} } as unknown as import("express").Request;
    const res = mockRes();

    await onboardingGenerateMemory(req, res);

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0] as {
      model: string;
      max_tokens: number;
      temperature: number;
    };
    expect(callArgs.temperature).toBe(0.2);
    expect(callArgs.model).toBe("claude-sonnet-4-6");
    expect(typeof callArgs.max_tokens).toBe("number");
  });
});
