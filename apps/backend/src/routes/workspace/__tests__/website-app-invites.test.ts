
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { sql: string; params: unknown[] };
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  log: vi.fn(),
  tables: {} as Record<string, unknown>,
  resource: vi.fn(),
  tenantIds: [] as string[],
  queries: [] as Q[],
  query: vi.fn(),
  sendEmail: vi.fn(),
  siteFetch: vi.fn(),
  emailSlots: new Map<string, number>(),
  rateLimitError: null as Error | null,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_auth: unknown, allowed: readonly string[], res: Response) => {
    const role = await mocks.role();
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: { code: "forbidden", message: "forbidden" } });
      return false;
    }
    return true;
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/email/sendAuthEmail", () => ({ sendAppInviteEmail: mocks.sendEmail }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    from(table: string) {
      const result = () => ({ data: mocks.tables[table] ?? null, error: null });
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        or: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => result(),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return builder;
    },
  })),
}));
vi.mock("@/services/settings", () => ({ getStringSetting: vi.fn(), getBoolSetting: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    end() { return Promise.resolve(); }
    query(sql: string, params: unknown[] = []) {
      mocks.queries.push({ sql, params });
      return mocks.query(sql, params);
    }
  },
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn().mockResolvedValue("postgres://app") }));
vi.mock("@/services/tenant-client", () => ({
  consumeTenantRateLimit: vi.fn(async (tenantId: string, _bucket: string, limit: number) => {
    if (mocks.rateLimitError) throw mocks.rateLimitError;
    const count = (mocks.emailSlots.get(tenantId) ?? 0) + 1;
    mocks.emailSlots.set(tenantId, count);
    return count <= limit;
  }),
  tenantClient: (tenantId: string) => {
    mocks.tenantIds.push(tenantId);
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => mocks.resource() }) }) }),
    };
  },
}));

import { clearSignupProbeCache } from "@/services/website/site-signup";
import { createOwnerAdminInvite } from "@/services/website/app-invites";
import {
  ACTIVATION_ATTEMPTS,
  EMAILED_INVITES_PER_HOUR,
  __resetEmailedInvitesForTests,
  createWebsiteAppInviteHandler,
  listWebsiteAppInvitesHandler,
  revokeWebsiteAppInviteHandler,
} from "../website-app-invites";

const READY = { data: { mode: "provisioned", status: "ready", provider: "neon", vault_key: "k" }, error: null };
const CREATED = new Date("2026-09-27T00:00:00Z");
const EXPIRES = new Date("2026-10-04T00:00:00Z");

function response() {
  let status = 200;
  let body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as any, headers }) };
}

function req(over: Partial<Request> = {}): Request {
  return { headers: { authorization: "Bearer jwt" }, body: {}, params: {}, query: {}, ...over } as unknown as Request;
}

function siteDb(opts: { configured?: boolean; revokeRows?: number } = {}) {
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("information_schema.columns")) {
      return opts.configured === false
        ? { rows: [{ users_role: true, invite_cols: 0 }] }
        : { rows: [{ users_role: true, invite_cols: 7 }] };
    }
    if (sql.includes("to_regclass('public._zavi_audit')")) return { rows: [{ ok: true }] };
    if (sql.startsWith("INSERT INTO public.invites")) {
      return { rowCount: 1, rows: [{ id: "41", role: params[1], created_at: CREATED, expires_at: EXPIRES }] };
    }
    if (sql.includes("FROM public.invites")) {
      return { rows: [{ id: "41", role: "admin", created_at: CREATED, expires_at: EXPIRES }] };
    }
    if (sql.startsWith("UPDATE public.invites")) {
      const n = opts.revokeRows ?? 1;
      return { rowCount: n, rows: n ? [{ id: String(params[0]), role: "user", created_at: CREATED, expires_at: EXPIRES }] : [] };
    }
    return { rowCount: 0, rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.tenantIds.length = 0;
  mocks.emailSlots.clear();
  mocks.rateLimitError = null;
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
  mocks.role.mockResolvedValue("owner");
  mocks.log.mockResolvedValue(undefined);
  mocks.sendEmail.mockResolvedValue({ sent: true });
  __resetEmailedInvitesForTests();
  mocks.tables = { tenant_custom_domains: [{ hostname: "site.example.com" }] };
  mocks.resource.mockResolvedValue(READY);
  siteDb();
  clearSignupProbeCache();
  mocks.siteFetch.mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mocks.siteFetch);
});

