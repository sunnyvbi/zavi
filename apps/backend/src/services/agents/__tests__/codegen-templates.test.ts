import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import ts from "typescript";
import {
  BLESSED_TEMPLATE_FILES,
  readBlessedTemplate,
  buildBlessedTemplatesBaseline,
} from "../codegen-templates";

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("blessed codegen templates — wiring", () => {
  it("ships every blessed file and each one reads non-empty", () => {
    const targets = BLESSED_TEMPLATE_FILES.map((f) => f.target);
    expect(targets).toContain("lib/db.ts");
    expect(targets).toContain("lib/session.ts");
    expect(targets).toContain("scripts/migrate.mjs");
    expect(targets).toContain("lib/auth.ts");
    expect(targets).toContain("app/api/signup/route.ts");
    expect(targets).toContain("app/api/login/route.ts");
    expect(targets).toContain("app/api/logout/route.ts");
    for (const f of BLESSED_TEMPLATE_FILES) {
      expect(readBlessedTemplate(f.source).length).toBeGreaterThan(100);
    }
  });

  it("the assembled prompt block references each blessed file by its target path", () => {
    const block = buildBlessedTemplatesBaseline();
    expect(block).toContain("BLESSED TEMPLATES BASELINE");
    expect(block).toContain("CONFIGURE");
    for (const f of BLESSED_TEMPLATE_FILES) {
      expect(block).toContain(f.target);
    }
  });
});

