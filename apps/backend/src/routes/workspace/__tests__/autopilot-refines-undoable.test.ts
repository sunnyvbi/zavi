import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rootMaybeSingle: vi.fn(),
  sessionRuns: vi.fn(),
  agentRuns: [] as unknown[],
  undoKey: true as boolean | "throw",
  settingReads: [] as Array<[string, unknown]>,
  memberships: [] as Array<{ user_id: string; tenant_id: string; role: string }>,
  readLiveEditState: vi.fn(),
}));

vi.mock("@/services/build/live-edit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/build/live-edit")>();
  return { ...real, readLiveEditState: mocks.readLiveEditState };
});

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) => {
      mocks.settingReads.push([key, tenantId]);
      if (key === "build_edit_undo") {
        if (mocks.undoKey === "throw") throw new Error("settings read failed");
        return mocks.undoKey;
      }
      return false;
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

let step = 0;

type ReadShape = { ascending: boolean; limit: number };

function chain(terminal: (shape: ReadShape) => unknown) {
  const api: Record<string, unknown> = {};
  let ascending = true;
  for (const m of ["select", "eq", "in", "or", "gte", "is"]) api[m] = () => api;
  api.order = (_col: string, opts?: { ascending?: boolean }) => {
    ascending = opts?.ascending !== false;
    return api;
  };
  api.limit = (n: number) => terminal({ ascending, limit: n });
  api.maybeSingle = () => terminal({ ascending, limit: 1 });
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        step += 1;
        return step === 1 ? chain(() => mocks.rootMaybeSingle()) : chain((shape) => mocks.sessionRuns(shape));
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: mocks.agentRuns, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "tenant_users") throw new Error(`unexpected service table in mock: ${table}`);
      const filters: Record<string, unknown> = {};
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return b;
        },
        maybeSingle: async () => {
          const hit = mocks.memberships.find((m) => m.user_id === filters.user_id && m.tenant_id === filters.tenant_id);
          return { data: hit ? { role: hit.role } : null, error: null };
        },
      };
      return b;
    },
  }),
}));

import { getAutopilotRefines, undoableRefineId } from "../autopilot";
import { isChangeRunPayload } from "@/services/agents/refine-undo";

const ROOT = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d01";
const HEADLINE = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d11";
const COLOUR = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d12";
const BETTER = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d13";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

type Row = {
  id: string;
  objective: string;
  status: string;
  goal_graph: unknown[];
  spend_usd: number;
  max_usd: number;
  created_at: string;
  updated_at: string;
  kind: string;
};

let minute = 0;
function at(): string {
  minute += 1;
  return new Date(Date.UTC(2026, 8, 29, 10, minute)).toISOString();
}

function build(id = ROOT): Row {
  const t = at();
  return {
    id,
    objective: "Build product: Yoga studio booking",
    status: "done",
    goal_graph: [{ status: "done", child_run_id: null, payload: { stage: "build", refine_mode: false } }],
    spend_usd: 1,
    max_usd: 5,
    created_at: t,
    updated_at: t,
    kind: "build_app",
  };
}

function edit(id: string, status = "done", payload: Record<string, unknown> = {}): Row {
  const t = at();
  return {
    id,
    objective: `[refine] edit ${id.slice(-2)}`,
    status,
    goal_graph: [
      {
        status,
        child_run_id: null,
        payload: { stage: "build", refine_mode: true, idea: "edit", parent_conductor_run_id: ROOT, ...payload },
      },
    ],
    spend_usd: 1,
    max_usd: 5,
    created_at: t,
    updated_at: t,
    kind: "build_app",
  };
}

function undo(parent: string, stage = "undo", status = "done"): Row {
  const t = at();
  return {
    id: `0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4f${String(minute).padStart(2, "0")}`,
    objective: "[undo] revert abc1234",
    status,
    goal_graph: [{ status: "done", payload: { stage, parent_conductor_run_id: parent } }],
    spend_usd: 0,
    max_usd: 0,
    created_at: t,
    updated_at: t,
    kind: "undo",
  };
}

