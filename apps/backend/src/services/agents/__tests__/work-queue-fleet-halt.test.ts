import { describe, it, expect, vi, beforeEach } from "vitest";

const isFleetHalted = vi.fn();
const rpc = vi.fn();
const serviceClient = vi.fn();
const serverClientFromBearer = vi.fn();

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHalted(),
  FleetHaltedError: class FleetHaltedError extends Error {
    code = "fleet_halted";
    constructor() {
      super("fleet halt active");
      this.name = "FleetHaltedError";
    }
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClient(),
  serverClientFromBearer: (...a: unknown[]) => serverClientFromBearer(...a),
}));

import { enqueueWorkItem } from "../work-queue";

beforeEach(() => {
  isFleetHalted.mockReset();
  rpc.mockReset();
  serviceClient.mockReset();
  serverClientFromBearer.mockReset();
  serviceClient.mockReturnValue({ rpc });
  rpc.mockResolvedValue({ data: "wi-123", error: null });
});

describe("enqueueWorkItem fleet-halt gate", () => {
  it("rejects enqueue for tenant A when halted (RPC never called)", async () => {
    isFleetHalted.mockResolvedValue(true);
    await expect(
      enqueueWorkItem({ tenant_id: "tenant-A", agent_slug: "operator", source: "cron" }),
    ).rejects.toThrow(/fleet halt/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects enqueue for a DIFFERENT tenant B when halted (cross-tenant)", async () => {
    isFleetHalted.mockResolvedValue(true);
    await expect(
      enqueueWorkItem({ tenant_id: "tenant-B", agent_slug: "engineer", source: "webhook_github" }),
    ).rejects.toThrow(/fleet halt/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proceeds to the enqueue RPC when NOT halted (cleared → succeeds)", async () => {
    isFleetHalted.mockResolvedValue(false);
    const out = await enqueueWorkItem({
      tenant_id: "tenant-A",
      agent_slug: "operator",
      source: "cron",
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_work_item", expect.objectContaining({
      p_tenant_id: "tenant-A",
      p_agent_slug: "operator",
      p_source: "cron",
    }));
    expect(out).toEqual({ work_item_id: "wi-123" });
  });

  it("FAIL-SAFE: a halted (true-on-error) verdict blocks the enqueue", async () => {
    isFleetHalted.mockResolvedValue(true);
    await expect(
      enqueueWorkItem({ tenant_id: "tenant-A", agent_slug: "qa", source: "a2a" }),
    ).rejects.toThrow(/fleet halt/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
