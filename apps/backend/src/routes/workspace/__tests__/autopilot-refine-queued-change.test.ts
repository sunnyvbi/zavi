import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const SITE = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  loadSiteForRun: vi.fn(),
  hold: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("a plain refine must not read the database in the route");
  },
  serviceClient: () => ({ from: () => ({}), rpc: vi.fn() }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", async (orig) => ({ ...(await orig<object>()), requireTenantRole: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: vi.fn(async () => true),
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>("@/services/agents/refine-product");
  return {
    ...actual,
    refineProduct: mocks.refineProduct,
    realRefineProductDeps: { ...actual.realRefineProductDeps, loadSiteForRun: mocks.loadSiteForRun },
  };
});
vi.mock("../website-chat", () => ({ holdBusySiteChange: mocks.hold }));

import { postAutopilotRefineProduct } from "../autopilot";
import { DoubleBuildInFlight, NoProvisionedRepo } from "@/services/agents/refine-product";

async function post(body: Record<string, unknown>) {
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
  await postAutopilotRefineProduct({ body } as never, res as never);
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" });
  mocks.refineProduct.mockReset().mockRejectedValue(new DoubleBuildInFlight("tnt-1"));
  mocks.loadSiteForRun.mockReset().mockResolvedValue({ id: SITE });
  mocks.hold.mockReset().mockResolvedValue("Your site is still building. I'll make this change as soon as it finishes.");
});

describe("POST /refine-product while the site is still building", () => {
  it("holds a plain change for this site and answers 202 with the chat line", async () => {
    const res = await post({ message: "Our prices start at $80 for a standard clean", conductor_run_id: SESSION });
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ ok: true, queued: true, chat: "Your site is still building. I'll make this change as soon as it finishes." });
    expect(mocks.loadSiteForRun).toHaveBeenCalledWith("tnt-1", SESSION);
    expect(mocks.hold).toHaveBeenCalledWith({
      tenant_id: "tnt-1",
      site_id: SITE,
      conductor_run_id: SESSION,
      message: "Our prices start at $80 for a standard clean",
      user_id: "u1",
    });
  });

  it("a first build whose repo is not ready yet holds the change too, instead of saying there is no app", async () => {
    mocks.refineProduct.mockRejectedValue(new NoProvisionedRepo("tnt-1"));
    const res = await post({ message: "Add our hours: open 9am to 6pm Monday to Saturday", conductor_run_id: SESSION });
    expect(res.statusCode).toBe(202);
    expect(mocks.hold).toHaveBeenCalledTimes(1);
    mocks.loadSiteForRun.mockResolvedValue(null);
    const none = await post({ message: "Add our hours: open 9am to 6pm Monday to Saturday", conductor_run_id: SESSION });
    expect(none.statusCode).toBe(409);
    expect((none.body as { error: { code: string } }).error.code).toBe("no_provisioned_repo");
  });

  it.each([
    ["a picked element", { selection: { selector: "h1", tag: "h1", text: "Hi" } }],
    ["a photo retry", { photo_retry: true }],
  ])("never holds %s: those stay the old busy refusal", async (_label, extra) => {
    const res = await post({ message: "make it bigger please", conductor_run_id: SESSION, ...extra });
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(res.statusCode).not.toBe(202);
  });

  it("no site for the session (old workspace app): the old busy refusal", async () => {
    mocks.loadSiteForRun.mockResolvedValue(null);
    const res = await post({ message: "Our prices start at $80 for a standard clean", conductor_run_id: SESSION });
    expect(res.statusCode).toBe(409);
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("an unreadable site or a refused hold is never reported as held", async () => {
    mocks.loadSiteForRun.mockRejectedValueOnce(new Error("db down"));
    expect((await post({ message: "Our prices start at $80 for a standard clean", conductor_run_id: SESSION })).statusCode).toBe(409);
    mocks.hold.mockResolvedValueOnce(null);
    const res = await post({ message: "Our prices start at $80 for a standard clean", conductor_run_id: SESSION });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("build_already_in_progress");
  });

  it("a malicious message is held sanitized, as the refine itself would get it", async () => {
    await post({ message: "Add our prices <script>alert(1)</script> $80 a clean", conductor_run_id: SESSION });
    expect(mocks.hold.mock.calls[0]![0].message).not.toContain("<script>");
  });
});
