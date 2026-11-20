import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  tabsSession: vi.fn(),
  runsResult: vi.fn(),
  conductorCalls: [] as Array<[string, unknown[]]>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/visibility", () => ({
  filterTenantVisibleTabs: async (tabs: unknown[]) => tabs,
}));
vi.mock("@/services/workspace/scrubThreadBindings", () => ({
  scrubForeignThreadBindings: async (tabs: unknown[]) => tabs,
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    rpc: (fn: string) => {
      if (fn !== "get_tabs_session") throw new Error(`unexpected rpc ${fn}`);
      return Promise.resolve({ data: [mocks.tabsSession()], error: null });
    },
  }),
  serviceClient: () => ({
    from: (table: string) => {
      mocks.conductorCalls.push(["from", [table]]);
      const api: Record<string, unknown> = {};
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          mocks.conductorCalls.push([name, args]);
          return api;
        };
      for (const m of ["select", "in", "eq"]) api[m] = record(m);
      api.or = (...args: unknown[]) => {
        mocks.conductorCalls.push(["or", args]);
        return Promise.resolve(mocks.runsResult());
      };
      return api;
    },
  }),
}));

import { workspaceTabsSessionGet } from "../tabs-session";

const TENANT_B = "a7ec7367-acc8-4abc-995b-7da60a572de3";
const RUN_IN_TENANT_A = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const RUN_IN_TENANT_B = "33333333-3333-4333-8333-333333333333";

function call() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return workspaceTabsSessionGet({} as never, res as never).then(() => res);
}

describe("GET /api/workspace/tabs-session — build tab from another workspace", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset();
    mocks.tabsSession.mockReset();
    mocks.runsResult.mockReset();
    mocks.conductorCalls.length = 0;
    mocks.requireAuth.mockResolvedValue({
      tenant_id: TENANT_B,
      user_id: "user-1",
      access_token: "jwt",
    });
  });

  it("rebinds a build tab whose session lives in the tenant the user just left", async () => {
    mocks.tabsSession.mockReturnValue({
      tabs: [
        { id: "home", kind: "home", title: "Home", payload: { kind: "home" } },
        {
          id: "build-tab",
          kind: "build",
          title: "Build",
          payload: { kind: "build", sessionId: RUN_IN_TENANT_A },
        },
      ],
      active_tab_id: "build-tab",
    });
    mocks.runsResult.mockReturnValue({ data: [], error: null });

    const res = await call();

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      tabs: Array<{ id: string; payload: { kind: string; sessionId?: string | null } }>;
      active_tab_id: string | null;
    };
    const build = body.tabs.find((t) => t.id === "build-tab");
    expect(build?.payload).toEqual({ kind: "build", sessionId: null });
    expect(body.active_tab_id).toBe("build-tab");
    expect(mocks.conductorCalls).toContainEqual(["eq", ["tenant_id", TENANT_B]]);
    expect(mocks.conductorCalls).toContainEqual(["eq", ["kind", "build_app"]]);
  });

  it("keeps a build session the active tenant can read", async () => {
    mocks.tabsSession.mockReturnValue({
      tabs: [
        {
          id: "build-tab",
          kind: "build",
          title: "Build",
          payload: { kind: "build", sessionId: RUN_IN_TENANT_B },
        },
      ],
      active_tab_id: "build-tab",
    });
    mocks.runsResult.mockReturnValue({ data: [{ id: RUN_IN_TENANT_B }], error: null });

    const res = await call();
    const body = res.body as { tabs: Array<{ payload: { sessionId?: string | null } }> };
    expect(body.tabs[0].payload.sessionId).toBe(RUN_IN_TENANT_B);
  });

  it("keeps the stale binding when the ownership read fails", async () => {
    mocks.tabsSession.mockReturnValue({
      tabs: [
        {
          id: "build-tab",
          kind: "build",
          title: "Build",
          payload: { kind: "build", sessionId: RUN_IN_TENANT_A },
        },
      ],
      active_tab_id: "build-tab",
    });
    mocks.runsResult.mockReturnValue({ data: null, error: { message: "timeout" } });

    const res = await call();
    const body = res.body as { tabs: Array<{ payload: { sessionId?: string | null } }> };
    expect(body.tabs[0].payload.sessionId).toBe(RUN_IN_TENANT_A);
  });
});
