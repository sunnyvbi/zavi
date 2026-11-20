import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({ runs: [] as Row[] }));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  requestConductorTick: vi.fn(async (_client: unknown, _runId: string) => true),
  holdBusySiteChange: vi.fn(async () => "held"),
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
      const run = () =>
        table === "conductor_runs" ? store.runs.filter((r) => filters.every(([col, val]) => resolvePath(r, col) === val)) : [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        lte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (ok: (v: { data: unknown; error: unknown }) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(ok, bad),
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
vi.mock("@/services/auth/tenant-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: async () => true,
}));
vi.mock("@/services/company/owner-chat-facts", () => ({ saveOwnerChatFacts: vi.fn(async () => undefined) }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("../website-chat", () => ({ holdBusySiteChange: mocks.holdBusySiteChange }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>(
    "@/services/agents/refine-product",
  );
  return {
    ...actual,
    refineProduct: mocks.refineProduct,
    realRefineProductDeps: {
      ...actual.realRefineProductDeps,
      loadSiteForRun: async () => ({ id: "aaaaaaaa-0000-4000-8000-0000000000aa" }),
    },
  };
});

import { postAutopilotRefineProduct } from "../autopilot";
import { DoubleBuildInFlight } from "@/services/agents/start-product-build";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const FAILED = "33333333-3333-4333-8333-333333333333";
const SHOT = `${TENANT}/22222222-2222-4222-8222-222222222222.jpg`;
const FOREIGN = `${OTHER_TENANT}/44444444-4444-4444-8444-444444444444.jpg`;

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

async function post(body: Row) {
  const res = mockRes();
  await postAutopilotRefineProduct({ body } as never, res as never);
  return res as { statusCode: number; body: { error?: { code: string }; queued?: boolean } };
}

beforeEach(() => {
  store.runs = [];
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1", access_token: "tok" });
  mocks.requestConductorTick.mockClear();
  mocks.holdBusySiteChange.mockClear();
  mocks.refineProduct.mockReset().mockResolvedValue({
    conductor_run_id: "55555555-5555-4555-8555-555555555555",
    parent_conductor_run_id: SESSION,
    target: "repo",
  });
});

describe("POST /refine-product with an attached screenshot", () => {
  it("passes this tenant's screenshot to the change, and a short 'fix this' is enough with one", async () => {
    const res = await post({ message: "fix", conductor_run_id: SESSION, image_paths: [SHOT] });
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, image_paths: [SHOT] }));
  });

  it.each([
    ["another tenant's image", [FOREIGN]],
    ["a foreign image hidden among own", [SHOT, FOREIGN]],
    ["a document instead of an image", [`${TENANT}/66666666-6666-4666-8666-666666666666.pdf`]],
    [
      "more than three images",
      [
        SHOT,
        `${TENANT}/77777777-7777-4777-8777-777777777777.jpg`,
        `${TENANT}/88888888-8888-4888-8888-888888888888.jpg`,
        `${TENANT}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`,
      ],
    ],
  ])("refuses %s before any change starts", async (_label, image_paths) => {
    const res = await post({ message: "make this section look like this", conductor_run_id: SESSION, image_paths });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe("invalid_image_paths");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.requestConductorTick).not.toHaveBeenCalled();
  });

  it("never parks a change with a screenshot as text-only while a build runs", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight("busy"));
    const res = await post({ message: "make this section look like this", conductor_run_id: SESSION, image_paths: [SHOT] });
    expect(mocks.holdBusySiteChange).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.queued).toBeUndefined();
  });

  it("a retry of a failed change keeps its screenshot", async () => {
    store.runs = [
      {
        id: FAILED,
        tenant_id: TENANT,
        status: "failed",
        created_at: "2026-11-03T10:00:00.000Z",
        goal_graph: [
          {
            payload: {
              refine_mode: true,
              site_id: "aaaaaaaa-0000-4000-8000-0000000000aa",
              idea: "make this section look like this",
              user_request: "make this section look like this",
              parent_conductor_run_id: SESSION,
              request_image_paths: [SHOT, FOREIGN],
            },
          },
        ],
      },
    ];
    const res = await post({ retry_of: FAILED, conductor_run_id: SESSION });
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ retry_of: FAILED, image_paths: [SHOT] }));
  });
});
