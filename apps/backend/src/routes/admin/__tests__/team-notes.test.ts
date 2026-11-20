import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "staff@zavi.test" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async (_i: Record<string, unknown>) => undefined) }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAuditStrict: auditMock }));

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "SECRET_NOTE_TEXT";

const { client, state } = vi.hoisted(() => {
  const COLUMNS = new Set(["id", "tenant_id", "user_id", "offer_id", "thread_id", "message_id", "run_id", "agent_slug",
    "source", "signal", "signals", "fingerprint", "note", "founder_extra", "note_edited", "status", "created_at", "expires_at"]);
  const state = {
    rpc: {} as Record<string, { data: unknown; error: { message: string } | null }>,
    rpcCalls: [] as Array<[string, Record<string, unknown>]>,
    report: null as Record<string, unknown> | null,
    selects: [] as string[],
    readError: null as { message: string } | null,
  };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push([name, args]);
      return state.rpc[name] ?? { data: [], error: null };
    },
    from: (table: string) => {
      if (table !== "team_reports") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      let cols: string[] = [];
      const q = {
        select: (c: string) => {
          cols = c.split(",").map((x) => x.trim());
          for (const col of cols) if (!COLUMNS.has(col)) throw new Error(`42703 column ${col}`);
          state.selects.push(c);
          return q;
        },
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        maybeSingle: async () => {
          if (state.readError) return { data: null, error: state.readError };
          const r = state.report;
          if (!r || Object.entries(filters).some(([k, v]) => r[k] !== v)) return { data: null, error: null };
          return { data: Object.fromEntries(cols.map((c) => [c, r[c]])), error: null };
        },
      };
      return q;
    },
  };
  return { client, state };
});
vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: () => client }));

import { staffTeamNotesSummary, staffTeamReportList, staffTeamReportRead } from "../team-notes";