describe("lib/session.ts template — fail-closed SESSION_SECRET (no account-takeover hole)", () => {
  const session = readBlessedTemplate("lib-session.ts.template");

  it("reads process.env.SESSION_SECRET with NO hardcoded fallback", () => {
    expect(session).toContain("process.env.SESSION_SECRET");
    expect(codeOnly(session)).not.toMatch(
      /process\.env\.SESSION_SECRET\s*(\|\||\?\?)\s*['"`][^'"`]+['"`]/,
    );
  });

  it("FAILS CLOSED — throws when the secret is missing/empty", () => {
    expect(session).toMatch(/throw new Error\(\s*[\s\S]*SESSION_SECRET is not set/);
  });

  it("does NOT throw at module top-level (build-safe — next build runs before the secret exists)", () => {
    expect(session).toMatch(/function sessionSecret\(\)/);
  });

  it("carries an expiry inside the SIGNED payload and rejects expired tokens", () => {
    expect(session).toContain("exp");
    expect(session).toMatch(/exp\s*<\s*Math\.floor\(Date\.now\(\)/);
  });

  it("keeps the secret server-only and never hard-rejects uid on typeof", () => {
    expect(session).toContain('import "server-only"');
    expect(codeOnly(session)).not.toMatch(/typeof\s+\w*uid\w*\s*!==\s*["']number["']/i);
    expect(session).toMatch(/Number\.isInteger/);
  });
});

describe("lib/db.ts template — int8 type-parser + server-only", () => {
  const db = readBlessedTemplate("lib-db.ts.template");

  it("registers the int8 (OID 20) type-parser so BIGINT ids deserialize as numbers", () => {
    expect(db).toMatch(/setTypeParser\(\s*20\s*,/);
  });

  it("is server-only and never disables TLS verification", () => {
    expect(db).toContain('import "server-only"');
    expect(codeOnly(db)).not.toMatch(/rejectUnauthorized:\s*false/);
  });
});

describe("scripts/migrate.mjs template — append-only, data-preserving, fail-loud", () => {
  const migrate = readBlessedTemplate("migrate.mjs.template");

  it("degrades gracefully when DATABASE_URL is unset (exit 0)", () => {
    expect(migrate).toMatch(/DATABASE_URL unset[\s\S]*process\.exit\(0\)/);
  });

  it("uses a transactional append-only ledger and rejects destructive SQL", () => {
    expect(migrate).toContain("_schema_migrations");
    expect(migrate).toContain("checksum TEXT NOT NULL");
    expect(migrate).toContain('createHash("sha256")');
    expect(migrate).toMatch(/was edited; append a new migration instead/);
    expect(migrate).toContain("pg_advisory_xact_lock");
    expect(migrate).toMatch(/BEGIN/);
    expect(migrate).toMatch(/ROLLBACK/);
    expect(migrate).toMatch(/DROP\\s\+\(TABLE\|COLUMN\|SCHEMA\|DATABASE\)/);
    expect(migrate).toContain("DELETE\\s+FROM");
    expect(migrate).not.toMatch(/DROP TABLE IF EXISTS/);
  });

  it("bounds the connection retry and fails loud on bad DDL (exit non-zero)", () => {
    expect(migrate).toMatch(/connectWithRetry/);
    expect(migrate).toMatch(/process\.exitCode\s*=\s*1/);
  });

  describe("transient-error resilience", () => {
    function loadRetryLogic(): {
      isTransient: (e: unknown) => boolean;
      withRetry: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    } {
      const start = migrate.indexOf("const TRANSIENT_MSG");
      const end = migrate.indexOf("const connectWithRetry");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const factory = new Function(
        "sleep",
        "console",
        `${migrate.slice(start, end)}; return { isTransient, withRetry };`,
      );
      return factory(
        async () => {},
        { ...console, warn: () => {} },
      );
    }

    it("classifies a spurious 42501 from a waking compute as transient", () => {
      const { isTransient } = loadRetryLogic();
      expect(isTransient({ code: "42501", message: "permission denied for schema pg_catalog" })).toBe(true);
    });

    it("does NOT classify a genuine bad-DDL error as transient", () => {
      const { isTransient } = loadRetryLogic();
      expect(isTransient({ code: "42P01", message: 'relation "nope" does not exist' })).toBe(false);
      expect(isTransient({ code: "42601", message: "syntax error at or near" })).toBe(false);
    });

    it("recovers when the schema step fails transiently then succeeds", async () => {
      const { withRetry } = loadRetryLogic();
      let calls = 0;
      const result = await withRetry("schema", async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("permission denied for schema pg_catalog"), { code: "42501" });
        return "migrated";
      });
      expect(result).toBe("migrated");
      expect(calls).toBe(3);
    });

    it("still fails loud when the error persists (bounded, never infinite)", async () => {
      const { withRetry } = loadRetryLogic();
      let calls = 0;
      await expect(
        withRetry("schema", async () => {
          calls += 1;
          throw Object.assign(new Error("permission denied for schema pg_catalog"), { code: "42501" });
        }),
      ).rejects.toThrow(/permission denied/);
      expect(calls).toBe(10);
    });

    it("fails fast on a non-transient error — no wasted retries", async () => {
      const { withRetry } = loadRetryLogic();
      let calls = 0;
      await expect(
        withRetry("schema", async () => {
          calls += 1;
          throw Object.assign(new Error('relation "x" does not exist'), { code: "42P01" });
        }),
      ).rejects.toThrow(/does not exist/);
      expect(calls).toBe(1);
    });

    it("wraps the SCHEMA step, not just the connect", () => {
      expect(migrate).toMatch(/withRetry\(\s*["']schema["']/);
    });
  });
});

type Role = "user" | "admin";
type FakeUser = { id: number; email: string; password_hash: string; role: Role };
type FakeInvite = {
  token_hash: string;
  role: Role;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
  revoked_at: number | null;
  email?: string | null;
};
type FakeAudit = { event: string; target_user_id: number; detail: unknown };
type Tables = { users: FakeUser[]; invites: FakeInvite[]; audit: FakeAudit[] };

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

function makeHarness() {
  let t: Tables = { users: [], invites: [], audit: [] };
  const state = { dbDown: false, queries: 0, failUserRoleUpdate: false, released: 0, txLog: [] as string[], inviteEmailColumn: true };
  const cookieJar: Record<string, string> = {};
  const bcrypt = {
    compares: 0,
    hash: async (pw: string) => `h:${pw}`,
    compare: async (pw: string, hash: string) => {
      bcrypt.compares += 1;
      return hash === `h:${pw}`;
    },
  };
  function run(text: string, params: unknown[] = []) {
    state.queries += 1;
    if (state.dbDown) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const now = Date.now();
    if (text.startsWith("INSERT INTO users")) {
      expect(text).toMatch(/^INSERT INTO users \(email, password_hash\) VALUES \(\$1, \$2\)/);
      const [email, password_hash] = params as [string, string];
      if (t.users.some((u) => u.email === email)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: "23505" });
      }
      const row: FakeUser = { id: t.users.length + 1, email, password_hash, role: "user" };
      t.users.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (text.startsWith("SELECT id, password_hash FROM users WHERE email")) {
      const r = t.users.filter((u) => u.email === params[0]);
      return { rows: r, rowCount: r.length };
    }
    if (text.startsWith("SELECT id, email, role FROM users WHERE id")) {
      const r = t.users.filter((u) => u.id === params[0]).map(({ id, email, role }) => ({ id, email, role }));
      return { rows: r, rowCount: r.length };
    }
    const userEmail = (id: unknown) => t.users.find((u) => u.id === id)?.email.toLowerCase();
    if (text.startsWith("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invites' AND column_name = 'email') AS has_email")) {
      return { rows: [{ has_email: state.inviteEmailColumn }], rowCount: 1 };
    }
    if (!state.inviteEmailColumn && /FROM invites|UPDATE invites/.test(text) && /\bemail\b/.test(text.replace(/FROM users WHERE id/g, ""))) {
      throw Object.assign(new Error('column "email" does not exist'), { code: "42703" });
    }
    if (text.startsWith("UPDATE invites SET used_at = now(), used_by = $2 WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING role")) {
      const inv = t.invites.find(
        (i) => i.token_hash === params[0] && i.used_at === null && i.revoked_at === null && i.expires_at > now,
      );
      if (!inv) return { rows: [], rowCount: 0 };
      inv.used_at = now;
      inv.used_by = params[1] as number;
      return { rows: [{ role: inv.role }], rowCount: 1 };
    }
    if (text.startsWith("UPDATE invites SET used_at = now(), used_by = $2 WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND (email IS NULL OR lower(email) = (SELECT lower(email) FROM users WHERE id = $2)) RETURNING role")) {
      const inv = t.invites.find(
        (i) =>
          i.token_hash === params[0] &&
          i.used_at === null &&
          i.revoked_at === null &&
          i.expires_at > now &&
          (i.email == null || i.email.toLowerCase() === userEmail(params[1])),
      );
      if (!inv) return { rows: [], rowCount: 0 };
      inv.used_at = now;
      inv.used_by = params[1] as number;
      return { rows: [{ role: inv.role }], rowCount: 1 };
    }
    if (text.startsWith("SELECT 1 AS n FROM invites WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND email IS NOT NULL AND lower(email) <> (SELECT lower(email) FROM users WHERE id = $2)")) {
      const r = t.invites.filter(
        (i) =>
          i.token_hash === params[0] &&
          i.used_at === null &&
          i.revoked_at === null &&
          i.expires_at > now &&
          i.email != null &&
          i.email.toLowerCase() !== userEmail(params[1]),
      );
      return { rows: r.map(() => ({ n: 1 })), rowCount: r.length };
    }
    if (text.startsWith("UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND email IS NOT NULL RETURNING id, role, email")) {
      const idx = t.invites.findIndex(
        (i) => i.token_hash === params[0] && i.used_at === null && i.revoked_at === null && i.expires_at > now && i.email != null,
      );
      if (idx < 0) return { rows: [], rowCount: 0 };
      t.invites[idx].used_at = now;
      return { rows: [{ id: idx + 1, role: t.invites[idx].role, email: t.invites[idx].email }], rowCount: 1 };
    }
    if (text.startsWith("SELECT id, role FROM users WHERE lower(email) = $1")) {
      const r = t.users.filter((u) => u.email.toLowerCase() === params[0]).map(({ id, role }) => ({ id, role }));
      return { rows: r, rowCount: r.length };
    }
    if (text.startsWith("UPDATE users SET email = $2 WHERE id = $1")) {
      const u = t.users.find((x) => x.id === params[0]);
      if (u) u.email = params[1] as string;
      return { rows: [], rowCount: u ? 1 : 0 };
    }
    if (text.startsWith("UPDATE invites SET used_by = $2 WHERE id = $1")) {
      const inv = t.invites[(params[0] as number) - 1];
      if (inv) inv.used_by = params[1] as number;
      return { rows: [], rowCount: inv ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO _zavi_audit (event, target_user_id, detail) VALUES ('magic_login', $1, $2)")) {
      t.audit.push({ event: "magic_login", target_user_id: params[0] as number, detail: JSON.parse(params[1] as string) });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("DELETE FROM users WHERE id = $1")) {
      const before = t.users.length;
      t.users = t.users.filter((u) => u.id !== params[0]);
      return { rows: [], rowCount: before - t.users.length };
    }
    if (text.startsWith("UPDATE users SET role = $1 WHERE id = $2 AND role = 'user'")) {
      if (state.failUserRoleUpdate) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      const u = t.users.find((x) => x.id === params[1] && x.role === "user");
      if (u) u.role = params[0] as Role;
      return { rows: [], rowCount: u ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO _zavi_audit (event, target_user_id, detail) VALUES ('invite_redeemed', $1, $2)")) {
      t.audit.push({ event: "invite_redeemed", target_user_id: params[0] as number, detail: JSON.parse(params[1] as string) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  class FakePool {
    async query(text: string, params?: unknown[]) {
      return run(text, params);
    }
    async connect() {
      let snapshot: Tables | null = null;
      return {
        query: async (text: string, params?: unknown[]) => {
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            state.txLog.push(text);
            if (text === "BEGIN") snapshot = structuredClone(t);
            if (text === "ROLLBACK" && snapshot) t = snapshot;
            if (text !== "BEGIN") snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          return run(text, params);
        },
        release: () => {
          state.released += 1;
        },
      };
    }
  }
  const session = {
    createSession: (uid: number) => `tok.${uid}`,
    readSession: (tok?: string) => (tok && tok.startsWith("tok.") ? { uid: Number(tok.slice(4)) } : null),
  };
  const nav = {
    redirect: (path: string) => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${path}` });
    },
    notFound: () => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
    },
  };
  const mods: Record<string, unknown> = {
    "server-only": {},
    "node:crypto": { createHash, createHmac, randomBytes, timingSafeEqual },
    pg: { __esModule: true, default: { types: { setTypeParser: () => undefined }, Pool: FakePool } },
    "next/server": { NextResponse: Response },
    "next/navigation": nav,
    "next/headers": { cookies: () => ({ get: (k: string) => (k in cookieJar ? { value: cookieJar[k] } : undefined) }) },
    bcryptjs: { default: bcrypt, __esModule: true },
    "@/lib/session": session,
  };
  function load(source: string): Record<string, unknown> {
    const js = ts.transpileModule(readBlessedTemplate(source), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    const req = (id: string) => {
      if (!(id in mods)) throw new Error(`unmocked import ${id}`);
      return mods[id];
    };
    new Function("require", "exports", "module", js)(req, module.exports, module);
    return module.exports;
  }
  const db = load("lib-db.ts.template");
  mods["@/lib/db"] = db;
  const auth = load("auth-lib.ts.template");
  mods["@/lib/auth"] = auth;
  return {
    get users() {
      return t.users;
    },
    get invites() {
      return t.invites;
    },
    get audit() {
      return t.audit;
    },
    addInvite(role: Role, opts: Partial<Omit<FakeInvite, "token_hash" | "role">> = {}, token = newToken()): string {
      t.invites.push({
        token_hash: sha256(token),
        role,
        expires_at: Date.now() + 7 * 86_400_000,
        used_at: null,
        used_by: null,
        revoked_at: null,
        ...opts,
      });
      return token;
    },
    state,
    bcrypt,
    cookieJar,
    session,
    load,
    db,
    auth,
    signup: load("auth-signup-route.ts.template").POST as (r: Request) => Promise<Response>,
    login: load("auth-login-route.ts.template").POST as (r: Request) => Promise<Response>,
    logout: load("auth-logout-route.ts.template").POST as (r: Request) => Promise<Response>,
    magicPage: load("auth-magic-route.ts.template").GET as (r: Request) => Promise<Response>,
    magic: load("auth-magic-route.ts.template").POST as (r: Request) => Promise<Response>,
  };
}

function post(
  path: string,
  fields: Record<string, string>,
  ip = "1.2.3.4",
  extra: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(fields);
  return new Request(`http://localhost:10000${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.0.0.1, ${ip}`, ...extra },
    body,
  });
}

