import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { readBlessedTemplate } from "../codegen-templates";

const ADMIN_URL = process.env.SITE_ROLES_PG_URL;

describe.skipIf(!ADMIN_URL)("blessed site templates on real Postgres (roles + invites)", () => {
  const dbName = `site_roles_${Date.now()}_${process.pid}`;
  let dbUrl = "";
  let sql: pg.Pool;
  const cookieJar: Record<string, string> = {};
  let signup: (r: Request) => Promise<Response>;
  let login: (r: Request) => Promise<Response>;
  let auth: Record<string, unknown>;
  const pools: pg.Pool[] = [];
  class TrackedPool extends pg.Pool {
    constructor(opts: pg.PoolConfig) {
      super(opts);
      pools.push(this);
    }
  }

  function migrate(): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: readBlessedTemplate("migrate.mjs.template"),
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(ADMIN_URL as string);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    process.env.DATABASE_URL = dbUrl;
    sql = new pg.Pool({ connectionString: dbUrl });

    const mods: Record<string, unknown> = {
      "server-only": {},
      "node:crypto": { createHash },
      pg: { __esModule: true, default: { types: pg.types, Pool: TrackedPool } },
      "next/server": { NextResponse: Response },
      "next/navigation": {
        redirect: (p: string) => {
          throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${p}` });
        },
        notFound: () => {
          throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
        },
      },
      "next/headers": { cookies: () => ({ get: (k: string) => (k in cookieJar ? { value: cookieJar[k] } : undefined) }) },
      bcryptjs: { __esModule: true, default: { hash: async (p: string) => `h:${p}`, compare: async (p: string, h: string) => h === `h:${p}` } },
      "@/lib/session": {
        createSession: (uid: number) => `tok.${uid}`,
        readSession: (t?: string) => (t?.startsWith("tok.") ? { uid: Number(t.slice(4)) } : null),
      },
    };
    const load = (source: string): Record<string, unknown> => {
      const js = ts.transpileModule(readBlessedTemplate(source), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      }).outputText;
      const module = { exports: {} as Record<string, unknown> };
      new Function("require", "exports", "module", js)((id: string) => {
        if (!(id in mods)) throw new Error(`unmocked import ${id}`);
        return mods[id];
      }, module.exports, module);
      return module.exports;
    };
    mods["@/lib/db"] = load("lib-db.ts.template");
    auth = load("auth-lib.ts.template");
    mods["@/lib/auth"] = auth;
    signup = load("auth-signup-route.ts.template").POST as typeof signup;
    login = load("auth-login-route.ts.template").POST as typeof login;
  });

  afterAll(async () => {
    await sql?.end();
    await Promise.all(pools.map((p) => p.end()));
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const form = (path: string, fields: Record<string, string>) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  const roleOf = async (email: string) =>
    (await sql.query("SELECT role::text AS role FROM users WHERE email = $1", [email])).rows[0]?.role;
  const invite = async (role: string, extra = "now() + interval '7 days'") => {
    const tok = randomBytes(32).toString("base64url");
    await sql.query(
      `INSERT INTO invites (token_hash, role, expires_at) VALUES ($1, $2, ${extra})`,
      [createHash("sha256").update(tok).digest("hex"), role],
    );
    return tok;
  };
  const adminRoute = () => (auth.requireAdminRoute as () => Promise<{ error: Response | null }>)();

  it("migrates, and a second run is a no-op", () => {
    const first = migrate();
    expect(first.status, first.out).toBe(0);
    expect(first.out).toMatch(/applied 0001_initial_schema/);
    const second = migrate();
    expect(second.status, second.out).toBe(0);
    expect(second.out).not.toMatch(/applied/);
  });

  it("the enum rejects any role but user/admin", async () => {
    await expect(sql.query("INSERT INTO users (email, password_hash, role) VALUES ('x@y.z', 'h', 'owner')")).rejects.toThrow(/invalid input value for enum/);
  });

  it("signup posting role=admin stores 'user'; a SQL promotion applies on the next request", async () => {
    const res = await signup(form("/api/signup", { email: "a@b.co", password: "password-1", role: "admin" }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(await roleOf("a@b.co")).toBe("user");
    cookieJar.session = (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
    expect((await adminRoute()).error?.status).toBe(403);
    await sql.query("UPDATE users SET role = 'admin' WHERE email = 'a@b.co'");
    expect((await adminRoute()).error).toBeNull();
  });

  it("an invite redeems once; reuse, expired and revoked fail; the account still exists", async () => {
    const tok = await invite("admin");
    const ok = await signup(form("/api/signup", { email: "b@b.co", password: "password-1", invite: tok }));
    expect(ok.headers.get("location")).toBe("/dashboard");
    expect(await roleOf("b@b.co")).toBe("admin");
    const audit = await sql.query("SELECT event, detail FROM _zavi_audit");
    expect(audit.rows).toEqual([{ event: "invite_redeemed", detail: { role: "admin" } }]);

    for (const [email, t] of [
      ["c@b.co", tok],
      ["d@b.co", await invite("admin", "now() - interval '1 second'")],
    ] as const) {
      const res = await signup(form("/api/signup", { email, password: "password-1", invite: t }));
      expect(res.headers.get("location")).toBe("/dashboard?error=invite");
      expect(await roleOf(email)).toBe("user");
    }
    const revoked = await invite("admin");
    await sql.query("UPDATE invites SET revoked_at = now() WHERE used_at IS NULL AND expires_at > now()");
    const r = await login(form("/api/login", { email: "c@b.co", password: "password-1", invite: revoked }));
    expect(r.headers.get("location")).toBe("/dashboard?error=invite");
    expect(await roleOf("c@b.co")).toBe("user");
  });

  it("a failing role update rolls the whole redemption back (invite stays unused)", async () => {
    await signup(form("/api/signup", { email: "e@b.co", password: "password-1" }));
    await sql.query(`CREATE FUNCTION zz_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'nope'; END $$`);
    await sql.query("CREATE TRIGGER zz_fail BEFORE UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION zz_fail()");
    const tok = await invite("admin");
    const res = await login(form("/api/login", { email: "e@b.co", password: "password-1", invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite");
    const inv = await sql.query("SELECT used_at, used_by FROM invites WHERE token_hash = $1", [createHash("sha256").update(tok).digest("hex")]);
    expect(inv.rows[0]).toEqual({ used_at: null, used_by: null });
    expect((await sql.query("SELECT count(*)::int AS n FROM _zavi_audit")).rows[0].n).toBe(1);
    await sql.query("DROP TRIGGER zz_fail ON users");
    const retry = await login(form("/api/login", { email: "e@b.co", password: "password-1", invite: tok }));
    expect(retry.headers.get("location")).toBe("/dashboard");
    expect(await roleOf("e@b.co")).toBe("admin");
  });
});
