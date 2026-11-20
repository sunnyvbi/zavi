import { describe, it, expect, vi } from "vitest";
import { createRenderHostingProvisioner, serviceSlug } from "@/services/provisioning/render-hosting";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async () => "test_session_secret_0123456789abcdef0123456789"),
}));
vi.mock("@/services/provisioning/secret", () => ({
  setResourceSecret: vi.fn(async (_t: string, _k: string, key: string) => key),
}));

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
const ctx = { context: { repo_url: "https://github.com/praxis-built/acme" } };

const TEST_SESSION_SECRET = "test_session_secret_0123456789abcdef0123456789";
const sessionSecretStub = async () => ({ value: TEST_SESSION_SECRET, created: false });

describe("serviceSlug", () => {
  it("slugifies, suffixed with a tenant hash (A1)", () => {
    expect(serviceSlug("Acme Waitlist!", "t1")).toMatch(/^acme-waitlist-[a-f0-9]{8}$/);
  });
  it("is tenant-scoped — same name, different tenant → different slug (A1)", () => {
    expect(serviceSlug("UpcarAI", "tenant-a")).not.toBe(serviceSlug("UpcarAI", "tenant-b"));
  });
});

describe("RenderHostingProvisioner", () => {
  it("gated: missing RENDER_API_KEY → CredentialNotConfigured", async () => {
    const p = createRenderHostingProvisioner({ token: () => null, ownerId: () => "own", fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toMatchObject({
      key: "RENDER_API_KEY",
    });
  });

  it("gated: missing RENDER_OWNER_ID → CredentialNotConfigured", async () => {
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => null, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toBeInstanceOf(
      CredentialNotConfigured,
    );
  });

  it("requires the repo url from context (repo provisioner runs first)", async () => {
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toThrow(/requires a repo/i);
  });

  it("idempotent: returns the existing service when found by name (no create)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      res(200, [{ service: { id: "srv_1", serviceDetails: { url: "https://acme.onrender.com" } } }]),
    );
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref).toEqual({ render_service_id: "srv_1", url: "https://acme.onrender.com" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("creates when none exists (empty list → POST 201)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://newco.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    const r = await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_new");
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
    expect(fetchFn.mock.calls[1][0]).toContain("/v1/services");
  });

  async function createBodyWithEnv(planEnv: string | undefined) {
    const prev = process.env.RENDER_PLAN;
    if (planEnv === undefined) delete process.env.RENDER_PLAN;
    else process.env.RENDER_PLAN = planEnv;
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://newco.onrender.com" } }))
        .mockResolvedValue(res(200, {}));
      const p = createRenderHostingProvisioner({
        token: () => "tok",
        ownerId: () => "own",
        fetchFn: fetchFn as never,
        dbUrl: async () => null,
      });
      await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
      return JSON.parse(String(fetchFn.mock.calls[1][1]?.body));
    } finally {
      if (prev === undefined) delete process.env.RENDER_PLAN;
      else process.env.RENDER_PLAN = prev;
    }
  }

  it("defaults to the FREE plan when RENDER_PLAN is unset (cost regression guard)", async () => {
    const body = await createBodyWithEnv(undefined);
    expect(body.serviceDetails.plan).toBe("free");
    expect(body.serviceDetails.plan).not.toBe("starter");
  });

  it("still honours an explicit paid RENDER_PLAN (deliberate upgrade path)", async () => {
    const body = await createBodyWithEnv("starter");
    expect(body.serviceDetails.plan).toBe("starter");
  });

  it("NEVER wires Zavi's NEXT_PUBLIC_SUPABASE_* onto a new service, even when the umbrella keys are set", async () => {
    const prev = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY };
    process.env.SUPABASE_URL = "https://wmycgyjsenvgtczlupoe.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon_xyz";
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://newco.onrender.com" } }))
        .mockResolvedValue(res(200, {}));
      const p = createRenderHostingProvisioner({
        token: () => "tok",
        ownerId: () => "own",
        fetchFn: fetchFn as never,
        dbUrl: async () => null,
      });
      await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
      const postBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body ?? "{}"));
      expect(postBody.serviceDetails.envVars).toEqual([]);
      const urls = fetchFn.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("NEXT_PUBLIC_SUPABASE"))).toBe(false);
    } finally {
      if (prev.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prev.url;
      if (prev.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = prev.anon;
    }
  });

  it("Slice 4: create response in WRAPPED shape (service.serviceDetails.url) → url populated", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { service: { id: "srv_w", serviceDetails: { url: "https://wrapped.onrender.com" } } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    const r = await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_w");
    expect(r.external_ref.url).toBe("https://wrapped.onrender.com");
  });

  it("Slice 4: create response with NO url → best-effort GET backfills it", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_b" }))
      .mockResolvedValue(res(200, { serviceDetails: { url: "https://backfilled.onrender.com" } }));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    const r = await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_b");
    expect(r.external_ref.url).toBe("https://backfilled.onrender.com");
  });

  it("wires the per-app DATABASE_URL as a SERVER-ONLY env var on create (no NEXT_PUBLIC_ prefix)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new" }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
      sessionSecret: sessionSecretStub,
    });
    await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
    const postBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body ?? "{}"));
    expect(postBody.serviceDetails.envVars).toEqual([
      { key: "DATABASE_URL", value: "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require" },
      { key: "SESSION_SECRET", value: TEST_SESSION_SECRET },
    ]);
    const dbVar = postBody.serviceDetails.envVars.find(
      (e: { key: string }) => e.key === "DATABASE_URL",
    );
    expect(dbVar).toBeTruthy();
    expect(
      postBody.serviceDetails.envVars.some((e: { key: string }) => e.key.startsWith("NEXT_PUBLIC_") && e.key.includes("DATABASE")),
    ).toBe(false);
    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/DATABASE_URL"))).toBe(true);
    expect(putUrls.some((u) => u.includes("/env-vars/NEXT_PUBLIC_SUPABASE_URL"))).toBe(false);
  });

  it("heal path: upserts DATABASE_URL onto an existing service when the per-app db url is present", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_exist", serviceDetails: { url: "https://x.onrender.com" } } }]))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb",
    });
    await p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx });
    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/DATABASE_URL"))).toBe(true);
  });

  it("re-provision/heal path: a static site's existing service gets NO env writes (never Zavi's Supabase keys)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        res(200, [{ service: { id: "srv_existing", serviceDetails: { url: "https://acme.onrender.com" } } }]),
      )
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => null,
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_existing");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-provision/heal path: upsert failure is best-effort (logged, not thrown — never regresses ready→failed)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        res(200, [{ service: { id: "srv_existing", serviceDetails: { url: "https://acme.onrender.com" } } }]),
      )
      .mockResolvedValueOnce(res(403, { message: "rate limited" }))
      .mockResolvedValue(res(200, {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb",
      sessionSecret: sessionSecretStub,
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_existing");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("teardown deletes the service", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(204, {}));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    await expect(p.teardown({ render_service_id: "srv_1" })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("kind/provider = hosting/render", () => {
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own" });
    expect(p.kind).toBe("hosting");
    expect(p.provider).toBe("render");
  });

  it("declares initialStatus='provisioning' (A4 — Render deploy is async, not live at create)", () => {
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own" });
    expect(p.initialStatus).toBeTypeOf("function");
    expect(p.initialStatus!({ external_ref: { render_service_id: "srv_1" }, vault_keys: {} })).toBe("provisioning");
  });

  const ctxDb = { context: { repo_url: "https://github.com/praxis-built/acme", neon_project_id: "proj-123" } };

  it("DB-backed build: env-var builder INCLUDES DATABASE_URL when the connection string resolves", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    const postBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body ?? "{}"));
    expect(postBody.serviceDetails.envVars).toContainEqual({
      key: "DATABASE_URL",
      value: "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
    });
    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/DATABASE_URL"))).toBe(true);
  });

  it("DB-backed build: a resolve FAILURE surfaces a hard error — never silently omits DATABASE_URL / creates a DB-dead service", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, []));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => null,
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb })).rejects.toThrow(
      /DATABASE_URL could not be resolved/i,
    );
    const posted = fetchFn.mock.calls.some(
      (c) => String(c[1]?.method) === "POST" && String(c[0]).endsWith("/v1/services"),
    );
    expect(posted).toBe(false);
  });

  it("DB-backed build: retries a transient Vault failure, then resolves DATABASE_URL", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    let calls = 0;
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("vault transient 503");
        return "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require";
      },
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    expect(r.external_ref.render_service_id).toBe("srv_new");
    expect(calls).toBeGreaterThanOrEqual(2);
    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/DATABASE_URL"))).toBe(true);
  });

  it("DB-backed build: appends sslmode=require when the persisted connection string lacks it (Neon needs TLS)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb",
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    const postBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body ?? "{}"));
    const dbVar = postBody.serviceDetails.envVars.find((e: { key: string }) => e.key === "DATABASE_URL");
    expect(dbVar.value).toBe("postgres://u:p@ep-x.neon.tech/neondb?sslmode=require");
  });

  it("DB-backed build: triggers a redeploy after applying DATABASE_URL so the running process picks it up", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(201, { id: "dep_1" }));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    const deployPosts = fetchFn.mock.calls.filter(
      (c) => String(c[0]).endsWith("/srv_new/deploys") && String(c[1]?.method) === "POST",
    );
    expect(deployPosts.length).toBe(1);
  });

  it("rebuild onto a suspended service resumes it before redeploying", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        res(200, [{ service: { id: "srv_s", suspended: "suspended", suspenders: ["user"], serviceDetails: { url: "https://x.onrender.com" } } }]),
      )
      .mockResolvedValue(res(202, {}));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(fetchFn.mock.calls[1][0]).toContain("/v1/services/srv_s/resume");
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
  });

  it("a platform (billing/abuse) suspension is not ours to resume: provisioning fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_b", suspended: "suspended", suspenders: ["billing"] } }]));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toThrow(/suspended by Render/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a crash-loop suspension by Render is not ours to resume either", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_c", suspended: "suspended", suspenders: ["stuck_crashlooping"] } }]));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toThrow(/suspended by Render/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("stays suspended when the old database url remains but no database was re-provisioned", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_s", suspended: "suspended", suspenders: ["user"] } }]));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-dead.neon.tech/neondb?sslmode=require",
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toThrow(/not re-provisioned/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a failed resume fails provisioning instead of deploying to a dead service", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_s", suspended: "suspended", suspenders: ["user"] } }]))
      .mockResolvedValueOnce(res(500, { message: "nope" }));
    const p = createRenderHostingProvisioner({ token: () => "tok", ownerId: () => "own", fetchFn: fetchFn as never, dbUrl: async () => null });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toThrow(/render resume srv_s failed \(500\)/);
  });

  it("DB-backed heal: existing service → upsert DATABASE_URL + trigger a redeploy", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_exist", serviceDetails: { url: "https://x.onrender.com" } } }]))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    const deployPosts = fetchFn.mock.calls.filter(
      (c) => String(c[0]).endsWith("/srv_exist/deploys") && String(c[1]?.method) === "POST",
    );
    expect(deployPosts.length).toBe(1);
  });

  it("no-DB/static app path UNCHANGED: no neon_project_id + null dbUrl → no DATABASE_URL, no hard error, no redeploy", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => null,
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.render_service_id).toBe("srv_new");
    const postBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body ?? "{}"));
    expect(postBody.serviceDetails.envVars.some((e: { key: string }) => e.key === "DATABASE_URL")).toBe(false);
    const deployPosts = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/deploys"));
    expect(deployPosts.length).toBe(0);
  });

  it("a THROWN env-var PUT on every retry fails the provision and triggers no deploy", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockRejectedValue(new Error("network blip"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => "postgres://u:p@h/db",
      sessionSecret: sessionSecretStub,
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "NewCo", ...ctx })).rejects.toThrow(/DATABASE_URL, SESSION_SECRET/);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/deploys"))).toBe(false);
    warn.mockRestore();
  });

});
