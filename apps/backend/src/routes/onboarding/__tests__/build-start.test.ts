
import { describe, it, expect, vi, beforeEach } from "vitest";

const signup = vi.hoisted(() => ({
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  draftGoal: vi.fn(async (..._a: unknown[]) => undefined),
  attribution: vi.fn<Parameters<typeof import("@/services/tenants/signup-attribution").persistSignupAttribution>, Promise<void>>(async () => undefined),
  affiliate: vi.fn(async (..._a: unknown[]) => undefined),
}));

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  profileMaybeSingle: vi.fn(),
  rpc: vi.fn(),
  setTenantSetting: vi.fn(),
  startProductBuild: vi.fn(),
  setup: vi.fn(),
  requestTick: vi.fn(),
  send: vi.fn(),
  beta: vi.fn(),
  capCheck: vi.fn(),
  invalidateCache: vi.fn(),
  getBoolSetting: vi.fn(),
  sendWelcomeBuildEmail: vi.fn(),
  sendBuildNotStartedEmail: vi.fn(),
  notifyNewTenant: vi.fn(),
  inflightRow: vi.fn(),
  inflightTenant: vi.fn(),
  competitorsFromIdea: vi.fn(),
  storeIdeaImages: vi.fn(),
  extractIdeaIntake: vi.fn(),
  getAppSetting: vi.fn(),
  writeTypedFacts: vi.fn(),
  projectFact: vi.fn(),
  seedBootstrap: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../activate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../activate")>()),
  writeTypedFactsFromWizard: mocks.writeTypedFacts,
  persistDraftGoal: signup.draftGoal,
}));
vi.mock("@/services/tenants/signup-attribution", () => ({ persistSignupAttribution: signup.attribution }));
vi.mock("@/services/affiliates/attribution", () => ({ attributeTenant: signup.affiliate }));
vi.mock("@/services/tenants/classify-test-tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenants/classify-test-tenant")>()),
  auditTenantKind: signup.audit,
}));
vi.mock("@/services/company/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/company/facts")>()),
  projectCompanyFactValue: mocks.projectFact,
}));

vi.mock("@/services/onboarding/idea-intake", () => ({ extractIdeaIntake: mocks.extractIdeaIntake }));

vi.mock("@/services/auth/jwt", () => ({ verifyBearer: mocks.verifyBearer }));
vi.mock("@/services/auth/closedBetaGate", () => ({ requireClosedBetaGrant: mocks.beta }));
vi.mock("@/services/auth/tenant-cache", () => ({ invalidateCachedTenant: mocks.invalidateCache }));
vi.mock("@/services/tenants/tenant-create-guard", () => ({ checkSelfServeTenantCap: mocks.capCheck }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.profileMaybeSingle }),
      }),
      update: (values: unknown) => ({
        eq: (col: string, id: string) => mocks.update(table, values, col, id),
      }),
    }),
    rpc: mocks.rpc,
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: (t: string) => {
    mocks.inflightTenant(t);
    const q = {
      from: () => q,
      select: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: mocks.inflightRow,
    };
    return q;
  },
}));
vi.mock("@/services/settings", () => ({
  setTenantSetting: mocks.setTenantSetting,
  getBoolSetting: mocks.getBoolSetting,
  getAppSetting: mocks.getAppSetting,
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendWelcomeBuildEmail: mocks.sendWelcomeBuildEmail,
  sendBuildNotStartedEmail: mocks.sendBuildNotStartedEmail,
}));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ notifyNewTenant: mocks.notifyNewTenant }));
vi.mock("@/services/tenants/bootstrap", () => ({ seedTenantBootstrap: mocks.seedBootstrap }));
vi.mock("@/services/agents/start-product-build", () => ({
  startProductBuildDetached: async (input: unknown) => {
    const started = await mocks.startProductBuild(input);
    return { conductor_run_id: started.conductor_run_id, setup: mocks.setup() };
  },
  InvalidCompanyName: class {
    static messageFor(reason: string) {
      return `invalid company name: ${reason}`;
    }
  },
  DoubleBuildInFlight: class DoubleBuildInFlight extends Error {},
  TooManyBuildsToday: class TooManyBuildsToday extends Error {},
  ProvisionBudgetExceeded: class ProvisionBudgetExceeded extends Error {},
  BuildRepoNotProvisioned: class BuildRepoNotProvisioned extends Error {},
  buildSetupFailedBody: (e: Error) => ({ code: "build_setup_failed", message: e.message, retryable: true }),
}));
vi.mock("@/services/agents/build-credit-preflight", () => ({
  InsufficientCreditsForBuild: class InsufficientCreditsForBuild extends Error {
    constructor(
      public readonly required_credits: number,
      public readonly remaining_credits: number,
      public readonly free_plan: boolean = false,
    ) {
      super(
        `not enough credits to finish this build: it needs about ${required_credits.toLocaleString()} credits ` +
          `($${(required_credits * 0.0025).toFixed(2)}) and this workspace has ${remaining_credits.toLocaleString()} left. ` +
          `Nothing was created — top up and start it again.`,
      );
    }
  },
}));
vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  sanitizeFetchedContent: (s: string) => s,
  xmlEscapeContent: (s: string) => `CLEAN:${s}`,
  decodeXmlEntities: (s: string) => s,
}));
vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/services/agents/conductor-kick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/conductor-kick")>()),
  requestConductorTick: mocks.requestTick,
}));
vi.mock("@/services/company/idea-competitors", () => ({ competitorsFromIdea: mocks.competitorsFromIdea }));
vi.mock("@/services/onboarding/idea-reference-images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboarding/idea-reference-images")>()),
  storeIdeaImages: mocks.storeIdeaImages,
}));

