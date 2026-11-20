import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  flags: {} as Record<string, boolean>,
}));

vi.mock("@/services/website/site-offline", () => ({ siteIsSuspended: async () => false }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/settings")>()),
  getBoolSetting: async (key: string) => mocks.flags[key] ?? true,
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const q: Record<string, unknown> = {};
      let cols: string[] = [];
      q.select = (list: string) => {
        cols = list.split(",").map((c) => c.trim().split(":")[0]);
        return q;
      };
      for (const m of ["eq", "order"]) q[m] = () => q;
      q.limit = async () => ({
        data: mocks.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => cols.includes(k)))),
        error: null,
      });
      return q;
    },
  }),
  serviceClient: () => {
    throw new Error("no service client in this route");
  },
}));

import { getAutopilotBuildSessions } from "../autopilot";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const SITE_RUN = "44444444-4444-4444-8444-444444444444";
const SITE_ID = "55555555-5555-4555-8555-555555555555";
const PROVISIONED = { p0_stage: "provision", p0_status: "done" };

function run(id: string, minute: number, over: Record<string, unknown> = {}) {
  const at = `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
    objective: `Build product: Acme — site ${id.slice(0, 4)}`,
    status: "done",
    created_at: at,
    updated_at: at,
    failure_class: null,
    refine_mode: null,
    parent_id: null,
    ...over,
  };
}

async function sessions() {
  const res = mockRes();
  await getAutopilotBuildSessions({ query: {} } as never, res as never);
  expect(res.statusCode).toBe(200);
  const body = res.body as { sessions: Array<{ id: string; state: string; is_current: boolean }> };
  return Object.fromEntries(body.sessions.map((s) => [s.id, s]));
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
  mocks.flags = { build_chat_thread_follows_build: false };
});

describe("Your sites: old-flow builds replaced by a newer old-flow build", () => {
  it("the earlier finished build reads Replaced, only the current one reads Ready", async () => {
    mocks.rows = [run(SECOND, 30), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("replaced");
    expect(byId[FIRST].is_current).toBe(false);
    expect(byId[SECOND].state).toBe("ready");
    expect(byId[SECOND].is_current).toBe(true);
  });

  it("three old-flow builds at one address: only the newest is Ready", async () => {
    mocks.rows = [run(THIRD, 50), run(SECOND, 30), run(FIRST, 10)];
    const byId = await sessions();
    expect([byId[FIRST].state, byId[SECOND].state, byId[THIRD].state]).toEqual(["replaced", "replaced", "ready"]);
  });

  it("a later build that failed at provisioning never replaced anything, so the live build stays Ready", async () => {
    mocks.rows = [run(SECOND, 30, { status: "failed", failure_class: "provision_failed" }), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("ready");
    expect(byId[SECOND].state).toBe("failed");
  });

  it("a later build still provisioning has not replaced it yet", async () => {
    mocks.rows = [run(SECOND, 30, { status: "provisioning" }), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("ready");
  });

  it("a later build that failed after provisioning did replace it", async () => {
    mocks.rows = [run(SECOND, 30, { status: "failed", failure_class: "repair_exhausted", ...PROVISIONED }), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("replaced");
    expect(byId[SECOND].state).toBe("failed");
  });

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a later build stopped as %s before its provision step finished never replaced it, so the live build stays Ready and current",
    async (failure_class) => {
      mocks.rows = [run(SECOND, 30, { status: "failed", failure_class }), run(FIRST, 10)];
      const byId = await sessions();
      expect(byId[FIRST].state).toBe("ready");
      expect(byId[FIRST].is_current).toBe(true);
      expect(byId[SECOND].state).toBe("failed");
    },
  );

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a later build stopped as %s after its provision step finished did replace it",
    async (failure_class) => {
      mocks.rows = [run(SECOND, 30, { status: "failed", failure_class, ...PROVISIONED }), run(FIRST, 10)];
      const byId = await sessions();
      expect(byId[FIRST].state).toBe("replaced");
      expect(byId[FIRST].is_current).toBe(false);
    },
  );

  it("a new-flow site never replaces an old-flow app and is never marked replaced", async () => {
    mocks.rows = [run(SITE_RUN, 30, { s1: SITE_ID }), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("ready");
    expect(byId[SITE_RUN].state).toBe("ready");
  });

  it("key off: every finished build reads Ready, as before", async () => {
    mocks.flags.build_old_flow_one_site_guard = false;
    mocks.rows = [run(SECOND, 30), run(FIRST, 10)];
    const byId = await sessions();
    expect(byId[FIRST].state).toBe("ready");
    expect(byId[SECOND].state).toBe("ready");
  });
});