async function read(query: Record<string, string> = { session_id: ROOT }) {
  const res = mockRes();
  await getAutopilotRefines({ query } as never, res as never);
  expect(res.statusCode).toBe(200);
  return (res.body as { refines: Array<Record<string, unknown>> }).refines;
}

function undoableIds(refines: Array<Record<string, unknown>>): string[] {
  return refines.filter((r) => r.undoable === true).map((r) => r.id as string);
}

function sessionIs(rows: Row[]) {
  mocks.sessionRuns.mockResolvedValue({ data: rows, error: null });
}

beforeEach(() => {
  step = 0;
  minute = 0;
  mocks.undoKey = true;
  mocks.settingReads = [];
  mocks.agentRuns = [];
  mocks.memberships = [
    { user_id: "user-1", tenant_id: "tnt-yoga", role: "owner" },
    { user_id: "user-2", tenant_id: "tnt-yoga", role: "viewer" },
    { user_id: "user-2", tenant_id: "tnt-own", role: "owner" },
  ];
  mocks.requireAuth.mockReset();
  mocks.rootMaybeSingle.mockReset();
  mocks.sessionRuns.mockReset();
  mocks.readLiveEditState.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "user-1", access_token: "tok" });
  mocks.rootMaybeSingle.mockResolvedValue({ data: { id: ROOT, created_at: "2026-09-29T10:00:00Z" }, error: null });
});

