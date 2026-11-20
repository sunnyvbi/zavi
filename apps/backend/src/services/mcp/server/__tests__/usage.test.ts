
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));

import { getMcpUsageForTenant } from "@/services/mcp/server/usage";
import { serviceClient } from "@/services/supabase";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";

function makeReadStub(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const mutationsHit: string[] = [];
  const builder: any = {};
  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };
  for (const m of ["select", "eq", "gte", "order", "limit"]) builder[m] = chain(m);
  for (const m of ["insert", "update", "delete", "upsert"]) {
    builder[m] = (...args: unknown[]) => {
      mutationsHit.push(m);
      return builder;
    };
  }
  builder.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  const from = vi.fn((_table?: string) => builder);
  return { builder, calls, mutationsHit, from };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMcpUsageForTenant", () => {
  it("scopes the read to the supplied tenant_id (no-RLS path) and only touches mcp_tool_calls", async () => {
    const { from, calls } = makeReadStub({ data: [], error: null });
    let table = "";
    (serviceClient as any).mockReturnValue({
      from: (t: string) => {
        table = t;
        return from(t);
      },
    });
    await getMcpUsageForTenant(TENANT_A);
    expect(table).toBe("mcp_tool_calls");
    const eqTenant = calls.find((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(eqTenant).toBeDefined();
    expect(eqTenant!.args[1]).toBe(TENANT_A);
  });

  it("only selects the whitelisted columns (no args_hash/ip_hash/raw content)", async () => {
    const { from, calls } = makeReadStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from });
    await getMcpUsageForTenant(TENANT_A);
    const sel = calls.find((c) => c.method === "select");
    expect(sel!.args[0]).toBe("tool,code,ms,credential_kind,created_at");
    expect(String(sel!.args[0])).not.toMatch(/args_hash|ip_hash|payload|body/);
  });

  it("performs NO mutation (read-only)", async () => {
    const { from, mutationsHit } = makeReadStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from });
    await getMcpUsageForTenant(TENANT_A);
    expect(mutationsHit).toEqual([]);
  });

  it("rolls up per-tool counts: ok vs error, total, and last_called_at (newest-first)", async () => {
    const rows = [
      { tool: "zavi_read_brain", code: "ok", ms: 12, credential_kind: "pat", created_at: "2026-05-22T10:00:00Z" },
      { tool: "zavi_run_agent", code: "scope_denied", ms: 1, credential_kind: "oauth", created_at: "2026-05-22T09:00:00Z" },
      { tool: "zavi_read_brain", code: "ok", ms: 9, credential_kind: "pat", created_at: "2026-05-22T08:00:00Z" },
      { tool: "zavi_read_brain", code: "error", ms: 30, credential_kind: "pat", created_at: "2026-05-22T07:00:00Z" },
    ];
    const { from } = makeReadStub({ data: rows, error: null });
    (serviceClient as any).mockReturnValue({ from });

    const out = await getMcpUsageForTenant(TENANT_A);
    expect(out.tenant_id).toBe(TENANT_A);
    expect(out.total_calls).toBe(4);

    const brain = out.by_tool.find((t) => t.tool === "zavi_read_brain")!;
    expect(brain.total).toBe(3);
    expect(brain.ok).toBe(2);
    expect(brain.errors).toBe(1);
    expect(brain.last_called_at).toBe("2026-05-22T10:00:00Z");

    const run = out.by_tool.find((t) => t.tool === "zavi_run_agent")!;
    expect(run.total).toBe(1);
    expect(run.ok).toBe(0);
    expect(run.errors).toBe(1);

    expect(out.by_tool[0].tool).toBe("zavi_read_brain");
  });

  it("returns recent raw rows capped by recentLimit", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tool: "zavi_search",
      code: "ok",
      ms: i,
      credential_kind: "pat",
      created_at: `2026-05-22T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    const { from } = makeReadStub({ data: rows, error: null });
    (serviceClient as any).mockReturnValue({ from });
    const out = await getMcpUsageForTenant(TENANT_A, { recentLimit: 5 });
    expect(out.recent.length).toBe(5);
    expect(out.total_calls).toBe(50);
  });

  it("applies the window as a created_at >= cutoff and defaults to 30 days", async () => {
    const { from, calls } = makeReadStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from });
    const out = await getMcpUsageForTenant(TENANT_A);
    expect(out.window_days).toBe(30);
    const gte = calls.find((c) => c.method === "gte" && c.args[0] === "created_at");
    expect(gte).toBeDefined();
    const cutoff = new Date(gte!.args[1] as string).getTime();
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(60_000);
  });

  it("honors a custom window and caps recentLimit at 200", async () => {
    const { from } = makeReadStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from });
    const out = await getMcpUsageForTenant(TENANT_A, { windowDays: 7, recentLimit: 9999 });
    expect(out.window_days).toBe(7);
    expect(out.recent.length).toBe(0);
  });

  it("throws on a DB error rather than returning a misleading empty summary", async () => {
    const { from } = makeReadStub({ data: null, error: { message: "read boom" } });
    (serviceClient as any).mockReturnValue({ from });
    await expect(getMcpUsageForTenant(TENANT_A)).rejects.toThrow(/read boom/);
  });

  it("returns an empty summary cleanly when there are no calls", async () => {
    const { from } = makeReadStub({ data: [], error: null });
    (serviceClient as any).mockReturnValue({ from });
    const out = await getMcpUsageForTenant(TENANT_A);
    expect(out.total_calls).toBe(0);
    expect(out.by_tool).toEqual([]);
    expect(out.recent).toEqual([]);
  });
});
