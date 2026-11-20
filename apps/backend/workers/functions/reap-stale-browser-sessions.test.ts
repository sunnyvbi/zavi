import { beforeEach, describe, expect, it, vi } from "vitest";

const del = vi.fn();
const close = vi.fn();
const rows = [
  { id: "a", provider_session_id: "pa" },
  { id: "b", provider_session_id: "pb" },
];

vi.mock("../client", () => ({ inngest: { createFunction: (_c: unknown, _t: unknown, fn: unknown) => fn } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/sandbox/browser-mcp/browser-sessions", () => ({ closeBrowserSession: (...a: unknown[]) => close(...a) }));
vi.mock("@/services/sandbox/browser-mcp/anchor-rest-client", () => ({ deleteAnchorSessionById: (...a: unknown[]) => del(...a) }));
vi.mock("@/services/supabase", () => {
  const q = { select: () => q, eq: () => q, lt: () => q, limit: async () => ({ data: rows, error: null }) };
  return { serviceClient: () => ({ from: () => q }) };
});

describe("reap-stale-browser-sessions", () => {
  beforeEach(() => {
    del.mockReset();
    close.mockReset();
    process.env.ANCHOR_API_KEY = "k";
  });

  it("keeps the row open when Anchor's DELETE fails, so the next sweep retries it", async () => {
    del.mockImplementation(async (_k: string, id: string) => id === "pb");
    const { reapStaleBrowserSessionsFn } = await import("./reap-stale-browser-sessions");
    const out = await (reapStaleBrowserSessionsFn as unknown as (a: { logger: unknown }) => Promise<{ removed: number; batch_errors: number }>)({
      logger: { error: vi.fn() },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ session_id: "b", reason: "reaped_stale" });
    expect(out).toMatchObject({ removed: 1, batch_errors: 1 });
  });
});
