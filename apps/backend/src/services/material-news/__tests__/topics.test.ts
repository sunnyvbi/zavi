
import { describe, it, expect, vi, beforeEach } from "vitest";

let anchorRows: Array<Record<string, unknown>> = [];
const hh = vi.hoisted(() => ({ llmText: "" }));
function awaitable<T>(value: T) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "limit", "maybeSingle", "gte", "lt", "in", "upsert", "insert", "delete", "update"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: T) => unknown) => resolve(value);
  return chain;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantClient: () => ({ from: vi.fn(() => awaitable({ data: anchorRows, error: null })) }),
  globalClient: () => ({ from: vi.fn(() => awaitable({ data: null, error: null })) }),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({
    messages: {
      create: vi.fn(async () => ({ content: [{ type: "text", text: hh.llmText }] })),
    },
  }),
  heliconePropertyHeaders: () => ({}),
}));

import { isPublicSafeTerm, getOrRefreshTopics, verifyPublicTerms } from "../topics";

describe("isPublicSafeTerm — PII/secret boundary", () => {
  it("accepts plain public category / competitor terms", () => {
    for (const t of ["P2P car rental", "Turo competitor", "DMV regulation", "used car marketplace"]) {
      expect(isPublicSafeTerm(t)).toBe(true);
    }
  });

  it("REJECTS anything with a digit (metrics / counts / money / %)", () => {
    for (const t of ["600 hosts", "$100k GMV", "revenue up 30%", "tenant 73db45ff"]) {
      expect(isPublicSafeTerm(t)).toBe(false);
    }
  });

  it("REJECTS emails, phones, handles, urls", () => {
    for (const t of ["ravi@upcar.ai", "call +1 415 555 1212", "@upcarofficial", "https://x.com/y"]) {
      expect(isPublicSafeTerm(t)).toBe(false);
    }
  });

  it("REJECTS secret-shaped tokens", () => {
    expect(isPublicSafeTerm("sk-ant-api03-abcDEF123456ghiJKL7890mnoPQR")).toBe(false);
  });

  it("REJECTS empty / too-long junk", () => {
    expect(isPublicSafeTerm(" ")).toBe(false);
    expect(isPublicSafeTerm("x".repeat(80))).toBe(false);
  });
});

describe("verifyPublicTerms — private-name backstop (2nd pass)", () => {
  it("keeps only terms the verifier confirms public; drops a private codename", async () => {
    hh.llmText = JSON.stringify({ public: ["p2p car rental"] });
    const out = await verifyPublicTerms("t", ["p2p car rental", "StealthBank"]);
    expect(out).toEqual(["p2p car rental"]);
  });

  it("cannot let the verifier INVENT a term not in the input set", async () => {
    hh.llmText = JSON.stringify({ public: ["p2p car rental", "SecretCustomerCorp"] });
    const out = await verifyPublicTerms("t", ["p2p car rental"]);
    expect(out).toEqual(["p2p car rental"]);
  });

  it("FAILS CLOSED to null on a malformed verifier response (never egress unverified)", async () => {
    hh.llmText = "not json at all";
    const out = await verifyPublicTerms("t", ["p2p car rental"]);
    expect(out).toBeNull();
  });
});

describe("getOrRefreshTopics — thin brain", () => {
  beforeEach(() => {
    anchorRows = [];
  });

  it("returns null when the tenant has fewer than 2 anchors (no search)", async () => {
    const out = await getOrRefreshTopics("11111111-1111-4111-8111-111111111111", [
      { id: "a1", title: "one", body: "x", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(out).toBeNull();
  });
});
