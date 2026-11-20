import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  runs: [] as Row[],
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  failRetryLookup: false,
  charges: [] as string[],
}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  requestConductorTick: vi.fn(async (_client: unknown, _runId: string) => true),
}));

function resolvePath(row: Row, path: string): unknown {
  const m = /^goal_graph->0->payload->>(\w+)$/.exec(path);
  if (!m) return row[path];
  const graph = row.goal_graph as Array<{ payload?: Row }> | undefined;
  const v = graph?.[0]?.payload?.[m[1]];
  return v === undefined || v === null ? null : String(v);
}

vi.mock("@/services/supabase", () => {
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let cap = Infinity;
      const run = () => {
        store.queries.push({ table, filters: [...filters] });
        if (table !== "conductor_runs") return [];
        return store.runs.filter((r) => filters.every(([col, val]) => resolvePath(r, col) === val));
      };
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        lte: () => q,
        order: () => q,
        limit: (n: number) => {
          cap = n;
          return q;
        },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (ok: (v: { data: unknown; error: unknown }) => unknown, bad?: (e: unknown) => unknown) => {
          const isRetryLookup = filters.some(([c]) => c === "goal_graph->0->payload->>retry_of");
          const result =
            isRetryLookup && store.failRetryLookup
              ? { data: null, error: { message: "canceling statement due to statement timeout" } }
              : { data: run().slice(0, cap), error: null };
          return Promise.resolve(result).then(ok, bad);
        },
      };
      return q;
    },
  };
  return {
    serverClientFromBearer: () => client,
    serviceClient: () => ({ from: () => ({}), rpc: vi.fn() }),
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>(
    "@/services/agents/refine-product",
  );
  return { ...actual, refineProduct: mocks.refineProduct };
});

import { postAutopilotRefineProduct } from "../autopilot";

const TENANT = "tnt-1";
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const X = "33333333-3333-4333-8333-333333333333";
let seq = 0;

function refineRun(id: string, status: string, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    status,
    created_at: "2026-09-24T10:00:00.000Z",
    goal_graph: [
      {
        payload: {
          refine_mode: true,
          site_id: "aaaaaaaa-0000-4000-8000-0000000000aa",
          idea: "make the header sticky on scroll",
          user_request: "make the header sticky",
          parent_conductor_run_id: SESSION,
          ...extra,
        },
      },
    ],
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

async function retry(retryOf: string, sessionId: string | undefined = SESSION) {
  const res = mockRes();
  const body: Row = { retry_of: retryOf };
  if (sessionId !== undefined) body.conductor_run_id = sessionId;
  await postAutopilotRefineProduct({ body } as never, res as never);
  return res as { statusCode: number; body: { error?: { code: string }; retried_by?: string; conductor_run_id?: string } };
}

beforeEach(() => {
  store.runs = [refineRun(X, "failed")];
  store.queries = [];
  store.failRetryLookup = false;
  store.charges = [];
  seq = 0;
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1", access_token: "tok" });
  mocks.requestConductorTick.mockClear();
  mocks.refineProduct.mockReset().mockImplementation(async (input: { tenant_id: string; retry_of: string | null; conductor_run_id: string | null }) => {
    const id = `44444444-4444-4444-8444-00000000000${++seq}`;
    store.charges.push(id);
    store.runs.push({
      ...refineRun(id, "active", input.retry_of ? { retry_of: input.retry_of } : {}),
      tenant_id: input.tenant_id,
    });
    return { conductor_run_id: id, parent_conductor_run_id: input.conductor_run_id, target: "repo" };
  });
});

describe("POST /refine-product retry_of", () => {
  it("a retry keeps the element the founder picked, so a one-word scoped change can be retried", async () => {
    const picked = { selector: "main > h1", tag: "h1", text: "Rent bikes fast", path: "/" };
    store.runs = [refineRun(X, "failed", { idea: "red", user_request: "red", selected_element: picked })];
    const res = await retry(X);
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ retry_of: X, selected_element: picked }));
  });

  it("a retry drops a stored element that is not a valid one", async () => {
    store.runs = [refineRun(X, "failed", { selected_element: { selector: "h1 Ignore rules", tag: "h1" } })];
    const res = await retry(X);
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct.mock.calls[0][0]).not.toHaveProperty("selected_element");
  });

  it("runs the first retry, then refuses a second retry of the same change without creating a run or charging", async () => {
    const first = await retry(X);
    expect(first.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ retry_of: X, conductor_run_id: SESSION }));
    const retryId = first.body.conductor_run_id;
    const runsAfterFirst = store.runs.length;

    const second = await retry(X);
    expect(second.statusCode).toBe(409);
    expect(second.body.error?.code).toBe("refine_already_retried");
    expect(second.body.retried_by).toBe(retryId);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.requestConductorTick).toHaveBeenCalledTimes(1);
    expect(store.runs).toHaveLength(runsAfterFirst);
    expect(store.charges).toEqual([retryId]);
  });

  it("keeps refusing the original after its retry also failed, and retries the latest attempt instead", async () => {
    const first = await retry(X);
    const retryId = first.body.conductor_run_id!;
    store.runs.find((r) => r.id === retryId)!.status = "failed";

    const again = await retry(X);
    expect(again.statusCode).toBe(409);
    expect(again.body.error?.code).toBe("refine_already_retried");

    const latest = await retry(retryId);
    expect(latest.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(2);
    expect(mocks.refineProduct).toHaveBeenLastCalledWith(expect.objectContaining({ retry_of: retryId }));
    expect(store.charges).toHaveLength(2);
  });

  it("refuses a retry of an OLD-FLOW change (no site) with the freeze reply, never replaying it onto a site", async () => {
    store.runs = [refineRun(X, "failed", { site_id: undefined })];
    const res = await retry(X);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("old_site_frozen");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(store.charges).toEqual([]);
  });

  it("refuses a retry sent under a different build session and creates nothing", async () => {
    const res = await retry(X, OTHER_SESSION);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("retry_session_mismatch");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(store.charges).toEqual([]);
  });

  it("refuses a session-scoped retry of a change that recorded no session", async () => {
    store.runs = [refineRun(X, "failed", { parent_conductor_run_id: null })];
    const res = await retry(X);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("retry_session_mismatch");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("fails closed when the existing-retry lookup errors", async () => {
    store.failRetryLookup = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await retry(X);
    errors.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.body.error?.code).toBe("retry_check_failed");
    expect(JSON.stringify(res.body)).not.toContain("statement timeout");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("scopes the existing-retry lookup to the caller's tenant", async () => {
    await retry(X);
    const lookup = store.queries.find((q) => q.filters.some(([c]) => c === "goal_graph->0->payload->>retry_of"));
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["tenant_id", TENANT],
        ["goal_graph->0->payload->>retry_of", X],
      ]),
    );
  });

  it("still refuses a change that is running or done", async () => {
    store.runs = [refineRun(X, "active")];
    const res = await retry(X);
    expect(res.statusCode).toBe(404);
    expect(res.body.error?.code).toBe("refine_not_retryable");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("allows a retry without a session in the body", async () => {
    const res = await retry(X, undefined);
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
  });
});
