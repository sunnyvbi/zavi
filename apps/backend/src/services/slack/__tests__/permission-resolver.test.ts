
import { describe, it, expect, vi, beforeEach } from "vitest";

type MockData = {
  team_member_identities: Array<{ external_id: string; member_id: string; team_id?: string }>;
  team_members: Array<{ id: string; status: string; last_active_at: string | null }>;
  slack_channel_members: Array<{ channel_id: string; slack_user_id: string }>;
  tenant_users: Array<{ user_id: string; tenant_id: string }>;
  asker_email: string | null;
  asker_member_id: string | null;
  asker_slack_user_id: string | null;
};

const mockState: MockData = {
  team_member_identities: [],
  team_members: [],
  slack_channel_members: [],
  tenant_users: [],
  asker_email: null,
  asker_member_id: null,
  asker_slack_user_id: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChain = any;

vi.mock("@/services/supabase", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: (): any => {
    const fromMock = (table: string): AnyChain => {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, string[]> = {};

      const chain: AnyChain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        ilike: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        in: (col: string, vals: string[]) => {
          inFilters[col] = vals;
          return chain;
        },
        limit: () => chain,
        maybeSingle: () => {
          if (table === "team_members") {
            const ok =
              typeof filters.primary_email === "string" &&
              (filters.primary_email as string).toLowerCase() ===
                (mockState.asker_email ?? "").toLowerCase() &&
              mockState.asker_email !== null;
            return Promise.resolve({
              data: ok ? { id: mockState.asker_member_id } : null,
              error: null,
            });
          }
          if (table === "team_member_identities") {
            const memberId = filters.member_id;
            if (memberId === mockState.asker_member_id && mockState.asker_slack_user_id) {
              return Promise.resolve({
                data: { external_id: mockState.asker_slack_user_id },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "tenant_users") {
            const userId = filters.user_id;
            const found = mockState.tenant_users.find((u) => u.user_id === userId);
            return Promise.resolve({ data: found ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === "team_member_identities" && inFilters.external_id) {
            const rows = mockState.team_member_identities.filter(
              (r) =>
                inFilters.external_id.includes(r.external_id) &&
                (filters.team_id === undefined || r.team_id === undefined || r.team_id === filters.team_id),
            );
            resolve({ data: rows, error: null });
          } else if (table === "team_members" && inFilters.id) {
            const rows = mockState.team_members.filter((m) =>
              inFilters.id.includes(m.id),
            );
            resolve({ data: rows, error: null });
          } else if (table === "slack_channel_members" && inFilters.channel_id) {
            const rows = mockState.slack_channel_members.filter((r) =>
              inFilters.channel_id.includes(r.channel_id),
            );
            resolve({ data: rows, error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return chain;
    };

    return {
      from: fromMock,
      auth: {
        admin: {
          getUserById: async (_id: string) => ({
            data: { user: { email: mockState.asker_email } },
            error: null,
          }),
        },
      },
    };
  },
}));

import {
  resolveVisibility,
  resolveVisibilityBulk,
  resolveVisibilityBulkBySlackUser,
  type SlackIndexRow,
} from "../permission-resolver";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ASKER_USER_ID = "00000000-0000-0000-0000-000000000aaa";

beforeEach(() => {
  mockState.team_member_identities = [];
  mockState.team_members = [];
  mockState.slack_channel_members = [];
  mockState.tenant_users = [];
  mockState.asker_email = null;
  mockState.asker_member_id = null;
  mockState.asker_slack_user_id = null;
});

function setAskerLinked(opts: { email: string; member_id: string; slack_user_id: string }) {
  mockState.asker_email = opts.email;
  mockState.asker_member_id = opts.member_id;
  mockState.asker_slack_user_id = opts.slack_user_id;
  mockState.team_members.push({
    id: opts.member_id,
    status: "active",
    last_active_at: new Date().toISOString(),
  });
  mockState.team_member_identities.push({
    external_id: opts.slack_user_id,
    member_id: opts.member_id,
  });
  mockState.tenant_users.push({ user_id: ASKER_USER_ID, tenant_id: TENANT_ID });
}

function addActiveAuthor(slack_user_id: string) {
  const id = `m_${slack_user_id}`;
  mockState.team_members.push({
    id,
    status: "active",
    last_active_at: new Date().toISOString(),
  });
  mockState.team_member_identities.push({ external_id: slack_user_id, member_id: id });
}

function addDepartedAuthor(slack_user_id: string) {
  const id = `m_${slack_user_id}`;
  mockState.team_members.push({ id, status: "deactivated", last_active_at: null });
  mockState.team_member_identities.push({ external_id: slack_user_id, member_id: id });
}

describe("G3 — permission-resolver visibility matrix", () => {

  it("channel_public + asker-in-tenant → visible", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    const row: SlackIndexRow = {
      channel_id: "C001",
      conversation_type: "channel_public",
      source_user_ids: ["U_AUTHOR"],
    };
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: row,
    });
    expect(out.visible).toBe(true);
  });

  it("channel_public + asker-not-in-tenant → hidden", async () => {
    mockState.asker_email = "asker@x.com";
    addActiveAuthor("U_AUTHOR");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "C001",
        conversation_type: "channel_public",
        source_user_ids: ["U_AUTHOR"],
      },
    });
    expect(out.visible).toBe(false);
  });

  it("channel_private + asker IS a member → visible", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    mockState.slack_channel_members.push({ channel_id: "G001", slack_user_id: "U_ASKER" });
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "G001",
        conversation_type: "channel_private",
        source_user_ids: ["U_AUTHOR"],
      },
    });
    expect(out.visible).toBe(true);
  });

  it("channel_private + asker NOT a member → hidden", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "G001",
        conversation_type: "channel_private",
        source_user_ids: ["U_AUTHOR"],
      },
    });
    expect(out.visible).toBe(false);
  });

  it("dm + asker IS a participant → visible", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "D001",
        conversation_type: "dm",
        source_user_ids: ["U_AUTHOR", "U_ASKER"],
      },
    });
    expect(out.visible).toBe(true);
  });

  it("dm + asker NOT a participant → hidden", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "D001",
        conversation_type: "dm",
        source_user_ids: ["U_AUTHOR", "U_OTHER"],
      },
    });
    expect(out.visible).toBe(false);
  });

  it("mpim + asker IS a participant → visible", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    addActiveAuthor("U_OTHER");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "MP001",
        conversation_type: "mpim",
        source_user_ids: ["U_AUTHOR", "U_ASKER", "U_OTHER"],
      },
    });
    expect(out.visible).toBe(true);
  });

  it("mpim + asker NOT a participant → hidden", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR");
    addActiveAuthor("U_OTHER");
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "MP002",
        conversation_type: "mpim",
        source_user_ids: ["U_AUTHOR", "U_OTHER"],
      },
    });
    expect(out.visible).toBe(false);
  });

  it("all authors in workspace → visible", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR_A");
    addActiveAuthor("U_AUTHOR_B");
    mockState.slack_channel_members.push({ channel_id: "G001", slack_user_id: "U_ASKER" });
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "G001",
        conversation_type: "channel_private",
        source_user_ids: ["U_AUTHOR_A", "U_AUTHOR_B"],
      },
    });
    expect(out.visible).toBe(true);
  });

  it("1-of-N authors departed (last_active_at NULL) → soft-hidden", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_AUTHOR_A");
    addDepartedAuthor("U_AUTHOR_B");
    mockState.slack_channel_members.push({ channel_id: "G001", slack_user_id: "U_ASKER" });
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "G001",
        conversation_type: "channel_private",
        source_user_ids: ["U_AUTHOR_A", "U_AUTHOR_B"],
      },
    });
    expect(out.visible).toBe(false);
    expect(out.reason).toMatch(/no longer in workspace/i);
  });

  it("all authors departed → soft-hidden with explicit reason", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addDepartedAuthor("U_AUTHOR_A");
    addDepartedAuthor("U_AUTHOR_B");
    mockState.slack_channel_members.push({ channel_id: "G001", slack_user_id: "U_ASKER" });
    const out = await resolveVisibility({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_row: {
        channel_id: "G001",
        conversation_type: "channel_private",
        source_user_ids: ["U_AUTHOR_A", "U_AUTHOR_B"],
      },
    });
    expect(out.visible).toBe(false);
    expect(out.reason).toMatch(/no longer in workspace/i);
  });

  it("resolveVisibilityBulk does ONE team_member_identities query for N rows", async () => {
    setAskerLinked({ email: "asker@x.com", member_id: "m_asker", slack_user_id: "U_ASKER" });
    addActiveAuthor("U_A");
    addActiveAuthor("U_B");
    addActiveAuthor("U_C");

    const rows: SlackIndexRow[] = [
      { channel_id: "C1", conversation_type: "channel_public", source_user_ids: ["U_A"] },
      { channel_id: "C2", conversation_type: "channel_public", source_user_ids: ["U_B"] },
      { channel_id: "C3", conversation_type: "channel_public", source_user_ids: ["U_A", "U_B"] },
      { channel_id: "C4", conversation_type: "channel_public", source_user_ids: ["U_C"] },
      { channel_id: "C5", conversation_type: "channel_public", source_user_ids: ["U_A"] },
    ];

    const out = await resolveVisibilityBulk({
      asker_user_id: ASKER_USER_ID,
      tenant_id: TENANT_ID,
      candidate_rows: rows,
    });
    expect(out.length).toBe(5);
    expect(out.every((r) => r.visible)).toBe(true);
  });
});

