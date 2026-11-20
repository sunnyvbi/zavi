import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));

import {
  upsertProspect,
  enrollProspect,
  claimDueProspects,
  advanceProspect,
  stopProspect,
} from "../prospectStore";
import { serviceClient } from "@/services/supabase";

describe("prospectStore RPC wrappers", () => {
  let rpcMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rpcMock = vi.fn();
    (serviceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      rpc: rpcMock,
    });
  });

  it("upsertProspect: fresh insert reports inserted=true", async () => {
    rpcMock.mockResolvedValue({
      data: { id: "p1", inserted: true, dedupe_key: "email:a@b.com" },
      error: null,
    });
    const res = await upsertProspect("t1", "email", "A@B.com", { source: "research" });
    expect(res.inserted).toBe(true);
    expect(res.id).toBe("p1");
    expect(rpcMock).toHaveBeenCalledWith(
      "upsert_outbound_prospect",
      expect.objectContaining({
        p_tenant_id: "t1",
        p_channel: "email",
        p_handle: "A@B.com",
        p_source: "research",
      }),
    );
  });

  it("upsertProspect: duplicate handle reports inserted=false (dedupe)", async () => {
    rpcMock.mockResolvedValue({
      data: { id: "p1", inserted: false, dedupe_key: "email:a@b.com" },
      error: null,
    });
    const res = await upsertProspect("t1", "email", "a@b.com");
    expect(res.inserted).toBe(false);
    expect(res.id).toBe("p1");
  });

  it("upsertProspect: throws on RPC error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(upsertProspect("t1", "email", "a@b.com")).rejects.toThrow(/boom/);
  });

  it("enrollProspect: returns ok", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
    const res = await enrollProspect("t1", "p1", "s1");
    expect(res.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("enroll_outbound_prospect", {
      p_tenant_id: "t1",
      p_prospect_id: "p1",
      p_sequence_id: "s1",
    });
  });

  it("claimDueProspects: returns rows (empty default)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const res = await claimDueProspects(10);
    expect(res).toEqual([]);
    expect(rpcMock).toHaveBeenCalledWith("claim_due_outbound_prospects", { p_limit: 10 });
  });

  it("advanceProspect: surfaces completed flag", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, completed: true, step: 3 }, error: null });
    const res = await advanceProspect("t1", "p1");
    expect(res.completed).toBe(true);
    expect(res.step).toBe(3);
  });

  it("stopProspect: unsubscribed", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, reason: "unsubscribed" }, error: null });
    const res = await stopProspect("t1", "p1", "unsubscribed");
    expect(res.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("stop_outbound_prospect", {
      p_tenant_id: "t1",
      p_prospect_id: "p1",
      p_reason: "unsubscribed",
    });
  });

  it("stopProspect: throws on RPC error (fail loud)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(stopProspect("t1", "p1", "replied")).rejects.toThrow(/db down/);
  });
});
