import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "owner" as string, tenant_id: "11111111-1111-4111-8111-111111111111" }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: auth.tenant_id, user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(auth.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/services/agents/start-product-build", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/start-product-build")>()),
  realResolveOwnerEmail: vi.fn(async () => "founder@example.test"),
}));
const run = vi.hoisted(() => ({ impl: null as null | ((input: unknown) => Promise<unknown>) }));
vi.mock("@/services/sites/site-duplicate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sites/site-duplicate")>()),
  duplicateSite: vi.fn((input: unknown) => run.impl!(input)),
}));

import { postSiteDuplicate } from "../site-duplicate";
import { DuplicateRefused, type DuplicateSiteDeps } from "@/services/sites/site-duplicate";
import { DoubleBuildInFlight } from "@/services/agents/start-product-build";

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
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const deps = () => ({}) as DuplicateSiteDeps;
const call = async (site_id = SITE) => {
  const res = mockRes();
  await postSiteDuplicate({ params: { site_id } } as never, res as never, deps);
  return res;
};

beforeEach(() => {
  auth.role = "owner";
  run.impl = async () => ({ site_id: "s2", conductor_run_id: "run-2", name: "X (copy)" });
});

describe("POST /api/workspace/sites/:site_id/duplicate", () => {
  it("copies for an owner, with the tenant taken from auth, never the request", async () => {
    const seen: unknown[] = [];
    run.impl = async (input) => (seen.push(input), { site_id: "s2", conductor_run_id: "run-2", name: "X (copy)" });
    const res = mockRes();
    await postSiteDuplicate(
      { params: { site_id: SITE }, body: { tenant_id: "someone-else" }, get: (h: string) => (h === "Idempotency-Key" ? "dup-key-12345" : undefined) } as never,
      res as never,
      deps,
    );
    expect(res.statusCode).toBe(201);
    expect(seen).toEqual([{ tenant_id: auth.tenant_id, source_site_id: SITE, user_id: "u1", owner_email: "founder@example.test", request_key: "dup-key-12345" }]);
  });

  it("refuses a member, and a malformed id, before anything runs", async () => {
    let ran = false;
    run.impl = async () => ((ran = true), {});
    auth.role = "member";
    expect((await call()).statusCode).toBe(403);
    auth.role = "owner";
    expect((await call("../../x")).statusCode).toBe(400);
    expect(ran).toBe(false);
  });

  it("maps refusals and a running build to plain answers, and hides other errors", async () => {
    run.impl = async () => {
      throw new DuplicateRefused(404, "site_not_found", "That site was not found.");
    };
    expect(await call()).toMatchObject({ statusCode: 404, body: { error: { code: "site_not_found" } } });
    run.impl = async () => {
      throw new DoubleBuildInFlight("t");
    };
    expect(await call()).toMatchObject({ statusCode: 409, body: { error: { code: "build_already_in_progress" } } });
    run.impl = async () => {
      throw new Error("token ghp_secret leaked");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call();
    errors.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("ghp_secret");
  });
});