describe("POST /api/website/app-invites", () => {
  for (const role of ["owner", "admin"] as const) {
    it(`a Zavi ${role} creates an invite link; only the SHA-256 hash is persisted`, async () => {
      mocks.role.mockResolvedValue(role);
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
      const { status, body, headers } = result();
      expect(status).toBe(201);
      expect(headers["Cache-Control"]).toBe("no-store");
      expect(Object.keys(body).sort()).toEqual(["expires_at", "invite_url", "role"]);
      expect(body.role).toBe("admin");
      expect(body.expires_at).toBe(EXPIRES.toISOString());
      const url = new URL(body.invite_url);
      expect(`${url.origin}${url.pathname}`).toBe("https://site.example.com/signup");
      const token = url.searchParams.get("invite")!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,128}$/);

      const insert = mocks.queries.find((q) => q.sql.startsWith("INSERT INTO public.invites"))!;
      expect(insert.params[0]).toBe(createHash("sha256").update(token).digest("hex"));
      expect(insert.params[1]).toBe("admin");
      expect(insert.params[2]).toBe(7);
      const everything = JSON.stringify([mocks.queries, mocks.log.mock.calls]);
      expect(everything).not.toContain(token);
      expect(mocks.queries.map((q) => q.sql)).toEqual(
        expect.arrayContaining(["BEGIN", "COMMIT"]),
      );
      const audit = mocks.queries.find((q) => q.sql.startsWith("INSERT INTO public._zavi_audit"))!;
      expect(audit.params[0]).toBe("app_invite_created");
      expect(JSON.parse(String(audit.params[2]))).toEqual({ invite_id: "41", role: "admin" });
      expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({
        source: "website.app_invites",
        code: "app_invite_created",
        tenant_id: "tenant-a",
        meta: { initiated_by_user: "user-a", app_role: "admin", invite_id: "41" },
      }));
    });
  }

  it("403s a member and never touches the site database", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result()).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(mocks.queries).toHaveLength(0);
    expect(mocks.tenantIds).toHaveLength(0);
  });

  it("rejects any role outside user|admin and any extra field (no tenant/db selector)", async () => {
    for (const body of [{ role: "owner" }, {}, { role: "admin", tenant_id: "tenant-b" }]) {
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body }), res);
      expect(result()).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    }
    expect(mocks.queries).toHaveLength(0);
  });

  it("resolves the site database from the AUTHENTICATED tenant only", async () => {
    const { res } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), res);
    expect(mocks.tenantIds).toEqual(["tenant-a"]);
  });

  it("409 roles_not_configured when the site lacks the invites table / users.role; nothing is written", async () => {
    siteDb({ configured: false });
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result()).toMatchObject({ status: 409, body: { error: { code: "roles_not_configured" } } });
    expect(mocks.queries.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
  });

  it("409 site_not_deployed and no invite minted when the site has no live URL", async () => {
    mocks.tables = {};
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result()).toMatchObject({ status: 409, body: { error: { code: "site_not_deployed" } } });
    expect(mocks.queries).toHaveLength(0);
  });

  it("never sends the token to the founder's marketing URL: marketing-only tenant is 409, nothing inserted", async () => {
    mocks.tables = { tenants: { product_url: { marketing: "https://founder-blog.example.org/" } } };
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result()).toMatchObject({ status: 409, body: { error: { code: "site_not_deployed" } } });
    expect(mocks.queries).toHaveLength(0);
    expect(mocks.tenantIds).toHaveLength(0);
  });

  const hostOf = (body: any) => new URL(body.invite_url).origin;
  const HOSTING = { resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme-app.onrender.com" } };
  const BUILTIN = { resource_kind: "domain", status: "ready", external_ref: { status: "live", hostname: "acme.zaviagent.com" } };

  it("uses the site's own Render host when it is the only address (marketing URL ignored)", async () => {
    mocks.tables = {
      tenants: { product_url: { marketing: "https://founder-blog.example.org/" } },
      tenant_resources: [HOSTING],
    };
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result().status).toBe(201);
    expect(hostOf(result().body)).toBe("https://acme-app.onrender.com");
  });

  it("a verified custom domain wins over the built-in subdomain and the Render host", async () => {
    mocks.tables = {
      tenant_custom_domains: [{ hostname: "app.acme.com" }],
      tenant_resources: [HOSTING, BUILTIN],
    };
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), res);
    expect(hostOf(result().body)).toBe("https://app.acme.com");
  });

  it("a live built-in subdomain wins over the Render host", async () => {
    mocks.tables = { tenant_resources: [HOSTING, BUILTIN] };
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), res);
    expect(hostOf(result().body)).toBe("https://acme.zaviagent.com");
  });

  it("ignores a hosting row that is not ready or not a Render host", async () => {
    for (const row of [
      { ...HOSTING, status: "provisioning" },
      { ...HOSTING, external_ref: { url: "https://evil.example.com" } },
    ]) {
      mocks.tables = { tenant_resources: [row] };
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
      expect(result()).toMatchObject({ status: 409, body: { error: { code: "site_not_deployed" } } });
    }
    expect(mocks.queries).toHaveLength(0);
  });

  it("503 app_db_not_ready when the site has no ready database", async () => {
    mocks.resource.mockResolvedValue({ data: null, error: null });
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin" } }), res);
    expect(result()).toMatchObject({ status: 503, body: { error: { code: "app_db_not_ready" } } });
  });
});

