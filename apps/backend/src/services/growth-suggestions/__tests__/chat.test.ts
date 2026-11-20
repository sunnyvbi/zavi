import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "5f05d826-7793-45d1-88f9-c5c5bb3f0347";
const SESSION = "11111111-2222-4333-8444-555555555555";

const { serviceClientMock, calls, state, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const c = { inserts: [] as Array<{ table: string; rows: unknown }>, selects: [] as string[] };
  const s = { queues: {} as Record<string, Result[]> };
  const client = {
    from(table: string) {
      c.selects.push(table);
      const next = () => s.queues[table]?.shift() ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "order", "limit"]) {
        builder[op] = () => builder;
      }
      builder.insert = (rows: unknown) => {
        c.inserts.push({ table, rows });
        return builder;
      };
      builder.maybeSingle = () => Promise.resolve(next());
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
      return builder;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    calls: c,
    state: s,
    reset: () => {
      c.inserts = [];
      c.selects = [];
      s.queues = {};
    },
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { recordSuggestionTurn, sessionTitle } from "../chat";

const staff = { user_id: "staff-user", email: "staff@zavi.ai" };

beforeEach(reset);

describe("sessionTitle", () => {
  it("collapses whitespace and falls back when the prompt is blank", () => {
    expect(sessionTitle("  Refresh   the\ncreative ")).toBe("Refresh the creative");
    expect(sessionTitle("   ")).toBe("Suggestion session");
  });

  it("truncates to the column limit", () => {
    expect(sessionTitle("x".repeat(400))).toHaveLength(240);
  });
});

describe("recordSuggestionTurn", () => {
  it("opens a session when none is supplied and files both turns under it", async () => {
    state.queues.growth_suggestion_sessions = [{ data: { id: SESSION }, error: null }];
    state.queues.growth_suggestion_messages = [{ data: [], error: null }];

    const result = await recordSuggestionTurn({
      tenant_id: TENANT,
      staff,
      staff_body: "Look at the summer campaigns",
      zavi_body: "I found 3 suggestions.",
    });

    expect(result.session_id).toBe(SESSION);
    const messageInsert = calls.inserts.find((i) => i.table === "growth_suggestion_messages");
    expect(messageInsert?.rows).toMatchObject([
      { session_id: SESSION, tenant_id: TENANT, role: "staff" },
      { session_id: SESSION, tenant_id: TENANT, role: "zavi" },
    ]);
  });

  it("reuses a session that belongs to the tenant", async () => {
    state.queues.growth_suggestion_sessions = [{ data: { id: SESSION }, error: null }];
    state.queues.growth_suggestion_messages = [{ data: [], error: null }];

    const result = await recordSuggestionTurn({
      tenant_id: TENANT,
      session_id: SESSION,
      staff,
      staff_body: "again",
      zavi_body: "ok",
    });

    expect(result.session_id).toBe(SESSION);
    expect(calls.inserts.filter((i) => i.table === "growth_suggestion_sessions")).toHaveLength(0);
  });

  it("starts a fresh session when the id belongs to another tenant", async () => {
    state.queues.growth_suggestion_sessions = [
      { data: null, error: null },
      { data: { id: "new-session" }, error: null },
    ];
    state.queues.growth_suggestion_messages = [{ data: [], error: null }];

    const result = await recordSuggestionTurn({
      tenant_id: TENANT,
      session_id: SESSION,
      staff,
      staff_body: "hi",
      zavi_body: "ok",
    });

    expect(result.session_id).toBe("new-session");
    expect(calls.inserts.filter((i) => i.table === "growth_suggestion_sessions")).toHaveLength(1);
  });
});
