
import { describe, it, expect } from "vitest";
import {
  createSupabaseMgmt,
  redactSqlMessage,
  supabaseMgmtConfig,
  SiteDeleteRefused,
  SiteSqlError,
  SupabaseMgmtError,
  type MgmtFetch,
} from "../supabase-mgmt";
import { SiteCredentialsMissing } from "../contract";

const REF = "abcdefghijklmnopqrst";
const cfg = { token: "sbp_secret_token", orgId: "org-1", region: "us-west-1" };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchFn: MgmtFetch = async (url, init) => {
    const c = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(c);
    const r = handler(c);
    return { status: r.status, text: async () => (r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchFn, calls };
}

describe("supabaseMgmtConfig", () => {
  it("throws SiteCredentialsMissing naming each missing key", () => {
    try {
      supabaseMgmtConfig({});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SiteCredentialsMissing);
      expect((e as SiteCredentialsMissing).missing).toEqual(["SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID"]);
    }
  });

  it("defaults the region to us-west-1", () => {
    expect(supabaseMgmtConfig({ SUPABASE_MGMT_TOKEN: "t", SUPABASE_ORG_ID: "o" }).region).toBe("us-west-1");
    expect(supabaseMgmtConfig({ SUPABASE_MGMT_TOKEN: "t", SUPABASE_ORG_ID: "o", SUPABASE_SITE_REGION: "eu-west-2" }).region).toBe("eu-west-2");
  });
});