describe("POST /api/website/app-invites with an email", () => {
  it("emails the exact link it returns, to the normalised address, and keeps the address and token out of logs", async () => {
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "  Pat@Example.COM " } }), res);
    const { status, body } = result();
    expect(status).toBe(201);
    expect(body.emailed_to).toBe("pat@example.com");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [tenant, to, args] = mocks.sendEmail.mock.calls[0];
    expect(tenant).toBe("tenant-a");
    expect(to).toBe("pat@example.com");
    expect(args).toEqual({
      inviteUrl: body.invite_url,
      siteHost: "site.example.com",
      role: "user",
      expiresAt: EXPIRES.toISOString(),
    });
    const token = new URL(body.invite_url).searchParams.get("invite")!;
    const logged = JSON.stringify(mocks.log.mock.calls);
    expect(logged).not.toContain("pat@example.com");
    expect(logged).not.toContain(token);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_emailed" }));
    const activation = mocks.queries.find((q) => q.sql.startsWith("UPDATE public.invites"));
    expect(activation?.sql).toMatch(/SET revoked_at = NULL/);
  });

  it("a failed send leaves the just-minted invite inactive and returns no link", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("sendgrid 401"));
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin", email: "pat@example.com" } }), res);
    const { status, body } = result();
    expect(status).toBe(502);
    expect(body).toEqual({ error: expect.objectContaining({ code: "invite_email_failed" }) });
    expect(JSON.stringify(body)).not.toContain("invite=");
    expect(mocks.queries.some((q) => q.sql.startsWith("UPDATE public.invites"))).toBe(false);
    const insert = mocks.queries.find((q) => q.sql.startsWith("INSERT INTO public.invites"));
    expect(insert?.params[3]).toBe(true);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_email_failed", level: "error" }));
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_emailed" }));
  });

  function failActivation(times: number, mode: "throw" | "no_row" = "throw") {
    const base = mocks.query.getMockImplementation()!;
    let seen = 0;
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("UPDATE public.invites SET revoked_at = NULL")) {
        seen++;
        if (seen <= times) {
          if (mode === "throw") throw new Error("connection terminated unexpectedly");
          return { rowCount: 0, rows: [] };
        }
      }
      if (mode === "no_row" && sql.includes("revoked_at IS NULL") && sql.includes("id = $1::bigint")) return { rowCount: 0, rows: [] };
      return base(sql, params);
    });
    return () => seen;
  }

  it("a transient activation failure after the send is retried; the recipient gets exactly one working email", async () => {
    const activations = failActivation(1);
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    const { status, body } = result();
    expect(status).toBe(201);
    expect(body.emailed_to).toBe("pat@example.com");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(activations()).toBe(2);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_emailed" }));
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_email_failed" }));
  });

  it("an activation that keeps failing after the send is reported as such, never as a failed send that invites a resend", async () => {
    const activations = failActivation(Infinity);
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin", email: "pat@example.com" } }), res);
    const { status, body } = result();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(activations()).toBe(ACTIVATION_ATTEMPTS);
    expect(status).toBe(500);
    expect(body.error.code).toBe("invite_activation_failed");
    expect(body.error.message).toMatch(/email was sent/i);
    expect(body.error.message).not.toMatch(/try again/i);
    expect(JSON.stringify(body)).not.toContain("invite=");
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: "app_invite_activation_failed", level: "error", meta: expect.objectContaining({ invite_id: "41" }) }),
    );
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_email_failed" }));
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_emailed" }));
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("pat@example.com");
  });

  it("an activation whose commit landed but whose response was lost counts as activated on the retry", async () => {
    const base = mocks.query.getMockImplementation()!;
    const invite = { id: "41", revoked: true, used: false };
    let updates = 0;
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("UPDATE public.invites SET revoked_at = NULL")) {
        updates++;
        const hit = params[0] === invite.id && invite.revoked && !invite.used;
        if (hit) invite.revoked = false;
        if (updates === 1) throw new Error("connection terminated unexpectedly");
        return hit
          ? { rowCount: 1, rows: [{ id: invite.id, role: "user", created_at: CREATED, expires_at: EXPIRES }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM public.invites") && sql.includes("id = $1::bigint")) {
        const live = params[0] === invite.id && !invite.revoked && !invite.used;
        return live
          ? { rowCount: 1, rows: [{ id: invite.id, role: "user", created_at: CREATED, expires_at: EXPIRES }] }
          : { rowCount: 0, rows: [] };
      }
      return base(sql, params);
    });
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    const { status, body } = result();
    expect(invite.revoked).toBe(false);
    expect(updates).toBe(2);
    expect(status).toBe(201);
    expect(body.emailed_to).toBe("pat@example.com");
    expect(new URL(body.invite_url).searchParams.get("invite")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_emailed" }));
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "app_invite_activation_failed" }));
    const reread = mocks.queries.find((q) => q.sql.startsWith("SELECT") && q.sql.includes("id = $1::bigint"));
    expect(reread?.params).toEqual(["41"]);
    expect(reread?.sql).toMatch(/revoked_at IS NULL/);
    expect(reread?.sql).toMatch(/used_at IS NULL/);
    expect(reread?.sql).toMatch(/expires_at > now\(\)/);
    expect(new Set(mocks.tenantIds)).toEqual(new Set(["tenant-a"]));
  });

  it("an invite that can no longer be activated is not retried and is reported after the single send", async () => {
    const activations = failActivation(Infinity, "no_row");
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    const { status, body } = result();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(activations()).toBe(1);
    expect(status).toBe(500);
    expect(body.error.code).toBe("invite_activation_failed");
  });

  it("400 invalid_email for a malformed address; nothing is minted or sent", async () => {
    for (const email of ["not-an-email", "", "a@b", `${"x".repeat(250)}@example.com`]) {
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body: { role: "user", email } }), res);
      expect(result()).toMatchObject({ status: 400, body: { error: { code: "invalid_email" } } });
    }
    expect(mocks.queries).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("caps emailed invites per tenant per hour; link-only invites and other tenants are unaffected", async () => {
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR; i++) {
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body: { role: "user", email: `p${i}@example.com` } }), res);
      expect(result().status).toBe(201);
    }
    const activations = () => mocks.queries.filter((q) => q.sql.startsWith("UPDATE public.invites") && q.sql.includes("SET revoked_at = NULL")).length;
    const before = activations();
    const over = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "one-more@example.com" } }), over.res);
    expect(over.result()).toMatchObject({ status: 429, body: { error: { code: "invite_email_rate_limited" } } });
    expect(activations()).toBe(before);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAILED_INVITES_PER_HOUR);

    const link = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), link.res);
    expect(link.result().status).toBe(201);

    mocks.auth.mockResolvedValue({ tenant_id: "tenant-b", user_id: "user-b" });
    const other = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "b@example.com" } }), other.res);
    expect(other.result().status).toBe(201);
  });

  it("returns a retryable outage instead of claiming quota exhaustion when the shared limiter fails", async () => {
    mocks.rateLimitError = new Error("database unavailable");
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    expect(result()).toMatchObject({
      status: 503,
      body: { error: { code: "invite_email_unavailable" } },
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.queries.some((q) => q.sql.startsWith("UPDATE public.invites"))).toBe(false);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: "app_invite_rate_limit_failed", level: "error" }),
    );
  });

  async function emailInvite(email: string) {
    const r = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email } }), r.res);
    return r.result();
  }

  async function expectFullBudgetStillAvailable() {
    mocks.tables = { tenant_custom_domains: [{ hostname: "site.example.com" }] };
    siteDb();
    mocks.sendEmail.mockReset();
    mocks.sendEmail.mockResolvedValue({ sent: true });
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR; i++) {
      expect((await emailInvite(`ok${i}@example.com`)).status).toBe(201);
    }
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAILED_INVITES_PER_HOUR);
    expect((await emailInvite("over@example.com")).status).toBe(429);
  }

  it("retries against an undeployed site do not spend the hourly email budget", async () => {
    mocks.tables = {};
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR + 5; i++) {
      expect((await emailInvite(`r${i}@example.com`)).status).toBe(409);
    }
    await expectFullBudgetStillAvailable();
  });

  it("retries against a site without roles do not spend the hourly email budget", async () => {
    siteDb({ configured: false });
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR + 5; i++) {
      expect((await emailInvite(`r${i}@example.com`)).body.error.code).toBe("roles_not_configured");
    }
    await expectFullBudgetStillAvailable();
  });

  it("failed sends remain bounded by the shared hourly email budget", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("sendgrid 500"));
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR; i++) {
      expect((await emailInvite(`r${i}@example.com`)).status).toBe(502);
    }
    expect((await emailInvite("over@example.com")).status).toBe(429);
  });

  it("two concurrent requests for the last shared slot send exactly one email and leave the loser's invite inactive", async () => {
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR - 1; i++) {
      expect((await emailInvite(`p${i}@example.com`)).status).toBe(201);
    }
    mocks.sendEmail.mockClear();
    const updatesBefore = mocks.queries.filter((q) => q.sql.startsWith("UPDATE public.invites")).length;
    const results = await Promise.all([emailInvite("a@example.com"), emailInvite("b@example.com")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.queries.filter((q) => q.sql.startsWith("UPDATE public.invites")).length - updatesBefore).toBe(1);
  });

  it("never emails when the site is not deployed", async () => {
    mocks.tables = {};
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    expect(result().status).toBe(409);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("never emails when the site database refuses the invite", async () => {
    siteDb({ configured: false });
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user", email: "pat@example.com" } }), res);
    expect(result().status).toBe(409);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe("GET /api/website/app-invites", () => {
  it("lists pending invites with id/role/created_at/expires_at only", async () => {
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result()).toEqual({
      status: 200,
      headers: {},
      body: {
        connected: true,
        invites: [{ id: "41", role: "admin", created_at: CREATED.toISOString(), expires_at: EXPIRES.toISOString() }],
        signup_available: true,
      },
    });
    const select = mocks.queries.find((q) => q.sql.includes("FROM public.invites"))!;
    expect(select.sql).toMatch(/used_at IS NULL AND revoked_at IS NULL AND expires_at > now\(\)/);
    expect(select.sql).not.toMatch(/token_hash/);
  });

  it("403s a member", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result().status).toBe(403);
    expect(mocks.queries).toHaveLength(0);
  });

  it("not-ready shape matches app-rows: 200 {connected:false, reason:'not_ready'}", async () => {
    mocks.resource.mockResolvedValue({ data: null, error: null });
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result()).toMatchObject({ status: 200, body: { connected: false, reason: "not_ready" } });
  });

  it("409 roles_not_configured", async () => {
    siteDb({ configured: false });
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result()).toMatchObject({ status: 409, body: { error: { code: "roles_not_configured" } } });
  });
});

