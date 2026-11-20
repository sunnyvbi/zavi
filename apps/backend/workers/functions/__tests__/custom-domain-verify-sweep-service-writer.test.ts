import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  fn: null as null | ((ctx: unknown) => Promise<unknown>),
  rows: [] as Row[],
  serviceRpc: vi.fn(),
  bearerRpc: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, fn: (ctx: unknown) => Promise<unknown>) => {
      h.fn = fn;
      return fn;
    },
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "in", "or", "eq", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: null });
      q.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: table === "tenant_custom_domains" ? h.rows : [], error: null });
      return q;
    },
    rpc: (...a: unknown[]) => h.serviceRpc(...a),
  }),
  serverClientFromBearer: () => ({ rpc: (...a: unknown[]) => h.bearerRpc(...a) }),
}));
vi.mock("@/services/provisioning/render-custom-domain", () => ({
  getRenderCustomDomainStatus: (...a: unknown[]) => h.status(...a),
  verifyRenderCustomDomain: vi.fn(),
}));
vi.mock("@/services/provisioning/cloudflare-dns", () => ({ ensureDnsCname: vi.fn() }));
vi.mock("@/services/provisioning/builtin-url", () => ({ builtinBaseDomain: () => "zaviagent.app" }));
vi.mock("@/services/provisioning/builtin-domain-heal", () => ({ advanceBuiltinDomain: vi.fn() }));

import "../custom-domain-verify-sweep";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("custom-domain-verify-sweep writes verified/verifying as service role", () => {
  beforeEach(() => {
    delete process.env.PRAXIS_CUSTOM_DOMAIN_SWEEP_ENABLED;
    h.serviceRpc.mockReset().mockResolvedValue({ data: null, error: null });
    h.bearerRpc.mockReset();
    h.rows = [
      { id: "dom-v", render_service_id: "srv", render_custom_domain_id: "cd-v", hostname: "a.acme.com", status: "verifying", attempts: 0 },
      { id: "dom-p", render_service_id: "srv", render_custom_domain_id: "cd-p", hostname: "b.acme.com", status: "dns_required", attempts: 0 },
    ];
    h.status.mockImplementation(async (_s: string, id: string) => (id === "cd-v" ? "verified" : "pending"));
  });

  it("marks verified and verifying rows through the service client only", async () => {
    await h.fn!({ logger });
    const writes = h.serviceRpc.mock.calls.filter((c) => c[0] === "set_tenant_custom_domain_state");
    expect(writes).toEqual([
      ["set_tenant_custom_domain_state", expect.objectContaining({ p_id: "dom-v", p_status: "verified" })],
      ["set_tenant_custom_domain_state", expect.objectContaining({ p_id: "dom-p", p_status: "verifying", p_attempts: 1 })],
    ]);
    expect(h.bearerRpc).not.toHaveBeenCalled();
  });
});
