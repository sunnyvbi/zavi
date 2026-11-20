
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { serviceClientMock, state } = vi.hoisted(() => {
  const s = {
    target: null as { id: string } | null,
    plan: null as { id: string } | null,
    latest: undefined as { id: string } | null | undefined,
    generation: null as { reset_at: string } | null,
    delivery: null as { phase: string; artifact?: unknown } | null,
    errorTable: "",
    targetError: false,
    active: null as { id: string } | null,
    reads: [] as Array<{ table: string; filters: Record<string, unknown> }>,
    runRow: { id: "r-1", tenant_id: "t-1", agent_slug: "operator", status: "success" } as
      | Record<string, unknown>
      | null,
  };
  const client = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit"]) b[method] = () => b;
      for (const method of ["eq", "is", "like", "in"]) b[method] = (key: string, value: unknown) => { filters[key] = value; return b; };
      b.maybeSingle = () => {
        s.reads.push({ table, filters });
        const data = table === "growth_plan" ? s.plan
          : table === "growth_strategy_generation" ? s.generation
          : table === "growth_strategy_delivery" ? s.delivery
          : filters.id ? s.runRow
          : filters.status ? s.active
          : String(filters.cron_dedupe_key).endsWith("%") ? (s.latest === undefined ? { id: s.runRow?.id } : s.latest)
          : s.target;
        return Promise.resolve({ data, error: (s.errorTable === table || (s.targetError && table === "agent_runs" && !filters.id)) ? { message: "read failed" } : null });
      };
      return b;
    },
  };
  return { serviceClientMock: vi.fn(() => client), state: s };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async (_input: { trigger: string; payload: Record<string, unknown> }) => ({
    run_id: "new-run-1",
  })),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: enqueueMock }));

const { writeNoteMock } = vi.hoisted(() => ({
  writeNoteMock: vi.fn(async () => ({ note_id: "note-1" })),
}));
vi.mock("@/services/memory", () => ({ writeNote: writeNoteMock }));

const { writeStaffAuditMock } = vi.hoisted(() => ({
  writeStaffAuditMock: vi.fn(async () => undefined),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: writeStaffAuditMock }));

import { staffRunRetry } from "../run-retry";

const CONSTRAINT_VALID_TRIGGERS = [
  "manual",
  "cron",
  "slack",
  "webhook",
  "a2a",
  "chat",
  "handoff",
  "mcp",
  "email",
  "qa-weekly-execute",
];
const MEMBERSHIP_GATED = ["manual", "chat"];

const RUN_ID = "11111111-2222-3333-4444-555555555555";

function makeReqRes(body: unknown, params: Record<string, string> = { run_id: RUN_ID }) {
  const req = { params, body } as unknown as Parameters<typeof staffRunRetry>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<typeof staffRunRetry>[1] & typeof res };
}

beforeEach(() => {
  enqueueMock.mockReset().mockResolvedValue({ run_id: "new-run-1" });
  writeStaffAuditMock.mockClear();
  state.target = state.plan = state.generation = state.delivery = null;
  state.latest = undefined;
  state.errorTable = "";
  state.targetError = false;
  state.active = null;
  state.reads = [];
  writeNoteMock.mockClear();
  state.runRow = { id: "r-1", tenant_id: "t-1", agent_slug: "operator", status: "success" };
});

function setupRun(overrides: Record<string, unknown> = {}) {
  state.runRow = {
    id: RUN_ID, tenant_id: "t-1", agent_slug: "cgo", status: "dispatch_error",
    trigger: "a2a", enqueued_by: null, cron_dedupe_key: "cgo:draft:t-1:setup",
    enqueued_at: "2026-10-21T00:00:00Z",
    payload: { stage: "draft_strategy", origin: "setup_draft", research: { company: "Example" } },
    ...overrides,
  };
}