describe("POST /api/website/app-invites/:id/revoke", () => {
  it("revokes a pending invite, audits it, and only matches pending rows", async () => {
    const { res, result } = response();
    await revokeWebsiteAppInviteHandler(req({ params: { id: "41" } as any }), res);
    expect(result()).toMatchObject({ status: 200, body: { ok: true, invite: { id: "41", role: "user" } } });
    const upd = mocks.queries.find((q) => q.sql.startsWith("UPDATE public.invites"))!;
    expect(upd.sql).toMatch(/SET revoked_at = now\(\)/);
    expect(upd.sql).toMatch(/used_at IS NULL AND revoked_at IS NULL AND expires_at > now\(\)/);
    expect(upd.params).toEqual(["41"]);
    const audit = mocks.queries.find((q) => q.sql.startsWith("INSERT INTO public._zavi_audit"))!;
    expect(audit.params[0]).toBe("app_invite_revoked");
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({
      code: "app_invite_revoked",
      meta: { initiated_by_user: "user-a", app_role: "user", invite_id: "41" },
    }));
    expect(mocks.tenantIds).toEqual(["tenant-a"]);
  });

  it("404s an id that is not a pending invite of this tenant's site", async () => {
    siteDb({ revokeRows: 0 });
    const { res, result } = response();
    await revokeWebsiteAppInviteHandler(req({ params: { id: "999" } as any }), res);
    expect(result()).toMatchObject({ status: 404, body: { error: { code: "app_invite_not_found" } } });
    expect(mocks.queries.map((q) => q.sql)).toContain("ROLLBACK");
  });

  it("404s a malformed id without opening the site database", async () => {
    for (const id of ["abc", "0", "1;drop", "-1", "1".repeat(20)]) {
      const { res, result } = response();
      await revokeWebsiteAppInviteHandler(req({ params: { id } as any }), res);
      expect(result().status).toBe(404);
    }
    expect(mocks.queries).toHaveLength(0);
  });

  it("403s a member", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await revokeWebsiteAppInviteHandler(req({ params: { id: "41" } as any }), res);
    expect(result().status).toBe(403);
    expect(mocks.queries).toHaveLength(0);
  });
});

