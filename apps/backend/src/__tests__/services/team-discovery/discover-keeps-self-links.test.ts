import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  discovered: [] as unknown[],
  usersList: [] as unknown[],
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" | "insert" | "delete" = "select";
  let payload: Row = {};
  let order: string | null = null;
  const rows = () => (h.db[table] ??= []);
  const run = () => {
    if (op === "insert") {
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, created_at: new Date().toISOString(), ...payload };
      rows().push(row);
      return [row];
    }
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (op === "update") hit.forEach((r) => Object.assign(r, payload));
    if (op === "delete") h.db[table] = rows().filter((r) => !hit.includes(r));
    if (order) hit.sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
    return hit;
  };
  const q = {
    select: () => q,
    update: (p: Row) => ((op = "update"), (payload = p), q),
    insert: (p: Row) => ((op = "insert"), (payload = p), q),
    delete: () => ((op = "delete"), q),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    order: (c: string) => ((order = c), q),
    single: async () => {
      const r = run();
      return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: "not single" } };
    },
    maybeSingle: async () => {
      const r = run();
      return r.length > 1 ? { data: null, error: { message: "multiple" } } : { data: r[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => void) => res({ data: run(), error: null }),
  };
  return q;
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: query }) }));
vi.mock("../../../../workers/client", () => ({
  inngest: { createFunction: (_a: unknown, _b: unknown, handler: unknown) => ({ handler }) },
}));
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: async () => ({ members: h.usersList, response_metadata: { next_cursor: "" } }),
}));

import { teamDiscoverFn } from "../../../../workers/functions/team-discover";
import { discoverSlackMembers } from "@/services/team-discovery/slack";

const T = "11111111-1111-4111-8111-111111111111";
const logger = { info: () => {}, warn: () => {} };
type Handler = (a: { event: { data: { job_id: string } }; logger: typeof logger }) => Promise<unknown>;

beforeEach(() => {
  h.db = {
    team_discover_jobs: [{ id: "job1", tenant_id: T, status: "queued", providers: ["slack"] }],
    slack_workspaces: [{ tenant_id: T, team_id: "T_ACME" }],
    team_members: [
      { id: "m_ana", tenant_id: T, display_name: "Ana", primary_email: "ana@acme.com", status: "active", created_at: "2026-01-01" },
      { id: "m_founder", tenant_id: T, display_name: "Founder", primary_email: "founder@acme.com", status: "active", created_at: "2026-02-01" },
    ],
    team_member_identities: [
      { id: "i1", tenant_id: T, member_id: "m_founder", provider: "slack", external_id: "U_X", team_id: "T_ACME", source: "oauth_self" },
    ],
  };
});

describe("Discover team keeps self-linked identities", () => {
  it("must-not: a discovery cluster that matches another member never re-parents an oauth_self identity", async () => {
    h.usersList = [{ id: "U_X", profile: { real_name: "Ana", email: "ana@acme.com" } }];
    await (teamDiscoverFn as unknown as { handler: Handler }).handler({ event: { data: { job_id: "job1" } }, logger });
    const idn = h.db.team_member_identities.find((r) => r.external_id === "U_X")!;
    expect(idn.member_id).toBe("m_founder");
    expect(idn.source).toBe("oauth_self");
    expect(h.db.team_member_identities.filter((r) => r.external_id === "U_X")).toHaveLength(1);
  });

  it("an 'auto' identity is still updated by discovery as before", async () => {
    h.db.team_member_identities[0].source = "auto";
    h.usersList = [{ id: "U_X", profile: { real_name: "Founder", email: "founder@acme.com" } }];
    await (teamDiscoverFn as unknown as { handler: Handler }).handler({ event: { data: { job_id: "job1" } }, logger });
    const idn = h.db.team_member_identities.find((r) => r.external_id === "U_X")!;
    expect(idn.external_email).toBe("founder@acme.com");
  });
});

describe("Slack discovery skips guests", () => {
  it("must-not: restricted and ultra-restricted users are not imported; full members are", async () => {
    h.usersList = [
      { id: "U_MEMBER", profile: { email: "m@acme.com" } },
      { id: "U_GUEST", is_restricted: true, profile: { email: "g@vendor.com" } },
      { id: "U_SCG", is_ultra_restricted: true, profile: { email: "s@vendor.com" } },
      { id: "U_GONE", deleted: true },
    ];
    const out = await discoverSlackMembers(T, "T_ACME");
    expect(out.map((i) => i.external_id)).toEqual(["U_MEMBER"]);
  });
});