describe("DEL-1323 B29: the newest live edit offers Undo this change", () => {
  it("the ticket's three yoga edits: only the newest live one is undoable", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR), edit(BETTER)]);
    const refines = await read();
    expect(undoableIds(refines)).toEqual([BETTER]);
    expect(refines.filter((r) => r.kind === "change").every((r) => typeof r.undoable === "boolean")).toBe(true);
    expect(mocks.settingReads).toContainEqual(["build_edit_undo", "tnt-yoga"]);
  });

  it("after an undo nothing is undoable, so a second press can never revert the revert", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR), undo(COLOUR)]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("after restoring an older version nothing is undoable", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR), undo(ROOT, "restore")]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("an edit made after an undo is undoable again", async () => {
    sessionIs([build(), edit(HEADLINE), undo(HEADLINE), edit(COLOUR)]);
    expect(undoableIds(await read())).toEqual([COLOUR]);
  });

  it("a newer build (another app in the same workspace) hides undo on this app", async () => {
    sessionIs([build(), edit(HEADLINE), build("0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d99")]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("an edit still running hides undo on the one before it", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR, "active")]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("an edit that failed or stopped leaves the last live edit undoable", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR, "failed"), edit(BETTER, "halted")]);
    expect(undoableIds(await read())).toEqual([HEADLINE]);
  });

  it("an edit parked for review is not live, so neither it nor the one before is undoable", async () => {
    sessionIs([build(), edit(HEADLINE), edit(COLOUR, "done", { defer_pr: true })]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("key off: the feed carries no undoable field at all", async () => {
    mocks.undoKey = false;
    sessionIs([build(), edit(HEADLINE)]);
    const refines = await read();
    expect(refines.some((r) => "undoable" in r)).toBe(false);
  });

  it("a failed settings read counts as off", async () => {
    mocks.undoKey = "throw";
    sessionIs([build(), edit(HEADLINE)]);
    expect((await read()).some((r) => "undoable" in r)).toBe(false);
  });

  it("the tenant-wide feed (no session) never carries the flag", async () => {
    mocks.rootMaybeSingle.mockResolvedValue({ data: [edit(HEADLINE), build()], error: null });
    const refines = await read({});
    expect(refines.length).toBe(1);
    expect("undoable" in refines[0]).toBe(false);
    expect(mocks.settingReads.some(([k]) => k === "build_edit_undo")).toBe(false);
  });
});

describe("DEL-1323 B29: Undo after Publish when the live-edit state cannot be read", () => {
  const ENGINEER = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4e01";
  const SHA = "c".repeat(40);

  function liveEdit(id: string): Row {
    const row = edit(id, "done", { live_edit_branch: "zavi/draft" });
    (row.goal_graph[0] as { child_run_id: string | null }).child_run_id = ENGINEER;
    return row;
  }

  beforeEach(() => {
    mocks.agentRuns = [
      {
        id: ENGINEER,
        status: "success",
        finished_at: "2026-09-29T11:04:00Z",
        output_text: "I made the change.",
        parsed: { live_edit_draft_sha: SHA },
        outcome: null,
      },
    ];
  });

  it("a published live edit stays undoable and is not called a draft when the state read times out", async () => {
    mocks.readLiveEditState.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    sessionIs([build(), liveEdit(BETTER)]);
    const refines = await read();
    const row = refines.find((r) => r.id === BETTER)!;
    expect(mocks.readLiveEditState).toHaveBeenCalledWith("tnt-yoga");
    expect(row.draft).not.toBe(true);
    expect("draft" in row).toBe(false);
    expect(row.undoable).toBe(true);
  });

  it("when the state reads fine, a published live edit is undoable and a pending one is a draft with no Undo", async () => {
    mocks.readLiveEditState.mockResolvedValue({ enabled: true, draft: { exists: true, changes: [] } });
    sessionIs([build(), liveEdit(BETTER)]);
    let row = (await read()).find((r) => r.id === BETTER)!;
    expect(row.draft).toBe(false);
    expect(row.undoable).toBe(true);

    step = 0;
    mocks.readLiveEditState.mockResolvedValue({ enabled: true, draft: { exists: true, changes: [{ sha: SHA }] } });
    row = (await read()).find((r) => r.id === BETTER)!;
    expect(row.draft).toBe(true);
    expect(row.undoable).toBe(false);
  });

  it("a live edit with no commit yet stays a draft with no Undo even when the state read fails", async () => {
    mocks.readLiveEditState.mockRejectedValue(new Error("db down"));
    mocks.agentRuns = [{ ...(mocks.agentRuns[0] as object), parsed: {} }];
    sessionIs([build(), liveEdit(BETTER)]);
    const row = (await read()).find((r) => r.id === BETTER)!;
    expect(row.draft).toBe(true);
    expect(row.undoable).toBe(false);
  });
});

describe("DEL-1323 B29 H2 + M2: who sees Undo, and what an undo claim does to the feed", () => {
  it("a viewer never gets an undoable edit, even one who owns another workspace", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "user-2", access_token: "tok" });
    sessionIs([build(), edit(HEADLINE), edit(BETTER)]);
    const refines = await read();
    expect(undoableIds(refines)).toEqual([]);
    expect(refines.filter((r) => r.kind === "change").every((r) => r.undoable === false)).toBe(true);
  });

  it("a member sees Undo on the newest live edit (option C, Ravi 2026-10-02)", async () => {
    mocks.memberships.push({ user_id: "user-4", tenant_id: "tnt-yoga", role: "member" });
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "user-4", access_token: "tok" });
    sessionIs([build(), edit(HEADLINE), edit(BETTER)]);
    expect(undoableIds(await read())).toEqual([BETTER]);
  });

  it("an admin sees Undo on the newest live edit", async () => {
    mocks.memberships.push({ user_id: "user-3", tenant_id: "tnt-yoga", role: "admin" });
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "user-3", access_token: "tok" });
    sessionIs([build(), edit(HEADLINE), edit(BETTER)]);
    expect(undoableIds(await read())).toEqual([BETTER]);
  });

  it("an undo still in flight hides Undo and is not shown as done", async () => {
    sessionIs([build(), edit(HEADLINE), edit(BETTER), undo(BETTER, "undo", "proposed")]);
    const refines = await read();
    expect(undoableIds(refines)).toEqual([]);
    expect(refines.some((r) => r.kind === "undo")).toBe(false);
  });

  it("an undo that failed leaves the edit undoable and is not shown as done", async () => {
    sessionIs([build(), edit(HEADLINE), edit(BETTER), undo(BETTER, "undo", "failed")]);
    const refines = await read();
    expect(undoableIds(refines)).toEqual([BETTER]);
    expect(refines.some((r) => r.kind === "undo")).toBe(false);
  });

  it("a settled undo still shows as Undid the last change", async () => {
    sessionIs([build(), edit(HEADLINE), edit(BETTER), undo(BETTER)]);
    const refines = await read();
    expect(refines.filter((r) => r.kind === "undo").map((r) => r.message)).toEqual(["Undid the last change"]);
  });
});

