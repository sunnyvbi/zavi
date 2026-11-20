import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  claims: [] as Array<{ tenant: string; build: string }>,
  claim: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  generate: vi.fn(async () => [{ key: "k", label: "Test a Booking", prompt: "p" }]),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: TENANT, user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/supabase", async () => {
  const { fakeSb } = await import("@/services/agents/__tests__/fake-sb");
  return { serverClientFromBearer: () => fakeSb(h.tables), serviceClient: () => fakeSb(h.tables) };
});
vi.mock("@/services/agents/build-chips-generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/build-chips-generate")>()),
  generateBuildChips: h.generate,
  takeMoreSlot: h.claim,
}));

import { getAutopilotChips } from "../autopilot";

function seed(status: string) {
  h.tables = {
    conductor_runs: [
      {
        id: SESSION,
        tenant_id: TENANT,
        kind: "build_app",
        status,
        objective: "Build product: Paws & Suds — a dog grooming booking site",
        goal_graph: [{ payload: { stage: "build" } }],
        created_at: "2026-10-05T10:00:00Z",
      },
    ],
  };
}

async function call(query: Record<string, unknown> = { session_id: SESSION }): Promise<{ status: number; body: unknown }> {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  } as unknown as Response;
  await getAutopilotChips({ query, headers: {} } as unknown as Request, res);
  return out;
}

const readyArg = () => (h.generate.mock.calls.at(-1) as unknown as [{ ready?: boolean }])[0].ready;

beforeEach(() => {
  h.generate.mockClear();
  delete process.env.BUILDER_SUGGESTION_CHIPS_ENABLED;
});

describe("GET /api/workspace/autopilot/chips ready state", () => {
  it("asks for owner next steps once the build run is done", async () => {
    seed("done");
    const out = await call();

    expect(out.status).toBe(200);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(readyArg()).toBe(true);
  });

  it.each(["active", "provisioning", "paused", "failed", "halted"])("asks for build actions while the run is %s", async (status) => {
    seed(status);
    await call();

    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(readyArg()).toBe(false);
  });
});

describe("GET /api/workspace/autopilot/chips more suggestions", () => {
  beforeEach(async () => {
    const { MORE_PER_BUILD } = await import("@/services/agents/build-chips-generate");
    h.claims = [];
    h.claim.mockReset();
    h.claim.mockImplementation(async (_client: unknown, tenant: string, build: string) => {
      if (h.claims.filter((c) => c.tenant === tenant && c.build === build).length >= MORE_PER_BUILD) return false;
      h.claims.push({ tenant, build });
      return true;
    });
    h.generate.mockImplementation((async (args: { exclude?: string[]; allowMore?: () => Promise<boolean> }) =>
      args.exclude?.length && args.allowMore && !(await args.allowMore()) ? [] : [{ key: "n", label: "New One", prompt: "p" }]) as never);
  });

  it("passes the shown labels, claims through the caller's client for its own tenant and build, and stops past the cap", async () => {
    const { MORE_PER_BUILD } = await import("@/services/agents/build-chips-generate");
    seed("done");
    for (let i = 0; i < MORE_PER_BUILD; i++) {
      const out = await call({ session_id: SESSION, more: "1", exclude: ["Add Reviews", `L${i}`] });
      expect(out.body).toEqual({ chips: [{ key: "n", label: "New One", prompt: "p" }], more_capped: false });
    }
    const args = (h.generate.mock.calls.at(-1) as unknown as [{ exclude: string[] }])[0];
    expect(args.exclude).toEqual(["Add Reviews", `L${MORE_PER_BUILD - 1}`]);
    expect(h.claim.mock.calls[0]!.slice(1)).toEqual([TENANT, SESSION]);
    const over = await call({ session_id: SESSION, more: "1", exclude: ["Add Reviews", "again"] });
    expect(over.body).toEqual({ chips: [], more_capped: true });
  });

  it("a failed claim answers 503 (retryable), never more_capped", async () => {
    seed("done");
    h.claim.mockRejectedValueOnce(new Error("db down"));
    const out = await call({ session_id: SESSION, more: "1", exclude: ["Add Reviews"] });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: { code: "chips_more_unavailable", message: "Couldn't get more suggestions. Try again." } });
  });

  it("a plain read never claims", async () => {
    seed("done");
    await call();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("never generates or claims for another tenant's build", async () => {
    seed("done");
    h.tables.conductor_runs![0]!.tenant_id = "22222222-2222-4222-8222-222222222222";
    const out = await call({ session_id: SESSION, more: "1", exclude: ["Add Reviews"] });
    expect(out.body).toEqual({ chips: [] });
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
});