import sharp from "sharp";
import { postOnboardingBuildStart } from "../build-start";
import {
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
  BuildRepoNotProvisioned,
} from "@/services/agents/start-product-build";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}
const req = (body: unknown, query: Record<string, unknown> = {}) => ({ body, query, headers: {} }) as never;
const goodIdea = "A project management app with tasks and a dashboard";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PRODUCT_BUILDER_ENABLED;
  mocks.verifyBearer.mockResolvedValue({ user_id: "user-1", access_token: "tok" });
  mocks.seedBootstrap.mockResolvedValue({ channels_inserted: 0, schedules_inserted: 0, errors: [] });
  mocks.update.mockResolvedValue({ error: null });
  mocks.beta.mockResolvedValue({ ok: true });
  mocks.profileMaybeSingle.mockResolvedValue({ data: { active_tenant_id: null } });
  mocks.rpc.mockResolvedValue({ data: "tenant-new", error: null });
  mocks.setTenantSetting.mockResolvedValue(undefined);
  mocks.startProductBuild.mockResolvedValue({ conductor_run_id: "cr-1" });
  mocks.setup.mockResolvedValue({ conductor_run_id: "cr-1" });
  mocks.send.mockResolvedValue(undefined);
  mocks.capCheck.mockResolvedValue(null);
  mocks.invalidateCache.mockReturnValue(undefined);
  mocks.getBoolSetting.mockResolvedValue(false);
  mocks.sendWelcomeBuildEmail.mockResolvedValue({ sent: true });
  mocks.sendBuildNotStartedEmail.mockResolvedValue({ sent: true });
  mocks.notifyNewTenant.mockReturnValue(undefined);
  mocks.competitorsFromIdea.mockResolvedValue([]);
  mocks.storeIdeaImages.mockResolvedValue([]);
  mocks.extractIdeaIntake.mockResolvedValue({ company_name: null, what_we_sell: null });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("POST /api/onboarding/build-start", () => {
  it("401 when the bearer is missing/invalid (no tenant work)", async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("blocks when the closed-beta gate denies (no tenant created)", async () => {
    mocks.beta.mockResolvedValue({ ok: false, status: 403, code: "beta_required", message: "Invite only." });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 when the company_name is invalid (reserved/empty → no orphan tenant)", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, company_name: "###" }), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("invalid_company_name");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 when the idea is too short", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "hi" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 when the idea is too long", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "x".repeat(4001) }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it("409 when the user already has an active tenant (no 2nd tenant)", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: { active_tenant_id: "tenant-existing" } });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { tenant_id?: string }).tenant_id).toBe("tenant-existing");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("200 happy path → lite RPC, fresh intent, build kicked, anchor event fired", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenant_id: "tenant-new", conductor_run_id: "cr-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("activate_tenant_lite", expect.objectContaining({ p_user_id: "user-1" }));
    expect(mocks.seedBootstrap).toHaveBeenCalledWith("tenant-new");
    expect(mocks.setTenantSetting).toHaveBeenCalledWith("tenant-new", "build_app_intent", "fresh", "user-1");
    expect(mocks.startProductBuild).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "tenant-new", idea: `CLEAN:${goodIdea}` }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tenant.bootstrap_anchors.requested", data: { tenant_id: "tenant-new", seed_text: goodIdea } }),
    );
  });

  it("the web start page's look-pick opt-in reaches the build; without it (mobile) or not exactly true, it does not", async () => {
    await postOnboardingBuildStart(req({ idea: goodIdea, await_look_pick: true }), mockRes() as never);
    expect(mocks.startProductBuild.mock.calls[0][0]).toMatchObject({ await_look_pick: true });
    for (const body of [{ idea: goodIdea }, { idea: goodIdea, await_look_pick: "true" }, { idea: goodIdea, await_look_pick: 1 }]) {
      mocks.startProductBuild.mockClear();
      await postOnboardingBuildStart(req(body), mockRes() as never);
      expect(mocks.startProductBuild).toHaveBeenCalledTimes(1);
      expect(mocks.startProductBuild.mock.calls[0][0]).not.toHaveProperty("await_look_pick");
    }
  });

  it("a picked template reaches the build as a snapshot; one still holding its [blanks] is refused before any tenant is made", async () => {
    const tpl = "book-a-service";
    const filled = "A website for my bike repair shop in Leeds. We offer tune-ups from $40. Customers book a time online.";
    await postOnboardingBuildStart(req({ idea: filled, template: tpl }), mockRes() as never);
    expect(mocks.startProductBuild.mock.calls[0][0].site_template).toMatchObject({ id: tpl, look: { layout: "split" } });
    mocks.startProductBuild.mockClear();
    mocks.rpc.mockClear();
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "A website for my [type of business] in Leeds. Customers book a time online.", template: tpl }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "template_blanks" } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
    const stale = mockRes();
    await postOnboardingBuildStart(req({ idea: filled, template: "retired" }), stale as never);
    expect(stale.statusCode).toBe(400);
    expect(stale.body).toMatchObject({ error: { code: "invalid_template" } });
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("the company is created and the build started without waiting on the intake model; its name comes from the idea", async () => {
    mocks.extractIdeaIntake.mockReturnValue(new Promise(() => undefined));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "I run a home cleaning service in San Jose" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("activate_tenant_lite", expect.objectContaining({ p_display_name: "Home Cleaning San Jose" }));
    const call = mocks.startProductBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(call.company_name).toBe("Home Cleaning San Jose");
    expect(call).not.toHaveProperty("site_name");
  });

  it("a brand name the intake model would invent is never used: the fixed name rule wins", async () => {
    mocks.extractIdeaIntake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: "Dog grooming" });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "i want to make car rental landing page" }), res as never);
    expect(res.statusCode).toBe(200);
    expect((mocks.startProductBuild.mock.calls[0][0] as { company_name: string }).company_name).toBe("Car Rental");
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("Paws and Suds");
  });

  it("the intake model still fills what the business sells, in the background, at the machine rank", async () => {
    mocks.writeTypedFacts.mockReset().mockResolvedValue(undefined);
    mocks.projectFact.mockReset().mockResolvedValue({ error: null });
    mocks.extractIdeaIntake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: "Dog grooming" });
    await postOnboardingBuildStart(req({ idea: goodIdea }), mockRes() as never);
    await vi.waitFor(() => expect(mocks.projectFact).toHaveBeenCalledWith(expect.anything(), "what_we_sell", "Dog grooming", "ai_estimated", expect.any(String)));
    expect(mocks.writeTypedFacts.mock.calls[0][3]).toEqual({ skipWhatWeSell: true });
    expect(mocks.projectFact.mock.calls.some((c) => c[2] === "Paws and Suds")).toBe(false);
  });

  it("an intake model failure in the background still saves the founder's own words", async () => {
    mocks.writeTypedFacts.mockReset().mockResolvedValue(undefined);
    mocks.extractIdeaIntake.mockRejectedValue(new Error("model down"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(mocks.writeTypedFacts).toHaveBeenCalled());
    expect(mocks.writeTypedFacts.mock.calls[0][3]).toEqual({ skipWhatWeSell: false });
  });

  it("names the company after what the idea is about, not its first words, when the intake model gives no name", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "i want to make car rental landing page" }), res as never);
    expect(res.statusCode).toBe(200);
    const call = mocks.startProductBuild.mock.calls[0][0] as { company_name: string };
    expect(call.company_name).toBe("Car Rental");
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(/i-want-to-make/i);
  });

  it("falls back to My App when the idea names nothing", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: "I need a website" }), res as never);
    expect(res.statusCode).toBe(200);
    expect((mocks.startProductBuild.mock.calls[0][0] as { company_name: string }).company_name).toBe("My App");
  });

  describe("only a name the founder typed is saved as founder-confirmed", () => {
    const savedFacts = async () => {
      await vi.waitFor(() => expect(mocks.writeTypedFacts).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      const wizard = mocks.writeTypedFacts.mock.calls[0][2] as { orgName?: string };
      const projected = mocks.projectFact.mock.calls
        .filter((c) => c[1] === "company_name")
        .map((c) => ({ value: c[2], source: c[3] }));
      return { orgName: wizard.orgName, projected };
    };

    beforeEach(() => {
      mocks.writeTypedFacts.mockReset().mockResolvedValue(undefined);
      mocks.projectFact.mockReset().mockResolvedValue({ error: null });
    });

    it("a typed name is the founder's", async () => {
      await postOnboardingBuildStart(req({ idea: goodIdea, company_name: "Acme Studio" }), mockRes() as never);
      expect(await savedFacts()).toEqual({ orgName: "Acme Studio", projected: [] });
    });

    it("a name guessed from the idea's words is only an estimate", async () => {
      await postOnboardingBuildStart(req({ idea: "i want to make car rental landing page" }), mockRes() as never);
      expect(await savedFacts()).toEqual({ orgName: undefined, projected: [{ value: "Car Rental", source: "ai_estimated" }] });
    });

    it("the My App fallback is never saved as the company's name", async () => {
      await postOnboardingBuildStart(req({ idea: "I need a website" }), mockRes() as never);
      expect(await savedFacts()).toEqual({ orgName: undefined, projected: [] });
    });
  });

  it("DEL-1323 B33: a typed workspace name is not reused as the site name (the build names the site)", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, company_name: "Acme Studio" }), res as never);
    expect(mocks.extractIdeaIntake).not.toHaveBeenCalled();
    expect(mocks.startProductBuild.mock.calls[0][0]).not.toHaveProperty("site_name");
  });

  it("409 when the RPC's atomic guard fires (SQLSTATE 45001 — concurrent create lost the race)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "45001", message: "user already has an active tenant" } });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("tenant_exists");
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("500 when the lite RPC errors (no build kicked)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(500);
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("additional:true → creates a 2nd tenant (skips the 409 guard), passes p_allow_additional, flushes cache", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: { active_tenant_id: "tenant-existing" } });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, additional: true }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.capCheck).toHaveBeenCalledWith("user-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "activate_tenant_lite",
      expect.objectContaining({ p_user_id: "user-1", p_allow_additional: true }),
    );
    expect(mocks.invalidateCache).toHaveBeenCalledWith("user-1");
  });

  it("additional:true → 403 tenant_limit when the self-serve cap is hit (no tenant created)", async () => {
    mocks.capCheck.mockResolvedValue({ code: "tenant_limit", message: "limit reached" });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, additional: true }), res as never);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("tenant_limit");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("no active company but already owns one → the Add company rule still applies (no tenant created)", async () => {
    mocks.capCheck.mockResolvedValue({ code: "multi_workspace_not_enabled", message: "not on your account" });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(mocks.capCheck).toHaveBeenCalledWith("user-1");
    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("multi_workspace_not_enabled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("402 insufficient_credits_for_build → names the shortfall, keeps tenant_id", async () => {
    mocks.startProductBuild.mockRejectedValue(
      new InsufficientCreditsForBuild(4680, 2000),
    );
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(402);
    expect(mocks.competitorsFromIdea).toHaveBeenCalledWith("tenant-new", goodIdea);
    const body = res.body as {
      error?: { code?: string; message?: string; required_credits?: number; remaining_credits?: number };
      tenant_id?: string;
    };
    expect(body.error?.code).toBe("insufficient_credits_for_build");
    expect(body.error?.required_credits).toBe(4680);
    expect(body.error?.remaining_credits).toBe(2000);
    expect(body.error?.message).toBe(
      "This build needs about 4,680 credits and you have 2,000. Top up in Billing and start it again.",
    );
    expect(body.error?.message).not.toContain("$");
    expect(body.tenant_id).toBe("tenant-new");
  });

  it("402 for a free tenant carries free_plan and the free-plan sentence", async () => {
    mocks.startProductBuild.mockRejectedValue(
      new InsufficientCreditsForBuild(6500, 1000, true),
    );
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(402);
    const body = res.body as {
      error?: { code?: string; message?: string; free_plan?: boolean; required_credits?: number };
    };
    expect(body.error?.code).toBe("insufficient_credits_for_build");
    expect(body.error?.free_plan).toBe(true);
    expect(body.error?.required_credits).toBe(6500);
    expect(body.error?.message).toBe(
      "The free plan's daily credits don't cover this build. Top up or pick a plan in Billing to start it.",
    );
    await flush();
    expect(mocks.sendBuildNotStartedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: body.error?.message }),
    );
  });

  it("409 build_already_in_progress (not the generic 500)", async () => {
    mocks.startProductBuild.mockRejectedValue(
      new DoubleBuildInFlight("tenant-new"),
    );
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(409);
    const body = res.body as { error?: { code?: string }; tenant_id?: string };
    expect(body.error?.code).toBe("build_already_in_progress");
    expect(body.tenant_id).toBe("tenant-new");
  });

  it("409 build_already_in_progress names the in-flight build, read under the new tenant", async () => {
    const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
    mocks.inflightRow.mockResolvedValue({ data: { id: RUN }, error: null });
    mocks.startProductBuild.mockRejectedValue(new DoubleBuildInFlight("tenant-new"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { run_id?: string }).run_id).toBe(RUN);
    expect(mocks.inflightTenant).toHaveBeenCalledWith("tenant-new");
  });

  it("409 build_already_in_progress still answers when the in-flight lookup throws", async () => {
    mocks.inflightRow.mockRejectedValue(new Error("db down"));
    mocks.startProductBuild.mockRejectedValue(new DoubleBuildInFlight("tenant-new"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { run_id?: string }).run_id).toBeUndefined();
  });

  it("429 daily_build_limit_reached (not the generic 500)", async () => {
    mocks.startProductBuild.mockRejectedValue(
      new TooManyBuildsToday("tenant-new", 3, 3),
    );
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(429);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "daily_build_limit_reached",
    );
  });

  it("402 provision_budget_exceeded (not the generic 500)", async () => {
    mocks.startProductBuild.mockRejectedValue(
      new ProvisionBudgetExceeded(3),
    );
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(402);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "provision_budget_exceeded",
    );
  });

  it("500 build_start_failed stays for a genuinely unknown throw", async () => {
    mocks.startProductBuild.mockRejectedValue(new Error("neon exploded"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, company_name: "Acme Studio" }), res as never);
    expect(res.statusCode).toBe(500);
    const body = res.body as { error?: { code?: string }; tenant_id?: string; company_name?: string };
    expect(body.error?.code).toBe("build_start_failed");
    expect(body.tenant_id).toBe("tenant-new");
    expect(body.company_name).toBe("Acme Studio");
  });

  it("403 when PRODUCT_BUILDER_ENABLED=0 (kill-switch)", async () => {
    process.env.PRODUCT_BUILDER_ENABLED = "0";
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    expect(res.statusCode).toBe(403);
    expect(mocks.verifyBearer).not.toHaveBeenCalled();
  });

  it("403 product_builder_disabled when the staff setting is off (same switch as the workspace build doors); creates nothing", async () => {
    mocks.getAppSetting.mockImplementation(async (k: string) => (k === "product_builder_enabled" ? false : undefined));
    try {
      const res = mockRes();
      await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
      expect(res.statusCode).toBe(403);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe("product_builder_disabled");
      expect(mocks.verifyBearer).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.startProductBuild).not.toHaveBeenCalled();
    } finally {
      mocks.getAppSetting.mockReset();
    }
  });

  it("an UNREADABLE staff setting fails closed: retryable 503 product_builder_unavailable, creates nothing", async () => {
    mocks.getAppSetting.mockImplementation(async (k: string, _t: unknown, opts?: { strict?: boolean }) => {
      if (k === "product_builder_enabled" && opts?.strict) throw new Error("app_setting read failed: timeout");
      return undefined;
    });
    try {
      const res = mockRes() as ReturnType<typeof mockRes> & { locals?: Record<string, unknown> };
      res.locals = {};
      await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
      expect(res.statusCode).toBe(503);
      const err = (res.body as { error?: { code?: string; retryable?: boolean; message?: string } }).error;
      expect(err?.code).toBe("product_builder_unavailable");
      expect(err?.retryable).toBe(true);
      expect(err?.message).toMatch(/paused right now/);
      expect(res.locals.idempotencyRelease).toBe(true);
      expect(mocks.verifyBearer).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.startProductBuild).not.toHaveBeenCalled();
    } finally {
      mocks.getAppSetting.mockReset();
    }
  });

  it("the staff setting ON wins over a stale env kill-switch (one source of truth)", async () => {
    process.env.PRODUCT_BUILDER_ENABLED = "0";
    mocks.getAppSetting.mockImplementation(async (k: string) => (k === "product_builder_enabled" ? true : undefined));
    try {
      const res = mockRes();
      await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
      expect(res.statusCode).not.toBe(403);
      expect(mocks.verifyBearer).toHaveBeenCalled();
    } finally {
      mocks.getAppSetting.mockReset();
    }
  });
});