describe("staffRunRetry", () => {
  it("enqueues with a constraint-valid, non-membership-gated trigger", async () => {
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);

    expect(res.statusCode).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0] as { trigger: string; payload: Record<string, unknown> };

    expect(CONSTRAINT_VALID_TRIGGERS).toContain(arg.trigger);
    expect(MEMBERSHIP_GATED).not.toContain(arg.trigger);
  });

  it("preserves provenance in the enqueue payload", async () => {
    const { req, res } = makeReqRes({ hint: "look at the null guard" });
    await staffRunRetry(req, res);

    expect(res.statusCode).toBe(200);
    const arg = enqueueMock.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(arg.payload.retry_of).toBe(RUN_ID);
    expect(arg.payload.hint_note_id).toBe("note-1");
  });

  it("keeps a failed setup draft on the refundable initial-plan path", async () => {
    setupRun();
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      setup_draft_attempt: 2,
      payload: { stage: "draft_strategy", origin: "setup_draft", research: { company: "Example" } },
    }));
  });

  it("keeps only setup inputs and records provenance in the staff audit", async () => {
    setupRun({ payload: { stage: "draft_strategy", origin: "setup_draft", research: { company: "Example" },
      interview: { audience: "teams" }, past_work: [{ fact: "Has a website" }], approved: true, tenant_id: "other" } });
    const { req, res } = makeReqRes({ hint: "Check the original audience" });
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(200);
    expect(enqueueMock.mock.calls[0][0].payload).toEqual({ stage: "draft_strategy", origin: "setup_draft",
      research: { company: "Example" }, interview: { audience: "teams" }, past_work: [{ fact: "Has a website" }] });
    expect(enqueueMock.mock.calls[0][0]).not.toHaveProperty("cron_dedupe_key");
    expect(enqueueMock.mock.calls[0][0]).not.toHaveProperty("user_access_token");
    expect(writeStaffAuditMock).toHaveBeenCalledWith(expect.objectContaining({ target_id: RUN_ID,
      meta: expect.objectContaining({ new_run_id: "new-run-1", note_id: "note-1" }) }));
    for (const read of state.reads.filter(r => !r.filters.id)) expect(read.filters.tenant_id).toBe("t-1");
  });

  it("replays the same target even after it failed, without another hint or enqueue", async () => {
    setupRun();
    state.target = { id: "failed-attempt-2" };
    const { req, res } = makeReqRes({ hint: "Please retry" });
    await staffRunRetry(req, res);
    expect(res.payload).toEqual({ ok: true, run_id: "failed-attempt-2", hint_applied: false });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it.each(["failed", "error"])("retries a setup draft the worker ended as %s", async (status) => {
    setupRun({ status });
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(200);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ setup_draft_attempt: 2 }));
  });

  it("uses attempt 3 only when retrying attempt 2", async () => {
    setupRun({ cron_dedupe_key: "cgo:draft:t-1:setup:2", status: "parse_failed" });
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ setup_draft_attempt: 3 }));
  });

  it("reads the winner's receipt when a concurrent enqueue deduplicates", async () => {
    setupRun();
    enqueueMock.mockImplementationOnce(async () => { state.target = { id: "race-winner" }; return { run_id: "" }; });
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(res.payload).toEqual({ ok: true, run_id: "race-winner", hint_applied: false });
  });

  it("does not claim success without a deduplicated receipt", async () => {
    setupRun();
    enqueueMock.mockResolvedValueOnce({ run_id: "" });
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(409);
    expect(writeStaffAuditMock).not.toHaveBeenCalled();
  });

  it.each([
    ["exhausted attempts", { cron_dedupe_key: "cgo:draft:t-1:setup:3" }],
    ["wrong tenant key", { cron_dedupe_key: "cgo:draft:other:setup" }],
    ["paid attempt", { cron_dedupe_key: "cgo:draft:t-1:setup:paid:4" }],
    ["member-written", { enqueued_by: "founder" }],
    ["missing actor provenance", { enqueued_by: undefined }],
    ["wrong trigger", { trigger: "manual" }],
    ["in flight", { status: "running" }],
    ["queued", { status: "queued" }],
    ["blocked", { status: "blocked" }],
    ["success", { status: "success" }],
    ["missing stage", { payload: { origin: "setup_draft" } }],
  ])("refuses %s without any writes", async (_name, overrides) => {
    setupRun(overrides);
    const { req, res } = makeReqRes({ hint: "Do not persist on refusal" });
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(409);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(writeNoteMock).not.toHaveBeenCalled();
    expect(writeStaffAuditMock).not.toHaveBeenCalled();
  });

  it.each(["plan", "newer", "reset", "artifact", "superseded", "read error", "target read error", "generation read error", "delivery read error", "older active draft"])("does not regenerate on %s", async (condition) => {
    setupRun();
    if (condition === "plan") state.plan = { id: "live-plan" };
    if (condition === "older active draft") state.active = { id: "older-running-draft" };
    if (condition === "newer") state.latest = { id: "newer-draft" };
    if (condition === "reset") state.generation = { reset_at: "2026-10-22T00:00:00Z" };
    if (condition === "artifact") state.delivery = { phase: "failed", artifact: { strategy: {} } };
    if (condition === "superseded") state.delivery = { phase: "superseded" };
    if (condition === "read error") state.errorTable = "growth_plan";
    if (condition === "target read error") state.targetError = true;
    if (condition === "generation read error") state.errorTable = "growth_strategy_generation";
    if (condition === "delivery read error") state.errorTable = "growth_strategy_delivery";
    const { req, res } = makeReqRes({ hint: "Do not persist on refusal" });
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(409);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it("404s a missing run without enqueuing", async () => {
    state.runRow = null;
    const { req, res } = makeReqRes({});
    await staffRunRetry(req, res);
    expect(res.statusCode).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("AGENT_TRIGGERS ⊆ agent_runs_trigger_check", () => {
  it("every TS trigger value is admitted by the DB constraint", async () => {
    const { AGENT_TRIGGERS } = await import("@/services/agents/types");
    const migrationsDir = join(__dirname, "../../../../../../supabase/migrations");
    const redefiners = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /add\s+constraint\s+agent_runs_trigger_check/i.test(
          readFileSync(join(migrationsDir, f), "utf8"),
        ),
      )
      .sort();
    expect(redefiners.length, "no migration defines agent_runs_trigger_check").toBeGreaterThan(0);
    const sql = readFileSync(join(migrationsDir, redefiners[redefiners.length - 1]), "utf8");
    const m = sql.match(/check\s*\(\s*trigger\s+in\s*\(([^)]*)\)/i);
    expect(m, "could not locate agent_runs_trigger_check clause").toBeTruthy();
    const constraintValues = (m![1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
    expect(constraintValues.length).toBeGreaterThan(0);

    for (const t of AGENT_TRIGGERS) {
      expect(constraintValues, `trigger "${t}" is in AGENT_TRIGGERS but not the DB constraint`).toContain(t);
    }
  });
});
