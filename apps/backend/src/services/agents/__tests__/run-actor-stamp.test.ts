import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, string, unknown]>,
  rpc: vi.fn(async () => ({ data: null as unknown, error: null })),
}));

vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/logging/logEvent", async (orig) => ({
  ...(await orig<typeof import("@/services/logging/logEvent")>()),
  logEvent: async () => {},
}));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: (...a: unknown[]) => (m.rpc as (...x: unknown[]) => unknown)(...a),
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        m.filters.push([table, col, val]);
        return q;
      };
      q.maybeSingle = async () => ({ data: m.rows[table] ?? null, error: null });
      q.update = (patch: Record<string, unknown>) => {
        m.updates.push(patch);
        return { eq: async () => ({ error: null }) };
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { stampRunActor } from "../runner";

beforeEach(() => {
  m.rows = { agent_runs: { tenant_id: TENANT } };
  m.updates.length = 0;
  m.filters.length = 0;
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: null, error: null });
});

describe("stampRunActor", () => {
  it("a plugin/MCP run records the token's user once they are confirmed a member of the run's tenant", async () => {
    m.rows.tenant_users = { user_id: "user-mcp" };
    await stampRunActor(RUN, "mcp", {}, "user-mcp");
    expect(m.updates).toEqual([{ actor_user_id: "user-mcp", actor_source: "mcp" }]);
    expect(m.filters).toContainEqual(["tenant_users", "tenant_id", TENANT]);
  });

  it("a vouched user who is not a member of the run's tenant is never written", async () => {
    await stampRunActor(RUN, "mcp", {}, "outsider");
    expect(m.updates).toEqual([{ actor_source: "mcp" }]);
  });

  it("an email run from a verified member records that member", async () => {
    m.rows.email_messages = { direction: "in", sender_verified_member: true, from_address: "f@acme.com" };
    m.rpc.mockResolvedValue({ data: "user-email", error: null });
    await stampRunActor(RUN, "email", { email: { email_message_id: "msg-1" } });
    expect(m.updates).toEqual([{ actor_user_id: "user-email", actor_source: "email" }]);
  });

  it("a WhatsApp run records the member who bound the thread", async () => {
    m.rows.whatsapp_threads = { bound_by_user_id: "user-wa", status: "enabled" };
    m.rows.tenant_users = { user_id: "user-wa" };
    await stampRunActor(RUN, "whatsapp", { whatsapp: { phone_number_id: "pn", wa_id: "1555" } });
    expect(m.updates).toEqual([{ actor_user_id: "user-wa", actor_source: "whatsapp" }]);
  });

  it("a run with no person keeps the insert trigger's actor (a manual run's enqueuer is not nulled)", async () => {
    await stampRunActor(RUN, "manual", {});
    expect(m.updates).toEqual([{ actor_source: "manual" }]);
  });
});