describe("build-start: refusal email + ops alert", () => {
  it("alerts ops even when the build is REFUSED (the 8-day blind spot)", async () => {
    mocks.startProductBuild.mockRejectedValue(new InsufficientCreditsForBuild(4320, 1000));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(402);
    expect(mocks.notifyNewTenant).toHaveBeenCalledTimes(1);
  });

  it("a REFUSED build sends the honest email and NEVER the 'your app is building' one", async () => {
    mocks.startProductBuild.mockRejectedValue(new InsufficientCreditsForBuild(4320, 1000));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(mocks.sendBuildNotStartedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendWelcomeBuildEmail).not.toHaveBeenCalled();
    const reason = mocks.sendBuildNotStartedEmail.mock.calls[0][0].reason as string;
    expect(reason).toContain("4,320");
    expect(reason).toContain("1,000");
    expect(reason).not.toMatch(/nothing was created/i);
    expect(reason).not.toMatch(/start it again/i);
    expect(reason).not.toMatch(/will run/i);
    expect(reason).not.toMatch(/nothing was created/i);
  });

  const preProvisionRefusals: ReadonlyArray<[string, () => Error]> = [
    ["TooManyBuildsToday", () => new TooManyBuildsToday("tenant-new", 10, 10)],
    ["ProvisionBudgetExceeded", () => new ProvisionBudgetExceeded(3)],
  ];
  it.each(preProvisionRefusals)("pre-provision refusal (%s) emails the founder", async (_name, make) => {
    mocks.startProductBuild.mockRejectedValue(make());
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(mocks.sendBuildNotStartedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendWelcomeBuildEmail).not.toHaveBeenCalled();
  });

  it("a build already in flight gets NO mail — 'we couldn't start it' is false", async () => {
    mocks.startProductBuild.mockRejectedValue(new DoubleBuildInFlight("tenant-new"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(409);
    expect(mocks.sendBuildNotStartedEmail).not.toHaveBeenCalled();
    expect(mocks.setTenantSetting).not.toHaveBeenCalledWith(
      expect.anything(),
      "welcome_email_sent",
      true,
      expect.anything(),
    );
  });

  it.each([
    ["the tenant kind audit", signup.audit],
    ["the draft goal", signup.draftGoal],
    ["the signup attribution", signup.attribution],
    ["the affiliate attribution", signup.affiliate],
  ])("%s is saved before the build starts or the founder gets an answer", async (_name, step) => {
    let finish = () => {};
    step.mockImplementationOnce(() => new Promise<undefined>((r) => (finish = () => r(undefined))));
    const res = mockRes();
    const done = postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();
    expect(step).toHaveBeenCalledTimes(1);
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(res.body).toBeUndefined();
    finish();
    await done;
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    step.mockClear();
  });

  it("answers with the run while the site saga is still running, and ticks only when it finishes", async () => {
    let finish = (_v: unknown) => {};
    mocks.setup.mockReturnValue(new Promise((r) => (finish = r)));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenant_id: "tenant-new", conductor_run_id: "cr-1" });
    expect(mocks.requestTick).not.toHaveBeenCalled();

    finish({ conductor_run_id: "cr-1" });
    await flush();
    expect(mocks.requestTick).toHaveBeenCalledTimes(1);
    expect(mocks.requestTick.mock.calls[0][1]).toBe("cr-1");
  });

  it("a saga failure after the answer never ticks and never takes the process down", async () => {
    let fail = (_e: Error) => {};
    mocks.setup.mockReturnValue(new Promise((_, rej) => (fail = rej)));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();
    expect(res.statusCode).toBe(200);

    fail(new BuildRepoNotProvisioned("no repo"));
    await flush();
    expect(mocks.requestTick).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("a saga that fails at once raises no unhandled rejection", async () => {
    mocks.setup.mockRejectedValue(new Error("saga died"));
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    await postOnboardingBuildStart(req({ idea: goodIdea }), mockRes() as never);
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(seen).toEqual([]);
    expect(mocks.requestTick).not.toHaveBeenCalled();
  });

  it("a refused start runs no saga and sends no tick", async () => {
    mocks.startProductBuild.mockRejectedValue(new BuildRepoNotProvisioned("no repo"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();
    expect(res.statusCode).toBe(503);
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.requestTick).not.toHaveBeenCalled();
  });

  it("a site setup failure answers 503 build_setup_failed with the founder copy, retryable, not a backend-crash 500", async () => {
    mocks.startProductBuild.mockRejectedValue(new BuildRepoNotProvisioned("Couldn't set up your site's code project, so this build couldn't start."));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(503);
    const body = res.body as { error: { code: string; message: string; retryable: boolean }; tenant_id?: string };
    expect(body.error.code).toBe("build_setup_failed");
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).toMatch(/^Couldn't set up your site's/);
    expect(body.tenant_id).toBeTruthy();
  });

  it("a missing build prerequisite answers 503 build_setup_failed, sends NO mail and keeps the welcome flag", async () => {
    mocks.startProductBuild.mockRejectedValue(new BuildRepoNotProvisioned("build prerequisites missing: GITHUB_PROVISION_TOKEN"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("build_setup_failed");
    expect(mocks.sendBuildNotStartedEmail).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeBuildEmail).not.toHaveBeenCalled();
    expect(mocks.setTenantSetting).not.toHaveBeenCalledWith(
      expect.anything(),
      "welcome_email_sent",
      true,
      expect.anything(),
    );
  });

  it("an untyped post-provision failure gets NO mail and does not burn the flag", async () => {
    mocks.startProductBuild.mockRejectedValue(new Error("conductor_runs update failed: deadlock"));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(500);
    expect(mocks.sendBuildNotStartedEmail).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeBuildEmail).not.toHaveBeenCalled();
    expect(mocks.setTenantSetting).not.toHaveBeenCalledWith(
      expect.anything(),
      "welcome_email_sent",
      true,
      expect.anything(),
    );
  });

  it("a SUCCESSFUL build still sends the welcome, not the refusal note", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mocks.sendWelcomeBuildEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendBuildNotStartedEmail).not.toHaveBeenCalled();
  });

  it("never sends twice: the welcome_email_sent flag suppresses the refusal note", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.startProductBuild.mockRejectedValue(new InsufficientCreditsForBuild(4320, 1000));
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }), res as never);
    await flush();

    expect(mocks.sendBuildNotStartedEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/build-start reference images", () => {
  const attachOn = () =>
    mocks.getBoolSetting.mockImplementation(async (key: string) => key === "build_idea_attach");
  const pngDataUrl = async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  };

  it("validates, stores under the new tenant and hands the signed URLs to the build", async () => {
    attachOn();
    mocks.storeIdeaImages.mockResolvedValue(["https://store.example/signed/a.jpg"]);
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, reference_images: [await pngDataUrl()] }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.storeIdeaImages).toHaveBeenCalledTimes(1);
    const [tenant, jpegs] = mocks.storeIdeaImages.mock.calls[0] as [string, Buffer[]];
    expect(tenant).toBe("tenant-new");
    expect(jpegs).toHaveLength(1);
    expect(jpegs[0].subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(mocks.startProductBuild).toHaveBeenCalledWith(
      expect.objectContaining({ reference_images: ["https://store.example/signed/a.jpg"] }),
    );
  });

  it("503s without starting when any requested image cannot be stored", async () => {
    attachOn();
    const one = await pngDataUrl();
    mocks.storeIdeaImages.mockResolvedValue(["https://store.example/signed/a.jpg"]);
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, reference_images: [one, one] }), res as never);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error?: { code?: string }; tenant_id?: string }).error?.code).toBe("reference_images_unavailable");
    expect((res.body as { tenant_id?: string }).tenant_id).toBe("tenant-new");
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("400 before any tenant exists when an image is not png/jpeg/webp", async () => {
    attachOn();
    const gif = `data:image/png;base64,${Buffer.from("GIF89a\x01\x00\x01\x00").toString("base64")}`;
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, reference_images: [gif] }), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("invalid_reference_images");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("400 when an image is over 5 MB, even with a valid header", async () => {
    attachOn();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    const res = mockRes();
    await postOnboardingBuildStart(
      req({ idea: goodIdea, reference_images: [`data:image/png;base64,${big.toString("base64")}`] }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400 for more than 3 images or a non-data-URL reference", async () => {
    attachOn();
    const one = await pngDataUrl();
    for (const refs of [[one, one, one, one], ["https://evil.example/x.png"], "not-a-list"]) {
      const res = mockRes();
      await postOnboardingBuildStart(req({ idea: goodIdea, reference_images: refs }), res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("flag off ignores images entirely: no validation, no storage, no refs on the build", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, reference_images: ["garbage"] }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
    expect(mocks.startProductBuild.mock.calls[0][0]).not.toHaveProperty("reference_images");
  });
});

describe("build-start workspace time zone", () => {
  it("saves a valid browser zone on the new tenant before bootstrap", async () => {
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, timezone: "Europe/Paris" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("tenants", { timezone: "Europe/Paris" }, "id", "tenant-new");
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.seedBootstrap.mock.invocationCallOrder[0]);
  });

  it("writes nothing for a missing or invalid zone, and a failed write still builds", async () => {
    for (const timezone of [undefined, "Mars/Base"]) {
      const res = mockRes();
      await postOnboardingBuildStart(req({ idea: goodIdea, timezone }), res as never);
      expect(res.statusCode).toBe(200);
    }
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.update.mockResolvedValueOnce({ error: { message: "boom" } });
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea, timezone: "Asia/Kolkata" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.startProductBuild).toHaveBeenCalled();
  });
});

