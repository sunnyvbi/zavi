import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
  }),
}));

import { tenantRpc, asTenantId } from "@/services/tenant-client";

const TENANT = asTenantId("22222222-2222-4222-8222-222222222222");

beforeEach(() => {
  h.rpcCalls = [];
});

describe("the mention-alert RPCs the send path calls", () => {
  it("are registered, and the tenant is injected rather than trusted from the caller", async () => {
    await tenantRpc(TENANT, "claim_mention_alert_send", { p_send_day: "2026-09-22" });
    await tenantRpc(TENANT, "mark_mention_alert_sent", { p_id: "d1", p_status: "sent" });
    expect(h.rpcCalls).toEqual([
      {
        name: "claim_mention_alert_send",
        args: { p_send_day: "2026-09-22", p_tenant_id: TENANT },
      },
      {
        name: "mark_mention_alert_sent",
        args: { p_id: "d1", p_status: "sent", p_tenant_id: TENANT },
      },
    ]);
  });

  it("refuse a tenant the caller tried to supply for itself", () => {
    expect(() =>
      tenantRpc(TENANT, "claim_mention_alert_send", {
        p_send_day: "2026-09-22",
        p_tenant_id: "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow(/!= scope/);
    expect(h.rpcCalls).toEqual([]);
  });

  it("is a registry, not a pass-through — an unregistered name never reaches the database", () => {
    expect(() => tenantRpc(TENANT, "claim_mention_alert_sendd", {})).toThrow(
      /not in the tenant-RPC registry/,
    );
    expect(h.rpcCalls).toEqual([]);
  });
});