function res() {
  return {
    statusCode: 200, body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
const req = (query: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({ query, params }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  state.rpc = {}; state.rpcCalls = []; state.selects = []; state.readError = null;
  state.report = {
    id: REPORT, tenant_id: TENANT, thread_id: THREAD, message_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    agent_slug: "operator", signal: "tool_failure", source: "run_end", created_at: "2026-10-18T10:00:00Z",
    note: SECRET, founder_extra: `${SECRET} extra`,
  };
});

describe("GET /team-notes/summary", () => {
  it("returns both aggregates as numbers, with totals, and asks for the right window", async () => {
    state.rpc.team_note_judgement_summary = { data: [
      { agent_slug: "operator", code_signal: "run_failed", judge_signal: "other", source: "run_end", surface: "strip", verdict: "bad", n: "3" },
      { agent_slug: "operator", code_signal: "tool_loop", judge_signal: null, source: "run_end", surface: null, verdict: "no", n: "5" },
      { agent_slug: "pm", code_signal: "none", judge_signal: null, source: "run_end", surface: null, verdict: "parse", n: 1 },
    ], error: null };
    state.rpc.team_note_offer_summary = { data: [
      { agent_slug: "operator", code_signal: "run_failed", judge_signal: "other", source: "run_end", surface: "strip", status: "sent", n: "2" },
      { agent_slug: "operator", code_signal: "tool_loop", judge_signal: "looping", source: "run_end", surface: "flag", status: "dismissed", n: "1" },
    ], error: null };
    const r = res();
    await staffTeamNotesSummary(req({ days: "30" }), r as never);
    expect(state.rpcCalls).toEqual([["team_note_judgement_summary", { p_days: 30 }], ["team_note_offer_summary", { p_days: 30 }]]);
    expect(r.body.totals).toEqual({ judged: 9, judged_bad: 3, judge_failed: 1, offered: 3, strips: 2, flags: 1, sent: 2, dismissed: 1 });
    expect(r.body.judgements[0].n).toBe(3);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant/);
  });

  it.each([["14"], ["abc"], [""]])("rejects days=%s", async (days) => {
    const r = res();
    await staffTeamNotesSummary(req({ days }), r as never);
    expect(r.statusCode).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("an RPC failure is a 500, not a partial table", async () => {
    state.rpc.team_note_offer_summary = { data: null, error: { message: "boom" } };
    const r = res();
    await staffTeamNotesSummary(req(), r as never);
    expect(r.statusCode).toBe(500);
  });

  it("assertStaff runs first: a non-staff caller reaches no query", async () => {
    assertStaffMock.mockImplementationOnce(() => { throw new Error("assertStaff: req.staff missing"); });
    await expect(staffTeamNotesSummary(req(), res() as never)).rejects.toThrow(/assertStaff/);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("GET /team-notes/reports", () => {
  const listRow = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, tenant_id: TENANT, tenant_slug: "acme", tenant_name: "Acme",
    agent_slug: "operator", signal: "other", source: "run_end", created_at: `2026-10-1${i}T00:00:00Z`,
    has_extra: i === 1, note_edited: false, status: "new", thread_id: i === 2 ? null : THREAD, message_id: null,
    note: SECRET,
  });

  it("metadata only, explicit fields, no text even if the RPC grew one", async () => {
    state.rpc.team_reports_staff_list = { data: [listRow(1), listRow(2)], error: null };
    const r = res();
    await staffTeamReportList(req(), r as never);
    expect(state.rpcCalls[0]).toEqual(["team_reports_staff_list", { p_before_created: null, p_before_id: null, p_limit: 51 }]);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(r.body.reports[1]).toMatchObject({ thread_id: null, message_id: null, has_extra: false });
    expect(r.body.next_cursor).toBeNull();
  });

  it("a full page returns the next cursor from the last row shown", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ ...listRow(1), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, created_at: `2026-10-18T00:00:${String(59 - i).padStart(2, "0")}Z` }));
    state.rpc.team_reports_staff_list = { data: rows, error: null };
    const r = res();
    await staffTeamReportList(req(), r as never);
    expect(r.body.reports).toHaveLength(50);
    expect(r.body.next_cursor).toEqual({ before: rows[49].created_at, before_id: rows[49].id });
  });

  it("passes a cursor through and rejects half or malformed ones", async () => {
    await staffTeamReportList(req({ before: "2026-10-18T00:00:00Z", before_id: REPORT }), res() as never);
    expect(state.rpcCalls[0][1]).toMatchObject({ p_before_created: "2026-10-18T00:00:00Z", p_before_id: REPORT });
    for (const q of [{ before: "2026-10-18T00:00:00Z" }, { before: "nope", before_id: REPORT }, { before: "2026-10-18T00:00:00Z", before_id: "x" }]) {
      const r = res();
      await staffTeamReportList(req(q), r as never);
      expect(r.statusCode).toBe(400);
    }
  });
});

describe("GET /team-notes/reports/:id", () => {
  it("audits FIRST (action, target, tenant), then returns the note, extra and the thread path", async () => {
    const r = res();
    await staffTeamReportRead(req({}, { id: REPORT }), r as never);
    expect(auditMock).toHaveBeenCalledWith({
      actor_user_id: "u-staff", actor_email: "staff@zavi.test", action: "staff.team_report.read",
      target_table: "team_reports", target_id: REPORT, tenant_id: TENANT,
    });
    expect(state.selects[0]).not.toMatch(/note|founder_extra/);
    expect(state.selects[1]).toBe("note, founder_extra");
    expect(r.body.report).toMatchObject({ id: REPORT, note: SECRET, founder_extra: `${SECRET} extra`,
      thread_path: `/tenants/${TENANT}/threads/${THREAD}` });
  });

  it("FAILS CLOSED: an audit write failure returns no text", async () => {
    auditMock.mockRejectedValueOnce(new Error("staff audit write failed"));
    const r = res();
    await staffTeamReportRead(req({}, { id: REPORT }), r as never);
    expect(r.statusCode).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(state.selects).toHaveLength(1);
  });

  it("a deleted chat: no thread path", async () => {
    state.report = { ...state.report!, thread_id: null, message_id: null, founder_extra: null };
    const r = res();
    await staffTeamReportRead(req({}, { id: REPORT }), r as never);
    expect(r.body.report).toMatchObject({ thread_path: null, founder_extra: null });
  });

  it("unknown or malformed id is a 404 with no audit row", async () => {
    for (const id of ["not-a-uuid", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]) {
      const r = res();
      await staffTeamReportRead(req({}, { id }), r as never);
      expect(r.statusCode).toBe(404);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("a read error is a 500 with no audit row and no text", async () => {
    state.readError = { message: "db down" };
    const r = res();
    await staffTeamReportRead(req({}, { id: REPORT }), r as never);
    expect(r.statusCode).toBe(500);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
