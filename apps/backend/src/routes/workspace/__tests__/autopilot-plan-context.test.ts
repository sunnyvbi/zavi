
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  app: null as unknown,
  resolveError: null as Error | null,
  context: "ROUTE FILES\nsrc/App.tsx" as string | null,
  readArgs: [] as unknown[],
  planArgs: [] as unknown[],
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/supabase")>()),
  serverClientFromBearer: () => ({ from: () => { throw new Error("no table read expected"); } }),
}));
vi.mock("@/services/sites/app-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sites/app-identity")>();
  return {
    ...actual,
    resolveAppForRequest: vi.fn(async () => {
      if (h.resolveError) throw h.resolveError;
      return h.app;
    }),
  };
});
vi.mock("@/services/agents/build-suggestion-context", () => ({
  readBuiltAppSuggestionContext: vi.fn(async (args: unknown) => {
    h.readArgs.push(args);
    return h.context;
  }),
}));
vi.mock("@/services/agents/plan-generate", () => ({
  generateBuildPlan: vi.fn(async (args: unknown) => {
    h.planArgs.push(args);
    return "## Approach\nDo it.";
  }),
}));

import { postAutopilotPlan } from "../autopilot";
import { AppSelectionError } from "@/services/sites/app-identity";

type Res = { statusCode: number; body: unknown; status: (n: number) => Res; json: (b: unknown) => Res };
function mockRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    status(n) {
      res.statusCode = n;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const site = { id: "s1", status: "live", github_full_name: "Praxis-build/site-abc" };

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "umbrella";
  h.app = { kind: "site", site, run_id: "r1", via: "build_session" };
  h.resolveError = null;
  h.context = "ROUTE FILES\nsrc/App.tsx";
  h.readArgs.length = 0;
  h.planArgs.length = 0;
});

describe("POST /api/workspace/autopilot/plan", () => {
  it("plans a change against the named session's site code", async () => {
    const res = mockRes();
    await postAutopilotPlan(
      { body: { idea: "Add a prices section", mode: "refine", build_session_id: "r1" }, query: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(h.readArgs).toEqual([{ full_name: "Praxis-build/site-abc", branch: "main", token: "umbrella" }]);
    expect(h.planArgs).toEqual([{ idea: "Add a prices section", mode: "refine", appContext: "ROUTE FILES\nsrc/App.tsx" }]);
    expect(res.body).toEqual({ plan_markdown: "## Approach\nDo it." });
  });

  it("refuses a session that is not this workspace's, without reading any code", async () => {
    h.resolveError = new AppSelectionError(404, "site_not_found", "That build is not in this workspace.");
    const res = mockRes();
    await postAutopilotPlan(
      { body: { idea: "Add a prices section", mode: "refine", build_session_id: "foreign" }, query: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect(h.readArgs).toHaveLength(0);
    expect(h.planArgs).toHaveLength(0);
  });

  it("plans from the request alone for a new build, a change with no session, or a site with no code", async () => {
    await postAutopilotPlan({ body: { idea: "A site for a florist", mode: "build", build_session_id: "r1" }, query: {} } as never, mockRes() as never);
    await postAutopilotPlan({ body: { idea: "Add a prices section", mode: "refine" }, query: {} } as never, mockRes() as never);
    h.app = { kind: "site", site: { ...site, github_full_name: null }, run_id: "r1", via: "build_session" };
    await postAutopilotPlan(
      { body: { idea: "Add a prices section", mode: "refine", build_session_id: "r1" }, query: {} } as never,
      mockRes() as never,
    );
    expect(h.readArgs).toHaveLength(0);
    expect(h.planArgs.map((a) => (a as { appContext: unknown }).appContext)).toEqual([null, null, null]);
  });
});