describe("undoableRefineId", () => {
  it("matches refineUndo's pick: the newest done edit, blocked by any later undo, build or running edit", () => {
    expect(undoableRefineId([])).toBeNull();
    expect(undoableRefineId([build()])).toBeNull();
    expect(undoableRefineId([build(), edit(HEADLINE), edit(COLOUR, "failed")])).toBe(HEADLINE);
    expect(undoableRefineId([build(), edit(HEADLINE), edit(COLOUR, "provisioning")])).toBeNull();
    expect(undoableRefineId([build(), edit(HEADLINE), undo(HEADLINE)])).toBeNull();
  });

  it("skips an edit that found nothing to change: the real edit before it stays the one to undo", () => {
    expect(undoableRefineId([build(), edit(HEADLINE), edit(COLOUR, "done", { no_change: true })])).toBe(HEADLINE);
  });

  it("a question the engineer asked reaches the founder in the feed, as a question (round 9)", async () => {
    const asked = edit(BETTER, "done", { no_change: true, declared_outcome: "needs_input" });
    (asked.goal_graph![0] as { child_run_id: string | null }).child_run_id = "eng-asked";
    mocks.agentRuns = [
      {
        id: "eng-asked",
        status: "success",
        finished_at: "2026-10-02T11:04:00Z",
        output_text: "",
        parsed: { refused: true, reason_code: "needs_input", customer_summary: "Your site has no footer yet. Should I add one with this tagline?" },
        outcome: null,
      },
    ];
    sessionIs([build(), edit(HEADLINE), asked]);
    const row = (await read()).find((r) => r.id === BETTER)!;
    expect(row).toMatchObject({
      declared_outcome: "needs_input",
      declared_message: "Your site has no footer yet. Should I add one with this tagline?",
      no_change: false,
    });
    expect(row.draft).not.toBe(true);
    expect(row.undoable).not.toBe(true);
  });

  it("the feed marks a no-change edit, never as waiting for Publish or undoable", async () => {
    sessionIs([build(), edit(HEADLINE), edit(BETTER, "done", { no_change: true })]);
    const refines = await read();
    const nc = refines.find((r) => r.id === BETTER);
    expect(nc?.no_change).toBe(true);
    expect(nc?.draft).not.toBe(true);
    expect(undoableIds(refines)).toEqual([HEADLINE]);
  });
});

