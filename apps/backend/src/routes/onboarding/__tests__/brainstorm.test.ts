
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { createMock, verifyBearer, researchIdea } = vi.hoisted(() => ({
  createMock: vi.fn(),
  verifyBearer: vi.fn(),
  researchIdea: vi.fn(),
}));

const LANDSCAPE = {
  competitors: [{ name: "Acme", angle: "incumbent" }],
  market: "growing",
  pricing: "SaaS",
  gap: "vetting",
  wedge: "trust",
  v1: "match + book",
  opening_message: "Here's the landscape — what matters most?",
  sources: [{ title: "src", url: "https://x.com" }],
  grounded: true,
};

vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
  hasAnthropicAuth: () => true,
  DEFAULT_FAST_MODEL: "claude-sonnet-4-6",
  cachedSystemBlock: (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } }),
}));

vi.mock("@/services/auth/jwt", () => ({ verifyBearer }));

vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  sanitizeFetchedContent: (s: string) => s,
  xmlEscapeContent: (s: string) => s,
}));

vi.mock("@/services/onboarding/brainstorm-research", () => ({ researchIdea }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => true) }));

import { onboardingBrainstorm, MAX_USER_TURNS, __test } from "../brainstorm";

type MockRes = { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
function mockRes(): MockRes {
  const json = vi.fn();
  const status = vi.fn();
  status.mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}
function mockReq(body: object, ip = "203.0.113.7"): Request {
  return { body, headers: {}, ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function anthropicReply(obj: unknown) {
  return { content: [{ type: "text", text: `<reply>${JSON.stringify(obj)}</reply>` }] };
}

describe("POST /api/onboarding/brainstorm", () => {
  beforeEach(() => {
    createMock.mockReset();
    verifyBearer.mockReset();
    verifyBearer.mockResolvedValue(null);
    researchIdea.mockReset();
    researchIdea.mockResolvedValue(LANDSCAPE);
    __test.resetLimits();
  });

  it("returns a question + pre-picks on the opening turn, WITHOUT a bearer (pre-signup)", async () => {
    createMock.mockResolvedValueOnce(
      anthropicReply({ message: "Who's it for?", options: ["A", "B", "C"], recommended: "B" }),
    );
    const { res, json } = mockRes();
    await onboardingBrainstorm(mockReq({ seedIdea: "a marketplace", history: [], mode: "chat" }), res);

    expect(verifyBearer).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("chat");
    expect(payload.message).toBe("Who's it for?");
    expect(payload.options).toEqual(["A", "B", "C"]);
    expect(payload.recommended).toBe("B");
    expect(payload.max_user_turns).toBe(MAX_USER_TURNS);
  });

  it("enforces the server-authoritative turn cap without calling Anthropic", async () => {
    const history = Array.from({ length: MAX_USER_TURNS }, (_, i) => ({ role: "user" as const, text: `turn ${i}` }));
    const { res, json } = mockRes();
    await onboardingBrainstorm(mockReq({ seedIdea: "x", history, mode: "chat" }), res);

    expect(createMock).not.toHaveBeenCalled();
    const payload = json.mock.calls[0][0];
    expect(payload.done).toBe(true);
    expect(payload.message).toMatch(/drop it in the box/i);
  });

  it("summarize mode returns a brief string", async () => {
    createMock.mockResolvedValueOnce(anthropicReply({ brief: "A VA marketplace for SMBs. v1: post a job, get matched." }));
    const { res, json } = mockRes();
    await onboardingBrainstorm(
      mockReq({ seedIdea: "va marketplace", history: [{ role: "user", text: "SMBs" }], mode: "summarize" }),
      res,
    );
    const payload = json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("summarize");
    expect(payload.brief).toMatch(/VA marketplace/);
  });

  it("blocks anon callers past the per-IP limit (429)", async () => {
    createMock.mockResolvedValue(anthropicReply({ message: "q", options: ["A"], recommended: "A" }));
    const ip = "198.51.100.42";
    let last: MockRes | undefined;
    for (let i = 0; i < 41; i++) {
      last = mockRes();
      await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }, ip), last.res);
    }
    expect(last!.status).toHaveBeenCalledWith(429);
    const err = last!.json.mock.calls[0][0];
    expect(err.error.code).toBe("rate_limited");
  });

  it("blocks authed callers past the per-user limit (not just the global cap)", async () => {
    createMock.mockResolvedValue(anthropicReply({ message: "q", options: ["A"], recommended: "A" }));
    verifyBearer.mockResolvedValue({ user_id: "user-heavy" });
    let last: MockRes | undefined;
    for (let i = 0; i < 61; i++) {
      last = mockRes();
      await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }, `10.0.0.${i}`), last.res);
    }
    expect(last!.status).toHaveBeenCalledWith(429);
    expect(last!.json.mock.calls[0][0].error.code).toBe("rate_limited");
  });

  it("research mode returns the synthesized landscape + opening message", async () => {
    const { res, json } = mockRes();
    await onboardingBrainstorm(
      mockReq({ seedIdea: "a VA marketplace for small businesses", mode: "research" }),
      res,
    );
    expect(researchIdea).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("research");
    expect(payload.landscape.competitors[0].name).toBe("Acme");
    expect(payload.message).toMatch(/landscape/i);
  });

  it("research mode caches by idea — a repeat idea does not re-run research", async () => {
    const body = { seedIdea: "a VA marketplace for small businesses", mode: "research" };
    await onboardingBrainstorm(mockReq(body), mockRes().res);
    await onboardingBrainstorm(mockReq(body), mockRes().res);
    expect(researchIdea).toHaveBeenCalledTimes(1);
  });

  it("research mode 400s on a too-short idea without calling research", async () => {
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ seedIdea: "cars", mode: "research" }), res);
    expect(researchIdea).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].error.code).toBe("idea_too_short");
  });

  it("rejects oversized/forged history (> MAX_USER_TURNS) with 400 before any LLM call", async () => {
    const history = Array.from({ length: MAX_USER_TURNS + 1 }, (_, i) => ({ role: "user" as const, text: `t${i}` }));
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history, mode: "summarize" }), res);
    expect(createMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].error.code).toBe("too_much_history");
  });

  it("rejects an invalid body with 400", async () => {
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history: "not-an-array" }), res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].error.code).toBe("validation");
  });

  it("rejects a chat reply whose recommended is not among options (parse_error 502)", async () => {
    createMock.mockResolvedValue(anthropicReply({ message: "q", options: ["A", "B"], recommended: "Z" }));
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }), res);
    expect(status).toHaveBeenCalledWith(502);
    expect(json.mock.calls[0][0].error.code).toBe("parse_error");
  });

  it("accepts a reply that sends null for options and recommended", async () => {
    createMock.mockResolvedValueOnce(anthropicReply({ message: "Fair point.", options: null, recommended: null }));
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history: [{ role: "user", text: "same answer" }], mode: "chat" }), res);
    expect(status).not.toHaveBeenCalled();
    const wire = JSON.parse(JSON.stringify(json.mock.calls[0][0]));
    expect(wire.ok).toBe(true);
    expect(wire.message).toBe("Fair point.");
    expect(wire).not.toHaveProperty("options");
    expect(wire).not.toHaveProperty("recommended");
  });

  it("retries once when the first reply fails validation", async () => {
    createMock
      .mockResolvedValueOnce(anthropicReply({ message: "q", recommended: 7 }))
      .mockResolvedValueOnce(anthropicReply({ message: "Who's it for?", options: ["A", "B"], recommended: "A" }));
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }), res);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].message).toBe("Who's it for?");
  });

  it("never shows validation internals or the raw model output to the visitor", async () => {
    createMock.mockResolvedValue(anthropicReply({ message: "q", recommended: 7 }));
    const { res, status, json } = mockRes();
    await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }), res);
    expect(status).toHaveBeenCalledWith(502);
    const body = json.mock.calls[0][0];
    expect(body.error).toEqual({ code: "parse_error", message: "Zavi couldn't answer just now. Try again in a moment." });
  });

  it("gives the retry only what is left of the time budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    createMock.mockImplementation(async () => {
      now += 55_000;
      return anthropicReply({ message: "q", recommended: 7 });
    });
    try {
      const { res, status } = mockRes();
      await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }), res);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60_000, 35_000]);
      expect(status).toHaveBeenCalledWith(502);
    } finally {
      clock.mockRestore();
      timeout.mockRestore();
    }
  });

  it("answers at the time budget and aborts the model request instead of waiting on it", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let sdkSignal: AbortSignal | undefined;
    createMock.mockImplementation((_body: unknown, opts: { signal: AbortSignal }) => {
      sdkSignal = opts.signal;
      setTimeout(() => controller.abort(new DOMException("budget spent", "TimeoutError")), 0);
      return new Promise(() => {});
    });
    try {
      const { res, status, json } = mockRes();
      await onboardingBrainstorm(mockReq({ history: [], mode: "chat" }), res);
      expect(sdkSignal?.aborted).toBe(true);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(504);
      expect(json.mock.calls[0][0].error.code).toBe("llm_timeout");
    } finally {
      timeout.mockRestore();
    }
  });
});