describe("invites on a site without a sign-up page", () => {
  const probed = () => mocks.siteFetch.mock.calls.map((c) => String(c[0]));
  const siteSays = (status: number) =>
    mocks.siteFetch.mockImplementation(async () => new Response(null, { status }));

  it("409 site_has_no_signup: no invite minted, no email sent, no email budget spent", async () => {
    siteSays(404);
    for (let i = 0; i < EMAILED_INVITES_PER_HOUR + 2; i++) {
      const { res, result } = response();
      await createWebsiteAppInviteHandler(req({ body: { role: "admin", email: "founder@acme.com" } }), res);
      expect(result().status).toBe(409);
      expect(result().body.error.code).toBe("site_has_no_signup");
      expect(result().body.invite_url).toBeUndefined();
    }
    expect(mocks.queries.some((q) => q.sql.startsWith("INSERT INTO public.invites"))).toBe(false);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(probed()).toEqual(["https://site.example.com/signup"]);

    siteSays(200);
    clearSignupProbeCache();
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "admin", email: "founder@acme.com" } }), res);
    expect(result().status).toBe(201);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("probes without following redirects and treats a redirect as a live sign-up page", async () => {
    siteSays(307);
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), res);
    expect(result().status).toBe(201);
    expect(mocks.siteFetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("fails closed when the site cannot be reached", async () => {
    mocks.siteFetch.mockRejectedValue(new Error("ECONNRESET"));
    const { res, result } = response();
    await createWebsiteAppInviteHandler(req({ body: { role: "user" } }), res);
    expect(result()).toMatchObject({ status: 503, body: { error: { code: "site_unavailable" } } });
  });

  it("the list reports signup_available so the console can stop offering invites", async () => {
    siteSays(404);
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result().status).toBe(200);
    expect(result().body.signup_available).toBe(false);
    expect(probed()).toEqual(["https://site.example.com/signup"]);
  });

  it("the list reports signup_available null and never probes when the site has no address", async () => {
    mocks.tables = {};
    const { res, result } = response();
    await listWebsiteAppInvitesHandler(req(), res);
    expect(result().body.signup_available).toBeNull();
    expect(mocks.siteFetch).not.toHaveBeenCalled();
  });
});