describe("QA R6-2: a Publish is not a change", () => {
  const PUBLISH = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d21";
  const publish = (id = PUBLISH, status = "done") =>
    edit(id, status, { stage: "deploy", republish: true, publish_request: true });

  it("Undo targets the change before a Publish, never the Publish run (refineUndo excludes it too)", () => {
    expect(undoableRefineId([build(), edit(HEADLINE), publish()])).toBe(HEADLINE);
    expect(undoableRefineId([build(), edit(HEADLINE), publish(PUBLISH, "active")])).toBe(HEADLINE);
    expect(undoableRefineId([build(), publish()])).toBeNull();
    expect(undoableRefineId([build(), edit(HEADLINE), undo(HEADLINE), publish()])).toBeNull();
    expect(undoableRefineId([build(), edit(HEADLINE), publish(), edit(COLOUR)])).toBe(COLOUR);
  });

  it("the Build chat shows no card for a Publish, and Undo sits on the real change", async () => {
    sessionIs([build(), edit(HEADLINE), publish()]);
    const refines = await read();
    expect(refines.map((r) => r.id)).toEqual([HEADLINE]);
    expect(undoableIds(refines)).toEqual([HEADLINE]);
  });

  it("isChangeRunPayload is the one definition: refine_mode and not a publish", () => {
    expect(isChangeRunPayload({ refine_mode: true })).toBe(true);
    expect(isChangeRunPayload({ refine_mode: true, republish: true })).toBe(false);
    expect(isChangeRunPayload({ refine_mode: false })).toBe(false);
    expect(isChangeRunPayload(null)).toBe(false);
  });
});

describe("undoableRefineId with an undo claim stuck in proposed", () => {
  function claim(parent: string): Row {
    const row = undo(parent, "undo", "proposed");
    row.goal_graph = [{ status: "proposed", payload: { stage: "undo", undo_claim: true, parent_conductor_run_id: parent } }];
    return row;
  }

  it("a fresh claim still hides the button, a stale one (older than UNDO_CLAIM_STALE_MS) brings it back so a retry can release it", () => {
    const rows = [build(), edit(HEADLINE), claim(HEADLINE)];
    const claimedAt = Date.parse(rows[2]!.created_at);
    expect(undoableRefineId(rows, claimedAt + 60_000)).toBeNull();
    expect(undoableRefineId(rows, claimedAt + 10 * 60 * 1000 - 1)).toBeNull();
    expect(undoableRefineId(rows, claimedAt + 10 * 60 * 1000 + 1)).toBe(HEADLINE);
  });

  it("a stale row that is not an undo claim is not ignored", () => {
    const rows = [build(), edit(HEADLINE), undo(HEADLINE, "undo", "proposed")];
    expect(undoableRefineId(rows, Date.parse(rows[2]!.created_at) + 60 * 60 * 1000)).toBeNull();
  });
});

describe("undoable on a session longer than the 200-row read", () => {
  function tableOf(rows: Row[]) {
    mocks.sessionRuns.mockImplementation(async (shape: ReadShape) => {
      const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (!shape.ascending) sorted.reverse();
      return { data: sorted.slice(0, shape.limit), error: null };
    });
  }

  function edits(n: number): Row[] {
    return Array.from({ length: n }, (_, i) =>
      edit(`0f1c1a5e-6a6e-4d5a-9a3a-${String(i).padStart(12, "0")}`),
    );
  }

  it("flags no stale edit when the newest live edit is past the first 200 rows", async () => {
    const all = [build(), ...edits(250)];
    tableOf(all);
    const refines = await read();
    const shown = refines.filter((r) => r.kind === "change").map((r) => r.id);
    expect(shown).toContain(all[199]!.id);
    expect(shown).not.toContain(all[250]!.id);
    expect(undoableIds(refines)).toEqual([]);
    expect(refines.filter((r) => r.kind === "change").every((r) => r.undoable === false)).toBe(true);
    expect(mocks.sessionRuns).toHaveBeenCalledWith({ ascending: false, limit: 200 });
  });

  it("an undo of the newest edit past the window still hides Undo on every shown edit", async () => {
    const root = build();
    const list = edits(230);
    tableOf([root, ...list, undo(list[229]!.id)]);
    expect(undoableIds(await read())).toEqual([]);
  });

  it("the newest edit is flagged when it sits exactly at the window edge", async () => {
    const root = build();
    const list = edits(199);
    tableOf([root, ...list]);
    const refines = await read();
    expect(undoableIds(refines)).toEqual([list[198]!.id]);
    expect(mocks.sessionRuns).toHaveBeenCalledTimes(2);
  });
});