describe("createSupabaseMgmt", () => {
  it("creates a project in the configured org and region with a bearer token", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 201, body: { id: REF, name: "zs-x", organization_id: "org-1", status: "COMING_UP" } }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    const p = await m.createProject({ name: "zs-x", dbPass: "pw" });
    expect(p.ref).toBe(REF);
    expect(calls[0].url).toBe("https://api.supabase.com/v1/projects");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer sbp_secret_token");
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "zs-x", organization_id: "org-1", db_pass: "pw", region: "us-west-1" });
  });

  it("never echoes a vendor error body", async () => {
    const leaky = { message: "boom sbp_secret_token eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturesig" };
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: leaky }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    const err = await m.createProject({ name: "zs-x", dbPass: "pw" }).catch((e) => e);
    expect(err).toBeInstanceOf(SupabaseMgmtError);
    expect(err.message).toBe("supabase create project failed (500)");
    expect(String(err.message)).not.toContain("boom");
  });

  it("a network failure is a SupabaseMgmtError with no detail", async () => {
    const m = createSupabaseMgmt({
      fetchFn: async () => {
        throw new Error("socket hang up sbp_secret_token");
      },
      config: cfg,
    });
    const err = await m.getProject(REF).catch((e) => e);
    expect(err.message).toBe("supabase get project failed (network)");
  });

  it("a request that hangs is aborted at the timeout (a SupabaseMgmtError), with an AbortSignal on the fetch", async () => {
    let signal: AbortSignal | undefined;
    const m = createSupabaseMgmt({
      fetchFn: (_url, init) => {
        signal = init?.signal;
        return new Promise(() => undefined);
      },
      config: cfg,
      timeoutMs: 20,
    });
    const err = await m.query(REF, "select 1").catch((e) => e);
    expect(err).toBeInstanceOf(SupabaseMgmtError);
    expect(signal?.aborted).toBe(true);
  });

  it("lists only exact-name projects in this org", async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: [
        { id: REF, name: "zs-a", organization_id: "org-1" },
        { id: "bbbbbbbbbbbbbbbbbbbb", name: "zs-a", organization_id: "org-2" },
        { id: "cccccccccccccccccccc", name: "zs-ab", organization_id: "org-1" },
      ],
    }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    expect((await m.listProjectsByName("zs-a")).map((p) => p.ref)).toEqual([REF]);
  });

  it("rejects a malformed project ref before building a URL", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    await expect(m.getProject("../../v1/organizations")).rejects.toThrow(/invalid supabase project ref/);
    expect(calls).toHaveLength(0);
  });

  it("pause: a paid-plan refusal is 'unsupported' (body read only to classify); other refusals throw with status only", async () => {
    for (const [status, body] of [
      [400, { message: "Project is not free-tier. Please downgrade it to free-tier first and try again." }],
      [400, { message: "Projects under a paid plan cannot be paused." }],
      [403, { message: "Pausing is not allowed on paid plans" }],
      [422, "Cannot pause a project on the Pro plan: paid plan"],
    ] as const) {
      const { fetchFn, calls } = fakeFetch(() => ({ status, body }));
      const m = createSupabaseMgmt({ fetchFn, config: cfg });
      expect(await m.pause(REF)).toBe("unsupported");
      expect(calls[0]).toMatchObject({ method: "POST", url: `https://api.supabase.com/v1/projects/${REF}/pause` });
    }
    const other = createSupabaseMgmt({ fetchFn: fakeFetch(() => ({ status: 400, body: { message: "secret detail xyz" } })).fetchFn, config: cfg });
    const err = await other.pause(REF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseMgmtError);
    expect((err as SupabaseMgmtError).status).toBe(400);
    expect(String((err as Error).message)).not.toContain("secret");
    const down = createSupabaseMgmt({ fetchFn: fakeFetch(() => ({ status: 503, body: { message: "paid plan" } })).fetchFn, config: cfg });
    await expect(down.pause(REF)).rejects.toMatchObject({ status: 503 });
    const ok = createSupabaseMgmt({ fetchFn: fakeFetch(() => ({ status: 200, body: {} })).fetchFn, config: cfg });
    expect(await ok.pause(REF)).toBe("ok");
  });

  it("pause / restore treat 404 as not_found (idempotent)", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 404 }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    expect(await m.pause(REF)).toBe("not_found");
    expect(await m.restore(REF)).toBe("not_found");
  });

  describe("deleteSiteProject: final identity check before the DELETE", () => {
    const NAME = "zs-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    function mgmtFor(project: Record<string, unknown> | null, deleteStatus = 200) {
      const { fetchFn, calls } = fakeFetch((c) => {
        if (c.method === "DELETE") return { status: deleteStatus, body: {} };
        return project ? { status: 200, body: project } : { status: 404 };
      });
      return { m: createSupabaseMgmt({ fetchFn, config: cfg }), calls };
    }
    const deletes = (calls: Array<{ method?: string }>) => calls.filter((c) => c.method === "DELETE").length;

    it("deletes only when ref, name and org all match, re-reading the project first", async () => {
      const { m, calls } = mgmtFor({ id: REF, name: NAME, organization_id: "org-1" });
      const seen: string[] = [];
      expect(await m.deleteSiteProject(REF, NAME, async () => { seen.push(`before:${calls.length}`); })).toBe("ok");
      expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
      expect(seen).toEqual(["before:1"]);
    });

    it.each([
      ["a different name", { id: REF, name: "zs-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organization_id: "org-1" }, "name_mismatch"],
      ["a non-site project", { id: REF, name: "prod-db", organization_id: "org-1" }, "name_mismatch"],
      ["another org", { id: REF, name: NAME, organization_id: "org-2" }, "wrong_org"],
      ["a 404", null, "not_found"],
    ])("refuses %s: no DELETE is sent", async (_l, project, reason) => {
      const { m, calls } = mgmtFor(project as Record<string, unknown> | null);
      let before = 0;
      const err = await m.deleteSiteProject(REF, NAME, async () => { before++; }).catch((e) => e);
      expect(err).toBeInstanceOf(SiteDeleteRefused);
      expect(err.reason).toBe(reason);
      expect(deletes(calls)).toBe(0);
      expect(before).toBe(0);
    });

    it("refuses an expected name that is not a site name", async () => {
      const { m, calls } = mgmtFor({ id: REF, name: "prod-db", organization_id: "org-1" });
      await expect(m.deleteSiteProject(REF, "prod-db")).rejects.toBeInstanceOf(SiteDeleteRefused);
      expect(calls).toHaveLength(0);
    });

    it("a DELETE that answers 404 after a matching read is not_found", async () => {
      const { m } = mgmtFor({ id: REF, name: NAME, organization_id: "org-1" }, 404);
      expect(await m.deleteSiteProject(REF, NAME)).toBe("not_found");
    });

    it("exposes no raw deleteProject", () => {
      const { m } = mgmtFor(null);
      expect((m as unknown as Record<string, unknown>).deleteProject).toBeUndefined();
    });
  });

  it("a site SQL error surfaces the redacted Postgres message only", async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 400,
      body: { message: "ERROR: 42P01: relation \"todos\" does not exist postgres://u:p@h/db" },
    }));
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    const err = await m.query(REF, "select 1").catch((e) => e);
    expect(err).toBeInstanceOf(SiteSqlError);
    expect(err.sqlMessage).toContain("relation \"todos\" does not exist");
    expect(err.sqlMessage).not.toContain("u:p@h");
  });

  it("isHealthy needs ACTIVE_HEALTHY and every probed service healthy", async () => {
    let healthy = false;
    const { fetchFn } = fakeFetch((c) => {
      if (c.url.endsWith(`/v1/projects/${REF}`)) return { status: 200, body: { id: REF, status: "ACTIVE_HEALTHY" } };
      return { status: 200, body: [{ name: "auth", healthy: true }, { name: "db", healthy }] };
    });
    const m = createSupabaseMgmt({ fetchFn, config: cfg });
    expect(await m.isHealthy(REF)).toBe(false);
    healthy = true;
    expect(await m.isHealthy(REF)).toBe(true);
  });

  it("auth admin: email only in the JSON body, 'already registered' maps to exists", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 422, body: { error_code: "email_exists", msg: "A user with this email address has already been registered" } }));
    const admin = createSupabaseMgmt({ fetchFn, config: cfg }).authAdmin(REF, "service-key");
    expect(await admin.createUser("owner@example.com")).toEqual({ exists: true });
    expect(calls[0].url).toBe(`https://${REF}.supabase.co/auth/v1/admin/users`);
    expect(calls[0].url).not.toContain("owner@");
    expect(calls[0].headers.apikey).toBe("service-key");
  });

  it("auth admin: a non-https action link is refused", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: { action_link: "javascript:alert(1)" } }));
    const admin = createSupabaseMgmt({ fetchFn, config: cfg }).authAdmin(REF, "k");
    await expect(admin.generateMagicLink("o@example.com", "https://x.zaviagent.com/admin")).rejects.toBeInstanceOf(SupabaseMgmtError);
  });
});

describe("redactSqlMessage", () => {
  it("strips JWTs and connection strings and bounds the length", () => {
    const out = redactSqlMessage(`bad eyJhbGciOiJIUzI1NiJ9.abcdefghijk.lmnopqrstuv ${"x".repeat(900)}`);
    expect(out).not.toContain("eyJ");
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
