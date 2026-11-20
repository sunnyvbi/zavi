
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>> }));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const run = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
  };
  return b;
}
const client = { from: (t: string) => query(t) } as unknown as SupabaseClient;

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => query(t) }) }));

import { canUserAccessAgent, canUserAccessAgentRun } from "../members";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MEMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SLUG = "c-abc123def0";
const RUN_A = "33333333-3333-4333-8333-333333333333";
const MEMBER_A2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_A_BY_TEAMMATE = "55555555-5555-4555-8555-555555555555";
const RUN_BUILTIN_BY_TEAMMATE = "66666666-6666-4666-8666-666666666666";
const RUN_A_OTHER = "44444444-4444-4444-8444-444444444444";
const OTHER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

beforeEach(() => {
  db.tables = {
    tenant_users: [
      { tenant_id: A, user_id: MEMBER_A, role: "member" },
      { tenant_id: A, user_id: VIEWER_A, role: "viewer" },
      { tenant_id: B, user_id: MEMBER_B, role: "member" },
      { tenant_id: A, user_id: MEMBER_A2, role: "member" },
    ],
    tenant_member_agents: [
      { tenant_id: A, user_id: MEMBER_A, agent_slug: "research" },
      { tenant_id: A, user_id: MEMBER_A2, agent_slug: "research" },
    ],
    custom_agents: [{ tenant_id: A, slug: SLUG, status: "active", test_run_id: null }],
    agent_runs: [
      { id: RUN_A, tenant_id: A, agent_slug: SLUG, enqueued_by: MEMBER_A },
      { id: RUN_A_OTHER, tenant_id: A, agent_slug: "operator", enqueued_by: OTHER_A },
      { id: RUN_A_BY_TEAMMATE, tenant_id: A, agent_slug: SLUG, enqueued_by: MEMBER_A2 },
      { id: RUN_BUILTIN_BY_TEAMMATE, tenant_id: A, agent_slug: "research", enqueued_by: MEMBER_A2 },
    ],
  };
});

describe("same tenant", () => {
  it("a member uses every agent, built-in or custom, with no per-agent list", async () => {
    for (const slug of ["research", "operator", SLUG]) {
      expect(await canUserAccessAgent(client, MEMBER_A, A, slug), slug).toBe(true);
    }
  });

  it("a member reads every run in the tenant, including a teammate's", async () => {
    expect(await canUserAccessAgentRun(client, MEMBER_A, RUN_A)).toBe(true);
    expect(await canUserAccessAgentRun(client, MEMBER_A, RUN_A_OTHER)).toBe(true);
  });

  it("a viewer reads but never uses", async () => {
    expect(await canUserAccessAgent(client, VIEWER_A, A, "operator")).toBe(false);
    expect(await canUserAccessAgent(client, VIEWER_A, A, "operator", { read: true })).toBe(true);
    expect(await canUserAccessAgentRun(client, VIEWER_A, RUN_A_OTHER)).toBe(true);
  });

  it("an unknown role gets nothing (fail-closed)", async () => {
    db.tables.tenant_users.push({ tenant_id: A, user_id: OTHER_A, role: "guest" });
    expect(await canUserAccessAgent(client, OTHER_A, A, "operator", { read: true })).toBe(false);
    expect(await canUserAccessAgentRun(client, OTHER_A, RUN_A)).toBe(false);
  });
});

describe("a teammate's run (decision 18, read only)", () => {
  it("any member may read another member's manual / Test run of a custom agent, in any status", async () => {
    for (const status of ["active", "paused", "archived"]) {
      db.tables.custom_agents = [{ tenant_id: A, slug: SLUG, status, test_run_id: null }];
      expect(await canUserAccessAgentRun(client, MEMBER_A, RUN_A_BY_TEAMMATE, { read: true }), status).toBe(true);
    }
  });

  it("a member of another tenant still cannot read it", async () => {
    expect(await canUserAccessAgentRun(client, MEMBER_B, RUN_A_BY_TEAMMATE, { read: true })).toBe(false);
  });
});

describe("cross-tenant", () => {
  it("a member of tenant B cannot use tenant A's agents or read A's runs", async () => {
    expect(await canUserAccessAgent(client, MEMBER_B, A, SLUG)).toBe(false);
    expect(await canUserAccessAgent(client, MEMBER_B, A, "operator", { read: true })).toBe(false);
    expect(await canUserAccessAgentRun(client, MEMBER_B, RUN_A)).toBe(false);
    expect(await canUserAccessAgentRun(client, MEMBER_B, RUN_A_OTHER)).toBe(false);
  });

  it("a run id that does not exist is not readable", async () => {
    expect(await canUserAccessAgentRun(client, MEMBER_A, "99999999-9999-4999-8999-999999999999")).toBe(false);
  });
});
