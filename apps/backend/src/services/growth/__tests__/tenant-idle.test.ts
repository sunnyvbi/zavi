import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const NOW = new Date("2026-10-28T14:00:00.000Z");

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  failing: new Set<string>(),
  rejected: [] as unknown[],
  filters: [] as Array<{ table: string; op: string; args: unknown[] }>,
}));

function builder(table: string) {
  const q: Record<string, unknown> = {};
  let rejectedRead = false;
  let notIn: string[] = [];
  for (const op of ["select", "eq", "gte", "or", "not", "order", "in"]) {
    q[op] = (...args: unknown[]) => {
      h.filters.push({ table, op, args });
      if (op === "not" && args[0] === "rejected_by") {
        rejectedRead = true;
        if (args[1] === "in") notIn = String(args[2]).replace(/[()]/g, "").split(",");
      }
      return q;
    };
  }
  q.limit = async () => {
    if (h.failing.has(table)) return { data: null, error: { message: "boom" } };
    if (rejectedRead) return { data: (h.rejected as Array<{ rejected_by: string }>).filter((r) => !notIn.includes(r.rejected_by)), error: null };
    return { data: h.rows[table] ?? [], error: null };
  };
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({ from: (t: string) => builder(t) }),
  staffCrossTenantClient: () => ({ from: (t: string) => builder(t) }),
}));

import { tenantIsIdle, PERSON_TRIGGERS, WORKSPACE_OPENED_CODE } from "../tenant-idle";

beforeEach(() => {
  h.rows = {};
  h.rejected = [];
  h.failing.clear();
  h.filters.length = 0;
});

describe("tenantIsIdle", () => {
  it("is idle when no signal shows anyone in the last 7 days, and reads only that window", async () => {
    expect(await tenantIsIdle(T, NOW)).toBe(true);
    const windows = h.filters.filter((f) => f.op === "gte").map((f) => f.args[1]);
    expect(new Set(windows)).toEqual(new Set(["2026-10-21T14:00:00.000Z"]));
    const tables = new Set(h.filters.map((f) => f.table));
    for (const t of tables) expect(h.filters).toContainEqual({ table: t, op: "eq", args: ["tenant_id", T] });
  });

  it.each([
    ["a chat message", "agent_thread_messages"],
    ["a run they started", "agent_runs"],
    ["opening the workspace", "praxis_logs"],
    ["a card action", "channel_action_events"],
    ["approving or rejecting a card", "decisions"],
    ["opening a channel's cards", "tenant_channels"],
    ["answering a cgo question", "cgo_questions"],
  ])("%s makes the tenant active", async (_label, table) => {
    h.rows[table] = [{ id: "x" }];
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });

  it("counts plugin/MCP, email and WhatsApp runs, not Zavi's own runs", async () => {
    await tenantIsIdle(T, NOW);
    const runFilter = h.filters.find((f) => f.table === "agent_runs" && f.op === "or")!.args[0] as string;
    expect(runFilter).toContain("actor_user_id.not.is.null");
    for (const t of ["chat", "mcp", "email", "whatsapp"]) expect(PERSON_TRIGGERS).toContain(t);
    for (const t of ["cron", "a2a", "handoff", "channel_recipe"]) expect(runFilter).not.toMatch(new RegExp(`[(,]${t}[,)]`));
  });

  it("a chat message counts only when a person wrote it", async () => {
    await tenantIsIdle(T, NOW);
    expect(h.filters).toContainEqual({ table: "agent_thread_messages", op: "eq", args: ["sender_role", "user"] });
  });

  it("the workspace-open signal is the explicit open report, never the polled Needs-you list read", async () => {
    await tenantIsIdle(T, NOW);
    expect(WORKSPACE_OPENED_CODE).toBe("workspace.opened");
    expect(h.filters).toContainEqual({ table: "praxis_logs", op: "eq", args: ["code", WORKSPACE_OPENED_CODE] });
    expect(h.filters).not.toContainEqual({ table: "praxis_logs", op: "eq", args: ["code", "approvals.list_served"] });
  });

  it("only a decision the founder made counts: an app click or an email reply, not cgo, Autopilot email or staff", async () => {
    await tenantIsIdle(T, NOW);
    const decisionOrs = h.filters.filter((f) => f.table === "decisions" && f.op === "or").map((f) => f.args[0]);
    expect(decisionOrs).toEqual(["approved_by_source.is.null,approved_by_source.eq.email", "approved_by_source.is.null,approved_by_source.eq.email"]);
  });

  it("a rejection by staff is not the founder; one by a member is", async () => {
    h.rows.staff_users = [{ user_id: "staff-1" }];
    h.rejected = [{ rejected_by: "staff-1" }];
    expect(await tenantIsIdle(T, NOW)).toBe(true);
    h.rejected = [{ rejected_by: "staff-1" }, { rejected_by: "member-1" }];
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });

  it("one founder rejection behind many staff ones still counts (no sampling)", async () => {
    h.rows.staff_users = [{ user_id: "staff-1" }, { user_id: "staff-2" }];
    h.rejected = [...Array.from({ length: 25 }, (_, i) => ({ rejected_by: i % 2 ? "staff-1" : "staff-2" })), { rejected_by: "member-1" }];
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });

  it("no rejection this week: the staff roster is never read", async () => {
    await tenantIsIdle(T, NOW);
    expect(h.filters.some((f) => f.table === "staff_users")).toBe(false);
  });

  it("a staff roster too big to send whole counts as active", async () => {
    h.rows.staff_users = Array.from({ length: 200 }, (_, i) => ({ user_id: `staff-${i}` }));
    h.rejected = [{ rejected_by: "staff-1" }];
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });

  it("a failed staff lookup counts as active", async () => {
    h.rejected = [{ rejected_by: "someone" }];
    h.failing.add("staff_users");
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });

  it("a failed read counts as active, never as idle", async () => {
    h.failing.add("praxis_logs");
    expect(await tenantIsIdle(T, NOW)).toBe(false);
  });
});
