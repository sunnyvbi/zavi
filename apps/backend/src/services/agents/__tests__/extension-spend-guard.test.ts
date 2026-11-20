import { describe, it, expect, vi, beforeEach } from "vitest";

const headSelect = vi.fn();
const fromTables: string[] = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (t: string) => {
      fromTables.push(t);
      return { select: headSelect };
    },
  }),
}));

import {
  isExtensionChatTurn,
  checkExtensionDailyCap,
  checkExtensionScreenshotDailyCap,
  DEFAULT_EXTENSION_DAILY_CAP,
} from "@/services/agents/extension-spend-guard";
import type { Request } from "express";

function mockCount(result: { count?: number | null; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "gte"]) chain[m] = () => chain;
  Object.assign(chain, { then: undefined, ...result });
  headSelect.mockReturnValue(
    Object.assign(chain, {
      then: (res: (v: unknown) => unknown) => res(result),
    }),
  );
}

beforeEach(() => headSelect.mockReset());

describe("isExtensionChatTurn", () => {
  const asReq = (body: unknown) => ({ body }) as unknown as Request;

  it("is true only when the turn carries a page capture", () => {
    expect(isExtensionChatTurn(asReq({ page_context: { url: "x" } }))).toBe(true);
  });

  it("leaves ordinary chat alone, so a fast typist is never throttled", () => {
    expect(isExtensionChatTurn(asReq({ message: "hi" }))).toBe(false);
    expect(isExtensionChatTurn(asReq({}))).toBe(false);
    expect(isExtensionChatTurn(asReq(undefined))).toBe(false);
  });
});

describe("checkExtensionDailyCap", () => {
  it("allows a tenant under the cap", async () => {
    mockCount({ count: 3, error: null });
    const v = await checkExtensionDailyCap("t1", 50);
    expect(v.allowed).toBe(true);
    expect(v.used).toBe(3);
  });

  it("blocks at the cap, not one over it", async () => {
    mockCount({ count: 50, error: null });
    expect((await checkExtensionDailyCap("t1", 50)).allowed).toBe(false);
  });

  it("FAILS OPEN on a read error — a DB blip must not cost every user their turn", async () => {
    mockCount({ count: null, error: { message: "boom" } });
    expect((await checkExtensionDailyCap("t1", 50)).allowed).toBe(true);
  });

  it("sits above what the free daily credit grant funds, so it is a runaway bound not a product limit", () => {
    expect(DEFAULT_EXTENSION_DAILY_CAP).toBeGreaterThan(Math.floor(5000 / 340));
  });
});

describe("checkExtensionScreenshotDailyCap", () => {
  it("counts today's ledger rows WITHOUT a deleted_at filter (revoke cannot reset the day)", async () => {
    fromTables.length = 0;
    const calls: string[] = [];
    const eqArgs: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const mth of ["eq", "gte", "is", "not"]) {
      chain[mth] = (...a: unknown[]) => {
        calls.push(`${mth}:${String(a[0])}`);
        if (mth === "eq") eqArgs.push(a);
        return chain;
      };
    }
    chain.then = (res: (v: unknown) => unknown) => res({ count: 50, error: null });
    headSelect.mockReturnValue(chain);

    const v = await checkExtensionScreenshotDailyCap("t1", 50);
    expect(v.allowed).toBe(false);
    expect(fromTables).toEqual(["extension_screenshots"]);
    expect(calls).toEqual(["eq:kind", "gte:created_at"]);
    expect(eqArgs).toEqual([["kind", "turn"]]);
    expect(calls.some((c) => c.includes("deleted_at"))).toBe(false);
  });

  it("allows under the cap and FAILS OPEN on a read error", async () => {
    mockCount({ count: 49, error: null });
    expect((await checkExtensionScreenshotDailyCap("t1", 50)).allowed).toBe(true);
    mockCount({ count: null, error: { message: "boom" } });
    expect((await checkExtensionScreenshotDailyCap("t1", 50)).allowed).toBe(true);
  });
});