describe("createOwnerAdminInvite: a new owner link kills every earlier emailed admin link", () => {
  function ownerSiteDb(supersede: (params: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("column_name = 'email'")) return { rows: [{ has_email: true }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ users_role: true, invite_cols: 7 }] };
      if (sql.includes("to_regclass('public._zavi_audit')")) return { rows: [{ ok: true }] };
      if (sql.startsWith("INSERT INTO public.invites")) {
        return { rowCount: 1, rows: [{ id: "58", role: params[1], created_at: CREATED, expires_at: EXPIRES }] };
      }
      if (sql.startsWith("UPDATE public.invites")) return supersede(params);
      return { rowCount: 0, rows: [] };
    });
  }

  it("mints the new invite inactive and revokes the other pending emailed admin invites in the same transaction", async () => {
    ownerSiteDb(async () => ({ rowCount: 2, rows: [{ id: "12", role: "admin" }, { id: "31", role: "admin" }] }));
    const out = await createOwnerAdminInvite("tenant-a" as never, "Owner@Zavi.co");
    expect(out.invite.id).toBe("58");
    const sqls = mocks.queries.map((q) => q.sql);
    const begin = sqls.indexOf("BEGIN");
    const insert = sqls.findIndex((q) => q.startsWith("INSERT INTO public.invites"));
    const update = sqls.findIndex((q) => q.startsWith("UPDATE public.invites"));
    const commit = sqls.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(insert);
    expect(insert).toBeLessThan(update);
    expect(update).toBeLessThan(commit);
    const ins = mocks.queries[insert];
    expect(ins.params.slice(1)).toEqual(["admin", 7, true, "Owner@Zavi.co"]);
    const upd = mocks.queries[update];
    expect(upd.sql).toMatch(/SET revoked_at = now\(\)/);
    expect(upd.sql).toMatch(/role = 'admin' AND email IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL/);
    expect(upd.sql).toMatch(/id <> \$1::bigint/);
    expect(upd.params).toEqual(["58"]);
    const revokedAudits = mocks.queries
      .filter((q) => q.sql.startsWith("INSERT INTO public._zavi_audit") && q.params[0] === "app_invite_revoked")
      .map((q) => JSON.parse(String(q.params[2])));
    expect(revokedAudits).toEqual([{ invite_id: "12", role: "admin" }, { invite_id: "31", role: "admin" }]);
    expect(mocks.tenantIds).toEqual(["tenant-a"]);
    expect(JSON.stringify(mocks.queries)).not.toContain(out.token);
  });

  it("a failed revoke rolls back the mint, so no new link exists beside the old ones", async () => {
    ownerSiteDb(async () => {
      throw Object.assign(new Error("lock timeout"), { code: "55P03" });
    });
    await expect(createOwnerAdminInvite("tenant-a" as never, "owner@zavi.co")).rejects.toBeTruthy();
    const sqls = mocks.queries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });
});
