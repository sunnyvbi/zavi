import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({ rpcArgs: [] as unknown[], rows: [] as unknown[] }));
vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: (req: Request) => {
    if (!(req as { staff?: unknown }).staff) throw new Error("not staff");
    return (req as { staff?: unknown }).staff;
  },
}));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    rpc: async (_n: string, args: unknown) => {
      h.rpcArgs.push(args);
      return { data: h.rows, error: null };
    },
  }),
}));

import { shapeWriteMetrics, staffMemoryWriteMetrics } from "../memory-write-metrics";

describe("memory write metrics", () => {
  it("turns counts into the plan's rates", () => {
    const m = shapeWriteMetrics({
      tenant_id: "t",
      added: 6, duplicate: 3, updated: 1, conflict: 0, rejected: 2, junk: 2,
      cleanup_superseded: 4, restored: 1, update_undone: 1, forgets: 2, forget_undone: 1,
    });
    expect(m.paraphrase_duplicate_rate).toBe(0.3);
    expect(m.skip_rate).toBe(0.5);
    expect(m.reject_rate).toBe(0.286);
    expect(m.update_reversal_rate).toBe(1);
    expect(m.forget_undo_rate).toBe(0.5);
  });

  it("staff only; clamps days", async () => {
    h.rows = [];
    const res = { json: vi.fn(), status: vi.fn(() => res) } as unknown as Response;
    await expect(staffMemoryWriteMetrics({ query: {} } as unknown as Request, res)).rejects.toThrow(/not staff/);
    await staffMemoryWriteMetrics({ query: { days: "999" }, staff: {} } as unknown as Request, res);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ days: 90, workspaces: [] });
  });
});