it.each([['x', 'social'], ['x', 'creator'], ['email', 'email'], ['linkedin', 'social'], ['producthunt', 'referral']])(
  'persists request-query %s/%s attribution when the body omits it', async (source, medium) => {
    const { persistSignupAttribution } = await vi.importActual<typeof import('@/services/tenants/signup-attribution')>('@/services/tenants/signup-attribution');
    signup.attribution.mockImplementationOnce(persistSignupAttribution);
    const tags = { utm_source: source, utm_medium: medium, utm_campaign: 'launch2' };
    const res = mockRes();
    await postOnboardingBuildStart(req({ idea: goodIdea }, tags), res as never);
    expect(mocks.setTenantSetting).toHaveBeenCalledWith('tenant-new', 'signup_attribution', tags, 'user-1');
  },
);

it.each(["filter-coffee", "newsletter-morning-blue"])("persists generic channel %s from the build-start request", async from => {
  const { persistSignupAttribution } = await vi.importActual<typeof import("@/services/tenants/signup-attribution")>("@/services/tenants/signup-attribution");
  signup.attribution.mockImplementationOnce(persistSignupAttribution);
  const res = mockRes();
  await postOnboardingBuildStart(req({ idea: goodIdea }, { from }), res as never);
  expect(res.statusCode).toBe(200);
  expect(mocks.setTenantSetting).toHaveBeenCalledWith("tenant-new", "signup_attribution", { from }, "user-1");
});

it("accepts diagnostic-only attribution without blocking build signup", async () => {
  const { persistSignupAttribution } = await vi.importActual<typeof import("@/services/tenants/signup-attribution")>("@/services/tenants/signup-attribution");
  signup.attribution.mockImplementationOnce(persistSignupAttribution);
  const attribution = { capture_status: "not_captured" };
  const res = mockRes();
  await postOnboardingBuildStart(req({ idea: goodIdea, attribution }), res as never);
  expect(res.statusCode).toBe(200);
  expect(mocks.setTenantSetting).toHaveBeenCalledWith("tenant-new", "signup_attribution", attribution, "user-1");
});