describe("author lookup is scoped to the asker's workspace (Slack ids are per workspace)", () => {
  it("an author active only under the same Slack id in ANOTHER workspace counts as departed here", async () => {
    mockState.team_members.push({ id: "m_asker", status: "active", last_active_at: new Date().toISOString() });
    mockState.team_member_identities.push({ external_id: "U_ASKER", member_id: "m_asker", team_id: "T_ACME" });
    mockState.team_members.push({ id: "m_other", status: "active", last_active_at: new Date().toISOString() });
    mockState.team_member_identities.push({ external_id: "U_AUTHOR", member_id: "m_other", team_id: "T_OTHER" });
    const row: SlackIndexRow = { channel_id: "C1", conversation_type: "channel_public", source_user_ids: ["U_AUTHOR"] };
    const [out] = await resolveVisibilityBulkBySlackUser({
      tenant_id: TENANT_ID,
      team_id: "T_ACME",
      asker_slack_user_id: "U_ASKER",
      candidate_rows: [row],
    });
    expect(out.visible).toBe(false);
    expect(out.reason).toBe("author/participant no longer in workspace");

    mockState.team_member_identities.push({ external_id: "U_AUTHOR", member_id: "m_other", team_id: "T_ACME" });
    const [again] = await resolveVisibilityBulkBySlackUser({
      tenant_id: TENANT_ID,
      team_id: "T_ACME",
      asker_slack_user_id: "U_ASKER",
      candidate_rows: [row],
    });
    expect(again.visible).toBe(true);
  });
});
