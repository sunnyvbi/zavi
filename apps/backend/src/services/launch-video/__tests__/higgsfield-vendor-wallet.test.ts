
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logEvent = vi.fn();
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import {
  classifyGenerationFailure,
  submitGeneration,
  pollGenerationOnce,
} from "../platform-higgsfield";

const CREDITS_BODY = '{"detail":"not_enough_credits"}';

function mockResponse(status: number, body: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response);
}

describe("classifyGenerationFailure — the body decides before the status", () => {
  it("names an empty wallet from the 403 body", () => {
    expect(classifyGenerationFailure(403, CREDITS_BODY)).toBe("vendor_wallet_exhausted");
  });

  it("does NOT call an empty wallet a credential problem", () => {
    expect(classifyGenerationFailure(403, CREDITS_BODY)).not.toBe("credential_rejected");
  });

  it("still treats a genuine 401 as a credential problem", () => {
    expect(classifyGenerationFailure(401, '{"detail":"Invalid or expired token"}')).toBe(
      "credential_rejected",
    );
  });

  it("treats a 403 that is NOT about credits as a credential problem", () => {
    expect(classifyGenerationFailure(403, '{"detail":"forbidden"}')).toBe("credential_rejected");
  });

  it("leaves everything else retryable", () => {
    expect(classifyGenerationFailure(500, "upstream boom")).toBe("vendor_error");
    expect(classifyGenerationFailure(429, "slow down")).toBe("vendor_error");
  });

  it("reads the wallet signal regardless of status code or casing", () => {
    expect(classifyGenerationFailure(402, '{"detail":"NOT_ENOUGH_CREDITS"}')).toBe(
      "vendor_wallet_exhausted",
    );
  });
});

describe("submitGeneration — surfaces and alarms on a drained wallet", () => {
  const OLD = process.env.HIGGSFIELD_API_KEY;
  beforeEach(() => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    logEvent.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (OLD === undefined) delete process.env.HIGGSFIELD_API_KEY;
    else process.env.HIGGSFIELD_API_KEY = OLD;
  });

  it("tags the failure so callers can tell a wallet from a key", async () => {
    mockResponse(403, CREDITS_BODY);
    const r = await submitGeneration("/higgsfield-ai/soul/standard", { prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("vendor_wallet_exhausted");
  });

  it("emits ONE queryable alarm event naming the real cause", async () => {
    mockResponse(403, CREDITS_BODY);
    await submitGeneration("/higgsfield-ai/soul/standard", { prompt: "x" });
    expect(logEvent).toHaveBeenCalledTimes(1);
    const arg = logEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.code).toBe("higgsfield.vendor_wallet_exhausted");
    expect(arg.level).toBe("error");
    expect(String(arg.message)).toMatch(/subscription/i);
    expect(String(arg.message)).toMatch(/ZAVI|our vendor/i);
    expect(String(arg.message)).toMatch(/NOT a customer/i);
  });

  it("puts the alarm fields on keys that survive the logEvent allow-list", async () => {
    mockResponse(403, CREDITS_BODY);
    await submitGeneration("/higgsfield-ai/soul/standard", { prompt: "x" });
    const meta = (logEvent.mock.calls[0][0] as { meta: Record<string, unknown> }).meta;
    expect(meta.failure_class).toBe("vendor_wallet_exhausted");
    expect(meta.http_status).toBe(403);
  });

  it("does NOT alarm on an ordinary vendor blip", async () => {
    mockResponse(500, "upstream boom");
    const r = await submitGeneration("/higgsfield-ai/soul/standard", { prompt: "x" });
    expect(r.ok === false && r.reason).toBe("vendor_error");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("does NOT alarm on a credential rejection — different remedy, different signal", async () => {
    mockResponse(401, '{"detail":"Invalid or expired token"}');
    const r = await submitGeneration("/higgsfield-ai/soul/standard", { prompt: "x" });
    expect(r.ok === false && r.reason).toBe("credential_rejected");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("pollGenerationOnce — a wallet that drains mid-job is still a wallet", () => {
  const OLD = process.env.HIGGSFIELD_API_KEY;
  beforeEach(() => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (OLD === undefined) delete process.env.HIGGSFIELD_API_KEY;
    else process.env.HIGGSFIELD_API_KEY = OLD;
  });

  it("classifies a terminal 403 on the poll path too", async () => {
    mockResponse(403, CREDITS_BODY);
    const r = await pollGenerationOnce("req_123");
    expect(r.ok).toBe(false);
    expect("reason" in r && r.reason).toBe("vendor_wallet_exhausted");
  });

  it("keeps a 429 transient rather than terminal", async () => {
    mockResponse(429, "slow down");
    const r = await pollGenerationOnce("req_123");
    expect(r.ok).toBe(false);
    expect("pending" in r && r.pending).toBe(true);
  });
});

describe("naming — must not collide with the customer-facing credit code", () => {
  it("never reuses the token the 402 responses use for a CUSTOMER's Zavi balance", () => {
    const reason = classifyGenerationFailure(403, '{"detail":"not_enough_credits"}');
    expect(reason).toBe("vendor_wallet_exhausted");
    expect(reason).not.toBe("insufficient_credits");
  });
});

describe("an exhausted vendor wallet is run-wide, not a per-beat blip", () => {
  it("is classified alongside the other conditions no retry can fix", () => {
    const RUN_WIDE = new Set(["credential_rejected", "not_configured", "vendor_wallet_exhausted"]);
    expect(RUN_WIDE.has(classifyGenerationFailure(403, '{"detail":"not_enough_credits"}'))).toBe(true);
    expect(RUN_WIDE.has(classifyGenerationFailure(500, "upstream boom"))).toBe(false);
  });
});