function errorOf(res: Response): string | null {
  const loc = res.headers.get("location") ?? "";
  const q = loc.split("?")[1];
  return q ? new URLSearchParams(q).get("error") : null;
}

function withFakeDatabaseUrl() {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fake/test";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });
}

async function thrown(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { digest?: string; message: string }).digest ?? (e as Error).message;
  }
  return "no-throw";
}

describe("auth templates — executable signup / login / logout", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  withFakeDatabaseUrl();

  it("signup creates the user with a bcrypt hash and sets a signed httpOnly session cookie", async () => {
    const res = await h.signup(post("/api/signup", { email: " Ann@Example.com ", password: "correct-horse" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^session=tok\.1;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(h.users).toEqual([{ id: 1, email: "ann@example.com", password_hash: "h:correct-horse", role: "user" }]);
  });

  it("signup rejects a bad email or a short password without touching the database", async () => {
    for (const f of [{ email: "nope", password: "longenough" }, { email: "a@b.co", password: "short" }]) {
      const res = await h.signup(post("/api/signup", f));
      expect(res.headers.get("location")).toMatch(/^\/signup\?error=/);
    }
    expect(h.state.queries).toBe(0);
  });

  it("signup on a taken email: the INSERT's 23505 becomes a generic message, not a 500", async () => {
    await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    const res = await h.signup(post("/api/signup", { email: "a@b.co", password: "password-2" }));
    expect(res.status).toBe(303);
    expect(errorOf(res)).toBe("exists");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.users).toHaveLength(1);
  });

  it("signup never checks-then-inserts (the unique index is the only arbiter)", () => {
    expect(codeOnly(readBlessedTemplate("auth-signup-route.ts.template"))).not.toMatch(/SELECT[^"]*FROM users/);
  });

  it("signup with the database down: generic message, no stack or driver text", async () => {
    h.state.dbDown = true;
    const res = await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    expect(errorOf(res)).toBe("server");
  });

  describe("SESSION_SECRET missing on the live site (DEL-1323 B3)", () => {
    let prevSecret: string | undefined;
    beforeEach(() => {
      prevSecret = process.env.SESSION_SECRET;
      delete process.env.SESSION_SECRET;
      h.session.createSession = h.load("lib-session.ts.template").createSession as (uid: number) => string;
    });
    afterEach(() => {
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    });

    it("signup answers a redirect with the server error, never a bare 500 blank page", async () => {
      const res = await h.signup(post("/api/signup", { email: "owner@b.co", password: "password-1" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/signup?error=server");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((h.auth.authErrorMessage as (c: string | null) => string | null)(errorOf(res))).toBe("Something went wrong. Try again.");
    });

    it("login answers a redirect with the server error and sets no cookie", async () => {
      h.users.push({ id: 7, email: "owner@b.co", password_hash: "h:password-1", role: "user" });
      const res = await h.login(post("/api/login", { email: "owner@b.co", password: "password-1" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login?error=server");
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });

  it("login succeeds with the right password and sets the session", async () => {
    await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    const res = await h.login(post("/api/login", { email: "A@B.co", password: "password-1" }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
  });

  it("login: unknown email and wrong password get the SAME message, and both pay a bcrypt compare", async () => {
    await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    const wrong = await h.login(post("/api/login", { email: "a@b.co", password: "password-2" }));
    const before = h.bcrypt.compares;
    const unknown = await h.login(post("/api/login", { email: "ghost@b.co", password: "password-1" }));
    expect(errorOf(wrong)).toBe("invalid");
    expect(errorOf(unknown)).toBe(errorOf(wrong));
    expect(h.bcrypt.compares).toBe(before + 1);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });

  it("login is throttled per email (across IPs) before the database is touched", async () => {
    await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    const limit = (h.auth.LIMITS as { email: number }).email;
    for (let i = 0; i < limit; i++) {
      await h.login(post("/api/login", { email: "a@b.co", password: `guess-${i}` }, `9.9.9.${i}`));
    }
    const q = h.state.queries;
    const res = await h.login(post("/api/login", { email: "a@b.co", password: "password-1" }, "8.8.8.8"));
    expect(errorOf(res)).toBe("too_many");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.state.queries).toBe(q);
  });

  it("login is throttled per IP (across emails)", async () => {
    const limit = (h.auth.LIMITS as { ip: number }).ip;
    for (let i = 0; i < limit; i++) {
      await h.login(post("/api/login", { email: `u${i}@b.co`, password: "x-password" }, "7.7.7.7"));
    }
    const res = await h.login(post("/api/login", { email: "new@b.co", password: "x-password" }, "7.7.7.7"));
    expect(errorOf(res)).toBe("too_many");
    const other = await h.login(post("/api/login", { email: "new@b.co", password: "x-password" }, "6.6.6.6"));
    expect(errorOf(other)).toBe("invalid");
  });

  it("the per-IP key is the LAST X-Forwarded-For hop, so a spoofed leading value changes nothing", () => {
    const clientIp = h.auth.clientIp as (r: Request) => string;
    const withXff = (xff: string) => new Request("http://x/", { headers: { "x-forwarded-for": xff } });
    expect(clientIp(withXff("6.6.6.6, 5.5.5.5"))).toBe("5.5.5.5");
    expect(clientIp(withXff("1.1.1.1, 5.5.5.5"))).toBe(clientIp(withXff("6.6.6.6, 5.5.5.5")));
    expect(clientIp(new Request("http://x/", { headers: { "x-real-ip": "4.4.4.4" } }))).toBe("4.4.4.4");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });

  it("the throttle window slides and the key map stays bounded", () => {
    const tooMany = h.auth.tooManyAttempts as (k: Array<{ key: string; limit: number }>, now?: number) => boolean;
    const t0 = 1_000_000;
    expect(tooMany([{ key: "k", limit: 1 }], t0)).toBe(false);
    expect(tooMany([{ key: "k", limit: 1 }], t0 + 1)).toBe(true);
    expect(tooMany([{ key: "k", limit: 1 }], t0 + 16 * 60 * 1000)).toBe(false);
    for (let i = 0; i < 10_050; i++) tooMany([{ key: `bulk-${i}`, limit: 5 }], t0);
    expect(tooMany([{ key: "k", limit: 1 }], t0 + 16 * 60 * 1000 + 1)).toBe(false);
  });

  it("logout clears the cookie and redirects relatively to /login", async () => {
    const res = await h.logout(post("/api/logout", {}));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie")).toMatch(/^session=; .*Max-Age=0/);
  });

  it("currentUser reads the signed cookie and returns a numeric id", async () => {
    await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1" }));
    const currentUser = h.auth.currentUser as () => Promise<{ id: number; email: string; role: string } | null>;
    expect(await currentUser()).toBeNull();
    h.cookieJar.session = "tok.1";
    expect(await currentUser()).toEqual({ id: 1, email: "a@b.co", role: "user" });
  });

  describe("login CSRF: cross-site POSTs are refused before any other work", () => {
    const creds = { email: "a@b.co", password: "password-1" };
    const siteHost = { host: "shop.example.com" };

    it("a cross-site Origin gets a plain 403 on signup, login and logout", async () => {
      const evil = { ...siteHost, origin: "https://evil.example" };
      for (const [route, path] of [[h.signup, "/api/signup"], [h.login, "/api/login"], [h.logout, "/api/logout"]] as const) {
        const res = await route(post(path, creds, "1.2.3.4", evil));
        expect(res.status).toBe(403);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      expect(h.state.queries).toBe(0);
      expect(h.users).toHaveLength(0);
    });

    it("Sec-Fetch-Site: cross-site is refused even without an Origin", async () => {
      const res = await h.login(post("/api/login", creds, "1.2.3.4", { "sec-fetch-site": "cross-site" }));
      expect(res.status).toBe(403);
      expect(h.state.queries).toBe(0);
    });

    it("a same-origin POST is allowed (Origin host matches x-forwarded-host, else host)", async () => {
      const ok = await h.signup(post("/api/signup", creds, "1.2.3.4", { ...siteHost, origin: "https://shop.example.com", "sec-fetch-site": "same-origin" }));
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe("/dashboard");
      const proxied = await h.login(post("/api/login", creds, "1.2.3.4", { host: "localhost:10000", "x-forwarded-host": "shop.example.com", origin: "https://shop.example.com" }));
      expect(proxied.headers.get("location")).toBe("/dashboard");
    });

    it("no Origin and no Sec-Fetch-Site is allowed (old clients)", async () => {
      const res = await h.signup(post("/api/signup", creds));
      expect(res.status).toBe(303);
      expect(h.users).toHaveLength(1);
    });
  });

  it("no auth template redirects via new URL(path, req.url)", () => {
    for (const f of BLESSED_TEMPLATE_FILES.filter((x) => x.source.startsWith("auth-"))) {
      expect(codeOnly(readBlessedTemplate(f.source))).not.toMatch(/new URL\([^,]+,\s*req\.url/);
    }
  });
});

describe("auth templates — roles: nothing but an invite grants admin", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  withFakeDatabaseUrl();

  type Guarded = { user: { id: number; role: string } | null; error: Response | null };
  const creds = (email = "a@b.co") => ({ email, password: "password-1" });
  const requireAdminRoute = () => (h.auth.requireAdminRoute as () => Promise<Guarded>)();
  const requireAdminPage = () => (h.auth.requireAdminPage as () => Promise<{ id: number; role: string }>)();
  const requireAdminAction = () => (h.auth.requireAdminAction as () => Promise<{ id: number; role: string }>)();
  const redeemInvite = (tok: string, uid: number) =>
    (h.auth.redeemInvite as (t: string, u: number) => Promise<string | null>)(tok, uid);

  it("signup ignores a posted role=admin (and is_admin): the stored role is the DB default 'user'", async () => {
    const res = await h.signup(post("/api/signup", { ...creds(), role: "admin", is_admin: "true" }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(h.users[0].role).toBe("user");
    h.cookieJar.session = "tok.1";
    expect((await requireAdminRoute()).error?.status).toBe(403);
  });

  it("the FIRST user to sign up is a plain user too (no first-user admin)", async () => {
    await h.signup(post("/api/signup", creds("first@b.co")));
    await h.signup(post("/api/signup", creds("second@b.co")));
    expect(h.users.map((u) => u.role)).toEqual(["user", "user"]);
  });

  it("requireAdminRoute: 401 signed out, 403 for a user, the user for an admin", async () => {
    await h.signup(post("/api/signup", creds()));
    const out = await requireAdminRoute();
    expect(out.user).toBeNull();
    expect(out.error?.status).toBe(401);
    h.cookieJar.session = "tok.1";
    const asUser = await requireAdminRoute();
    expect(asUser.error?.status).toBe(403);
    expect(asUser.user).toBeNull();
    h.users[0].role = "admin";
    const asAdmin = await requireAdminRoute();
    expect(asAdmin.error).toBeNull();
    expect(asAdmin.user).toEqual({ id: 1, email: "a@b.co", role: "admin" });
  });

  it("a role change applies on the NEXT request with the same session cookie", async () => {
    await h.signup(post("/api/signup", creds()));
    h.cookieJar.session = "tok.1";
    expect((await requireAdminRoute()).error?.status).toBe(403);
    h.users[0].role = "admin";
    expect((await requireAdminRoute()).error).toBeNull();
    h.users[0].role = "user";
    expect((await requireAdminRoute()).error?.status).toBe(403);
    expect(h.cookieJar.session).toBe("tok.1");
  });

  it("requireAdminPage: signed out -> redirect /login, user -> notFound, admin -> the user", async () => {
    await h.signup(post("/api/signup", creds()));
    expect(await thrown(requireAdminPage())).toBe("NEXT_REDIRECT;replace;/login");
    h.cookieJar.session = "tok.1";
    expect(await thrown(requireAdminPage())).toBe("NEXT_NOT_FOUND");
    h.users[0].role = "admin";
    expect(await requireAdminPage()).toMatchObject({ id: 1, role: "admin" });
  });

  it("requireAdminAction: throws for signed out and for a user, returns the admin", async () => {
    await h.signup(post("/api/signup", creds()));
    expect(await thrown(requireAdminAction())).toBe("Forbidden");
    h.cookieJar.session = "tok.1";
    expect(await thrown(requireAdminAction())).toBe("Forbidden");
    h.users[0].role = "admin";
    expect(await requireAdminAction()).toMatchObject({ id: 1, role: "admin" });
  });

  it("redeemInvite: an admin invite promotes, marks the invite used and writes one audit row", async () => {
    await h.signup(post("/api/signup", creds()));
    const tok = h.addInvite("admin");
    expect(await redeemInvite(tok, 1)).toBe("admin");
    expect(h.users[0].role).toBe("admin");
    expect(h.invites[0]).toMatchObject({ used_by: 1 });
    expect(h.invites[0].used_at).not.toBeNull();
    expect(h.audit).toEqual([{ event: "invite_redeemed", target_user_id: 1, detail: { role: "admin" } }]);
    expect(h.state.txLog).toEqual(["BEGIN", "COMMIT"]);
    expect(h.state.released).toBe(1);
  });

  it("redeemInvite: reuse, expired, revoked and wrong tokens return null and change nothing", async () => {
    await h.signup(post("/api/signup", creds("a@b.co")));
    await h.signup(post("/api/signup", creds("b@b.co")));
    const used = h.addInvite("admin");
    expect(await redeemInvite(used, 1)).toBe("admin");
    const expired = h.addInvite("admin", { expires_at: Date.now() - 1000 });
    const revoked = h.addInvite("admin", { revoked_at: Date.now() - 1000 });
    const auditBefore = h.audit.length;
    for (const tok of [used, expired, revoked, newToken()]) {
      expect(await redeemInvite(tok, 2)).toBeNull();
    }
    expect(h.users[1].role).toBe("user");
    expect(h.audit).toHaveLength(auditBefore);
    expect(h.invites.filter((i) => i.used_by === 2)).toHaveLength(0);
  });

  it("redeemInvite: an oversized or malformed token is refused before any query or hashing", async () => {
    await h.signup(post("/api/signup", creds()));
    const q = h.state.queries;
    for (const tok of ["A".repeat(129), "short", "", "has space-and-more-than-twenty", "x'; UPDATE users SET role='admin' --", "é".repeat(30)]) {
      expect(await redeemInvite(tok, 1)).toBeNull();
    }
    expect(h.state.queries).toBe(q);
    expect(h.state.txLog).toEqual([]);
    expect(h.users[0].role).toBe("user");
  });

  it("redeemInvite: a user invite never demotes an existing admin", async () => {
    await h.signup(post("/api/signup", creds()));
    h.users[0].role = "admin";
    expect(await redeemInvite(h.addInvite("user"), 1)).toBe("user");
    expect(h.users[0].role).toBe("admin");
  });

  it("redeemInvite ROLLS BACK when the role update fails: the invite stays unused, no audit row", async () => {
    await h.signup(post("/api/signup", creds()));
    const tok = h.addInvite("admin");
    h.state.failUserRoleUpdate = true;
    await expect(redeemInvite(tok, 1)).rejects.toThrow(/deadlock/);
    expect(h.state.txLog).toEqual(["BEGIN", "ROLLBACK"]);
    expect(h.state.released).toBe(1);
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
    expect(h.audit).toEqual([]);
    expect(h.users[0].role).toBe("user");
    h.state.failUserRoleUpdate = false;
    expect(await redeemInvite(tok, 1)).toBe("admin");
  });

  it("signup with a valid admin invite: account created, signed in, promoted", async () => {
    const tok = h.addInvite("admin");
    const res = await h.signup(post("/api/signup", { ...creds(), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users[0].role).toBe("admin");
  });

  it("signup with a used/expired invite: account still created as user, fixed error CODE, token not echoed", async () => {
    const tok = h.addInvite("admin", { expires_at: Date.now() - 1 });
    const res = await h.signup(post("/api/signup", { ...creds(), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users[0].role).toBe("user");
  });

  it("an owner invite bound to another email is refused with invite_email: no promotion, invite stays live", async () => {
    const tok = h.addInvite("admin", { email: "owner@zavi.co" });
    const res = await h.signup(post("/api/signup", { ...creds("stranger@b.co"), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite_email");
    expect(h.users[0].role).toBe("user");
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
    expect(h.audit).toEqual([]);
    expect((h.auth.authErrorMessage as (c: string) => string | null)("invite_email")).toMatch(/different email/);
    expect(await redeemInvite(tok, 1)).toBeNull();
    const owner = await h.signup(post("/api/signup", { ...creds("Owner@Zavi.co"), invite: tok }));
    expect(owner.headers.get("location")).toBe("/dashboard");
    expect(h.users[1]).toMatchObject({ email: "owner@zavi.co", role: "admin" });
    expect(h.invites[0].used_by).toBe(2);
  });

  it("an owner invite matches the account email case-insensitively on login too", async () => {
    await h.signup(post("/api/signup", creds("owner@zavi.co")));
    const tok = h.addInvite("admin", { email: "OWNER@Zavi.CO" });
    const res = await h.login(post("/api/login", { email: "owner@zavi.co", password: "password-1", invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(h.users[0].role).toBe("admin");
  });

  it("a site whose invites table predates the email column still redeems an owner invite", async () => {
    h.state.inviteEmailColumn = false;
    const tok = h.addInvite("admin");
    const res = await h.signup(post("/api/signup", { ...creds("owner@zavi.co"), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(h.users[0].role).toBe("admin");
    expect(h.invites[0].used_by).toBe(1);
    expect(h.audit).toEqual([{ event: "invite_redeemed", target_user_id: 1, detail: { role: "admin" } }]);
  });

  it("once the email column lands, the same site binds invites to the email", async () => {
    h.state.inviteEmailColumn = false;
    await h.signup(post("/api/signup", creds("first@b.co")));
    h.state.inviteEmailColumn = true;
    const tok = h.addInvite("admin", { email: "owner@zavi.co" });
    const res = await h.signup(post("/api/signup", { ...creds("stranger@b.co"), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite_email");
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
  });

  it("an expired owner invite for another email says invite, not invite_email", async () => {
    const tok = h.addInvite("admin", { email: "owner@zavi.co", expires_at: Date.now() - 1 });
    const res = await h.signup(post("/api/signup", { ...creds("stranger@b.co"), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite");
  });

  it("signup with no usable SESSION_SECRET leaves no half-made account, so the retry succeeds", async () => {
    const real = h.session.createSession;
    h.session.createSession = () => {
      throw new Error("SESSION_SECRET is not set");
    };
    const failed = await h.signup(post("/api/signup", creds()));
    expect(errorOf(failed)).toBe("server");
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect(h.users).toHaveLength(0);
    const again = await h.signup(post("/api/signup", creds()));
    expect(errorOf(again)).toBe("server");
    h.session.createSession = real;
    const ok = await h.signup(post("/api/signup", creds()));
    expect(ok.headers.get("location")).toBe("/dashboard");
    expect(ok.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users).toHaveLength(1);
  });

  it("signup keeps the account and session when redeeming THROWS (db fault mid-redeem)", async () => {
    const tok = h.addInvite("admin");
    h.state.failUserRoleUpdate = true;
    const res = await h.signup(post("/api/signup", { ...creds(), invite: tok }));
    expect(res.headers.get("location")).toBe("/dashboard?error=invite");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users).toHaveLength(1);
    expect(h.invites[0].used_at).toBeNull();
  });

  it("login with an invite: the existing account is promoted after the password checks out", async () => {
    await h.signup(post("/api/signup", creds()));
    const tok = h.addInvite("admin");
    const wrong = await h.login(post("/api/login", { email: "a@b.co", password: "nope-nope", invite: tok }));
    expect(errorOf(wrong)).toBe("invalid");
    expect(h.users[0].role).toBe("user");
    expect(h.invites[0].used_at).toBeNull();
    expect(new URLSearchParams((wrong.headers.get("location") ?? "").split("?")[1]).get("invite")).toBe(tok);
    const ok = await h.login(post("/api/login", { ...creds(), invite: tok }));
    expect(ok.headers.get("location")).toBe("/dashboard");
    expect(ok.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users[0].role).toBe("admin");
    const again = await h.login(post("/api/login", { ...creds(), invite: tok }));
    expect(again.headers.get("location")).toBe("/dashboard?error=invite");
    expect(again.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
  });

  it("a malformed invite is never carried onto a redirect URL", async () => {
    const res = await h.login(post("/api/login", { email: "a@b.co", password: "", invite: "<b>hi</b> call 555-0100" }));
    expect(res.headers.get("location")).toBe("/login?error=invalid");
  });

  it("authErrorMessage maps codes to fixed copy and NEVER reflects other text", () => {
    const msg = h.auth.authErrorMessage as (c: unknown) => string | null;
    expect(msg("invite")).toBe("This invite link has expired or was already used. Ask the site owner for a new one.");
    expect(msg("invalid")).toBe("Invalid email or password.");
    for (const bad of ["Your account is locked, call 555-0100", "<script>x</script>", "__proto__", "constructor", "toString", "", undefined, ["invite"]]) {
      expect(msg(bad)).toBeNull();
    }
  });

  it("every error a route can redirect with is a known code", () => {
    const codes = new Set<string>();
    for (const f of ["auth-signup-route.ts.template", "auth-login-route.ts.template", "auth-magic-route.ts.template"]) {
      for (const m of readBlessedTemplate(f).matchAll(/redirectWithError\([A-Z_]+, "([a-z_]+)"/g)) codes.add(m[1]);
    }
    expect(codes.size).toBeGreaterThan(3);
    const msg = h.auth.authErrorMessage as (c: string) => string | null;
    for (const c of codes) expect(msg(c), c).not.toBeNull();
  });
});

describe("auth templates — owner magic-link login (DEL-1323 B3, Q9)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  withFakeDatabaseUrl();

  const open = (token: string | null, extra: Record<string, string> = {}) =>
    h.magicPage(
      new Request(`http://localhost:10000/api/auth/magic${token === null ? "" : `?token=${encodeURIComponent(token)}`}`, {
        headers: { "x-forwarded-for": "10.0.0.1, 1.2.3.4", "sec-fetch-site": "cross-site", host: "shop.example.com", ...extra },
      }),
    );
  const click = (token: string | null, ip = "1.2.3.4", extra: Record<string, string> = {}) =>
    h.magic(post("/api/auth/magic", token === null ? {} : { token }, ip, { "sec-fetch-site": "same-origin", ...extra }));
  const ownerInvite = (opts: Partial<FakeInvite> = {}) => h.addInvite("admin", { email: "owner@zavi.co", ...opts });

  it("opening the link (a mail scanner or the owner) only shows a confirm button and never uses the token", async () => {
    const tok = ownerInvite();
    for (let i = 0; i < 2; i++) {
      const page = await open(tok);
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
      expect(page.headers.get("referrer-policy")).toBe("strict-origin");
      const html = await page.text();
      expect(html).toContain('<form method="post" action="/api/auth/magic"');
      expect(html).toContain(`<input type="hidden" name="token" value="${tok}">`);
      expect(html).toContain("Log in to shop.example.com admin</button>");
    }
    expect(h.state.queries).toBe(0);
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
    expect(h.users).toEqual([]);
    const res = await click(tok);
    expect(res.headers.get("location")).toBe("/admin");
    expect(h.users[0]).toMatchObject({ email: "owner@zavi.co", role: "admin" });
    expect((await click(tok)).headers.get("location")).toBe("/login?error=magic");
    expect(h.users).toHaveLength(1);
  });

  it("the confirm page escapes a hostile Host header and refuses a malformed token without rendering it", async () => {
    const tok = ownerInvite();
    const html = await (await open(tok, { "x-forwarded-host": '"><script>alert(1)</script>' })).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#34;&#62;&#60;script&#62;");
    for (const bad of [null, "", "short", '"><img src=x onerror=alert(1)>aaaaaaaaaaaaa']) {
      const res = await open(bad);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login?error=magic");
    }
  });

  it("a cross-site POST (a forged form) is refused and does not use the token", async () => {
    const tok = ownerInvite();
    const res = await click(tok, "1.2.3.4", { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(h.invites[0].used_at).toBeNull();
    expect(h.users).toEqual([]);
  });

  it("a fresh owner link creates the owner as admin, signs them in and lands on /admin", async () => {
    const tok = ownerInvite({ email: "Owner@Zavi.co" });
    const res = await click(tok);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
    expect(h.users).toHaveLength(1);
    expect(h.users[0]).toMatchObject({ id: 1, email: "owner@zavi.co", role: "admin" });
    expect(h.users[0].password_hash).toMatch(/^h:[A-Za-z0-9_-]{43}$/);
    expect(h.invites[0].used_by).toBe(1);
    expect(h.invites[0].used_at).not.toBeNull();
    expect(h.audit).toEqual([{ event: "magic_login", target_user_id: 1, detail: { role: "admin" } }]);
    expect(h.state.txLog).toEqual(["BEGIN", "COMMIT"]);
    h.cookieJar.session = "tok.1";
    const admin = await (h.auth.requireAdminPage as () => Promise<{ id: number; role: string }>)();
    expect(admin).toMatchObject({ id: 1, role: "admin" });
  });

  it("the passwordless owner row cannot be logged into with a guessed password", async () => {
    await click(ownerInvite());
    const pw = h.users[0].password_hash.slice(2);
    for (const guess of ["", "password", "h:", "owner@zavi.co"]) {
      const res = await h.login(post("/api/login", { email: "owner@zavi.co", password: guess || "x" }, `9.9.9.${guess.length}`));
      expect(errorOf(res)).toBe("invalid");
    }
    expect(pw.length).toBe(43);
  });

  it("an account someone else signed up with the owner's email is never promoted: the link makes a fresh owner account", async () => {
    const squat = await h.signup(post("/api/signup", { email: "owner@zavi.co", password: "attacker-pw" }));
    const squatCookie = squat.headers.get("set-cookie");
    expect(squatCookie).toMatch(/^session=tok\.1;/);
    const res = await click(ownerInvite({ email: "OWNER@zavi.co" }));
    expect(res.headers.get("location")).toBe("/admin");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.2;/);
    expect(h.users).toHaveLength(2);
    expect(h.users[0]).toMatchObject({ id: 1, role: "user", password_hash: "h:attacker-pw" });
    expect(h.users[0].email).not.toBe("owner@zavi.co");
    expect(h.users[1]).toMatchObject({ id: 2, email: "owner@zavi.co", role: "admin" });
    expect(h.users[1].password_hash).not.toBe("h:attacker-pw");
    const relogin = await h.login(post("/api/login", { email: "owner@zavi.co", password: "attacker-pw" }));
    expect(relogin.headers.get("location")).not.toBe("/dashboard");
    expect(h.users.filter((u) => u.role === "admin").map((u) => u.id)).toEqual([2]);
  });

  it("an owner who is already the site admin is signed into that same account", async () => {
    await h.signup(post("/api/signup", { email: "owner@zavi.co", password: "password-1" }));
    h.users[0].role = "admin";
    const res = await click(ownerInvite({ email: "OWNER@zavi.co" }));
    expect(res.headers.get("location")).toBe("/admin");
    expect(res.headers.get("set-cookie")).toMatch(/^session=tok\.1;/);
    expect(h.users).toHaveLength(1);
    expect(h.users[0]).toMatchObject({ email: "owner@zavi.co", role: "admin", password_hash: "h:password-1" });
  });

  it("the link works once: a second click is refused with a friendly error and no session", async () => {
    const tok = ownerInvite();
    expect((await click(tok)).headers.get("location")).toBe("/admin");
    const again = await click(tok);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/login?error=magic");
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(h.users).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
  });

  it("two clicks racing on the same link sign in exactly once", async () => {
    const tok = ownerInvite();
    const [a, b] = await Promise.all([click(tok, "1.1.1.1"), click(tok, "2.2.2.2")]);
    const locations = [a, b].map((r) => r.headers.get("location")).sort();
    expect(locations).toEqual(["/admin", "/login?error=magic"]);
    expect([a, b].filter((r) => r.headers.get("set-cookie"))).toHaveLength(1);
    expect(h.users).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
  });

  it("an expired link is refused and creates nothing", async () => {
    const tok = ownerInvite({ expires_at: Date.now() - 1 });
    const res = await click(tok);
    expect(res.headers.get("location")).toBe("/login?error=magic");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.users).toEqual([]);
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
  });

  it("a link still revoked because the email never went out is refused", async () => {
    const res = await click(ownerInvite({ revoked_at: Date.now() }));
    expect(res.headers.get("location")).toBe("/login?error=magic");
    expect(h.users).toEqual([]);
  });

  it("a link minted for another site is refused here", async () => {
    const other = makeHarness();
    const tok = other.addInvite("admin", { email: "owner@zavi.co" });
    ownerInvite();
    const res = await click(tok);
    expect(res.headers.get("location")).toBe("/login?error=magic");
    expect(h.users).toEqual([]);
    expect(h.invites[0].used_at).toBeNull();
  });

  it("an invite not bound to an email (a Users-tab link) never logs anyone in, and still works on sign-up", async () => {
    const tok = h.addInvite("admin");
    const res = await click(tok);
    expect(res.headers.get("location")).toBe("/login?error=magic");
    expect(h.users).toEqual([]);
    expect(h.invites[0].used_at).toBeNull();
    const signed = await h.signup(post("/api/signup", { email: "a@b.co", password: "password-1", invite: tok }));
    expect(signed.headers.get("location")).toBe("/dashboard");
    expect(h.users[0].role).toBe("admin");
  });

  it("no usable SESSION_SECRET: an honest error, and the link is NOT used up, so it works once fixed", async () => {
    const tok = ownerInvite();
    const real = h.session.createSession;
    h.session.createSession = () => {
      throw new Error("SESSION_SECRET is not set");
    };
    const failed = await click(tok);
    expect(failed.status).toBe(303);
    expect(failed.headers.get("location")).toBe("/login?error=session");
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect(h.invites[0]).toMatchObject({ used_at: null, used_by: null });
    expect(h.users).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.state.txLog).toEqual(["BEGIN", "ROLLBACK"]);
    expect((h.auth.authErrorMessage as (c: string) => string | null)("session")).toMatch(/isn't set up/);
    h.session.createSession = real;
    const ok = await click(tok);
    expect(ok.headers.get("location")).toBe("/admin");
    expect(h.users[0]).toMatchObject({ email: "owner@zavi.co", role: "admin" });
  });

  it("a missing, malformed or oversized token is refused before any query", async () => {
    for (const bad of [null, "", "short", "x".repeat(129), "has space in it but is long enough", "<script>alert(1)</script>xxxxxxxx"]) {
      const res = await click(bad);
      expect(res.headers.get("location")).toBe("/login?error=magic");
    }
    expect(h.state.queries).toBe(0);
  });

  it("a site whose invites table predates the email column refuses the link without touching invites", async () => {
    h.state.inviteEmailColumn = false;
    const tok = h.addInvite("admin");
    const res = await click(tok);
    expect(res.headers.get("location")).toBe("/login?error=magic");
    expect(h.invites[0].used_at).toBeNull();
    expect(h.users).toEqual([]);
  });

  it("the database down: a friendly error redirect, never a 500", async () => {
    const tok = ownerInvite();
    h.state.dbDown = true;
    const err = console.error;
    console.error = () => undefined;
    const res = await click(tok);
    console.error = err;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?error=server");
  });

  it("is throttled per IP before the database is touched", async () => {
    for (let i = 0; i < 30; i++) await click("x");
    const res = await click(ownerInvite());
    expect(res.headers.get("location")).toBe("/login?error=too_many");
    expect(h.users).toEqual([]);
  });

  it("every error code the route can land on has fixed copy", () => {
    const msg = h.auth.authErrorMessage as (c: string) => string | null;
    for (const c of ["magic", "session", "server", "too_many"]) expect(msg(c), c).not.toBeNull();
  });
});

describe("lib/db.ts template — withTransaction on ONE client", () => {
  withFakeDatabaseUrl();

  it("commits on success, rolls back and rethrows on failure, always releases", async () => {
    const h = makeHarness();
    const withTransaction = h.db.withTransaction as <T>(fn: (c: { query: (t: string) => Promise<unknown> }) => Promise<T>) => Promise<T>;
    expect(await withTransaction(async () => 42)).toBe(42);
    await expect(withTransaction(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(h.state.txLog).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
    expect(h.state.released).toBe(2);
  });
});

describe("migrate.mjs template — roles schema for new sites", () => {
  const migrate = readBlessedTemplate("migrate.mjs.template");

  it("creates the app_role enum idempotently, users.role default user, invites and _zavi_audit", () => {
    expect(migrate).toMatch(/DO \$\$ BEGIN CREATE TYPE public\.app_role AS ENUM \('user', 'admin'\);\s*EXCEPTION WHEN duplicate_object THEN NULL; END \$\$/);
    expect(migrate).toMatch(/role public\.app_role NOT NULL DEFAULT 'user'/);
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS invites \([\s\S]*token_hash TEXT UNIQUE NOT NULL,[\s\S]*role public\.app_role NOT NULL,[\s\S]*expires_at TIMESTAMPTZ NOT NULL,[\s\S]*used_by BIGINT REFERENCES users\(id\),[\s\S]*revoked_at TIMESTAMPTZ/);
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS _zavi_audit \([\s\S]*event TEXT NOT NULL,[\s\S]*actor_user_id BIGINT,[\s\S]*target_user_id BIGINT,[\s\S]*detail JSONB/);
  });
});
