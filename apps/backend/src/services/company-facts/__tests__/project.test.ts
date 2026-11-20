import { describe, expect, it, vi } from "vitest";
import { projectCompanyFact } from "../write";

function sbWith(result: { data: unknown; error: { message: string } | null }) {
  return { rpc: vi.fn(async (_name: string, _args: Record<string, unknown>) => result) };
}

describe("projectCompanyFact", () => {
  it("calls project_tenant_fact with the normalized value and reports written", async () => {
    const sb = sbWith({ data: true, error: null });
    const r = await projectCompanyFact(sb, "t1", "what_we_sell", "  P2P car rental  ", "staff_reviewed", "ref");
    expect(r).toEqual({ written: true, error: null });
    expect(sb.rpc).toHaveBeenCalledWith("project_tenant_fact", {
      p_tenant_id: "t1",
      p_key: "what_we_sell",
      p_value_text: "P2P car rental",
      p_source: "staff_reviewed",
      p_source_ref: "ref",
    });
  });

  it("reports written:false when the RPC refuses because the incumbent outranks", async () => {
    const sb = sbWith({ data: false, error: null });
    const r = await projectCompanyFact(sb, "t1", "what_we_sell", "x", "ai_estimated", "ref");
    expect(r).toEqual({ written: false, error: null });
  });

  it("returns the error instead of throwing, so a projection never fails a publish", async () => {
    const sb = sbWith({ data: null, error: { message: "boom" } });
    const r = await projectCompanyFact(sb, "t1", "who_we_serve", "x", "ai_estimated", "ref");
    expect(r.written).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("skips an empty value without calling the RPC — absence must stay silent, not clear", async () => {
    const sb = sbWith({ data: true, error: null });
    const r = await projectCompanyFact(sb, "t1", "what_we_sell", "   ", "staff_reviewed", "ref");
    expect(r).toEqual({ written: false, error: null });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("refuses domain — it has exactly one validated writer", async () => {
    const sb = sbWith({ data: true, error: null });
    await expect(
      // @ts-expect-error domain is excluded from ProjectableFactKey; assert the runtime guard too
      projectCompanyFact(sb, "t1", "domain", "https://x.com", "staff_reviewed", "ref"),
    ).rejects.toThrow(/set_tenant_company_domain_system/);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("never writes an ai_estimated value under a staff_reviewed source", async () => {
    const sb = sbWith({ data: true, error: null });
    await projectCompanyFact(sb, "t1", "who_we_serve", "busy professionals", "ai_estimated", "ref");
    const args = sb.rpc.mock.calls[0]![1] as { p_source: string };
    expect(args.p_source).toBe("ai_estimated");
  });
});
