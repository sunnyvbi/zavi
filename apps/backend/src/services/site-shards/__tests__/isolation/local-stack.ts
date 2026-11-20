import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { importJWK, SignJWT, type JWK } from "jose";
import type { Pool } from "pg";
import type { ShardSql } from "../../contract";
import { applyPendingMigrations, loadShardMigrations } from "../../migrations";
import { SHARD_AUTH_RATE_LIMITS, SHARD_JWT_EXP_SECONDS } from "../../provision";
import { startFront, type Front } from "./front";
import type { ShardTarget } from "./target";

const req = createRequire(__filename);

export interface LocalBins {
  pgbin: string;
  postgrest: string;
  gotrue: string;
}

export function localBins(env: NodeJS.ProcessEnv = process.env): LocalBins {
  return {
    pgbin: env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin",
    postgrest: env.POSTGREST ?? "",
    gotrue: env.GOTRUE ?? "",
  };
}

export function missingBins(b: LocalBins): string[] {
  const out: string[] = [];
  if (!existsSync(join(b.pgbin, "initdb"))) out.push(`PGBIN (${b.pgbin}/initdb)`);
  if (!b.postgrest || !existsSync(b.postgrest)) out.push("POSTGREST");
  if (!b.gotrue || !existsSync(b.gotrue)) out.push("GOTRUE");
  return out;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => Promise<boolean>, logPath: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await sleep(200);
  }
  let tail = "";
  try {
    tail = readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n");
  } catch {
  }
  throw new Error(`${what} did not become ready in ${timeoutMs}ms\n${tail}`);
}

function es256(kid: string, ops: string[]): { priv: JWK; pub: JWK } {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const priv = { ...(k.privateKey.export({ format: "jwk" }) as JWK), kid, alg: "ES256", use: "sig", key_ops: ops };
  const pub = { ...(k.publicKey.export({ format: "jwk" }) as JWK), kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
  return { priv, pub };
}

async function apiKey(priv: JWK, role: string): Promise<string> {
  const key = await importJWK(priv, "ES256");
  return new SignJWT({ role, iss: "supabase" })
    .setProtectedHeader({ alg: "ES256", kid: String(priv.kid), typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10y")
    .sign(key);
}

export interface LocalShard extends ShardTarget {
  pool: Pool;
  stop(): Promise<void>;
}

export interface LocalShardOpts {
  ref: string;
  kind: ShardTarget["kind"];
  bins: LocalBins;
  hookBase: string;
  shardSqlDir: string;
  log?: (m: string) => void;
}

export async function startLocalShard(o: LocalShardOpts): Promise<LocalShard> {
  const dir = mkdtempSync(join(tmpdir(), `zsi-${o.kind}-`));
  const children: ChildProcess[] = [];
  let front: Front | null = null;
  let pool: Pool | null = null;
  const [pgPort, authPort, restPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const pw = randomBytes(18).toString("hex");
  const authKey = es256(`auth-${o.ref}`, ["verify"]);
  const signerKey = es256(`zavi-gw-${o.ref}`, ["sign", "verify"]);
  const anonKey = await apiKey(signerKey.priv, "anon");
  const serviceKey = await apiKey(signerKey.priv, "service_role");
  const hookSecret = `v1,whsec_${randomBytes(32).toString("base64")}`;
  const pg = (args: string[]) => execFileSync(join(o.bins.pgbin, args[0]), args.slice(1), { stdio: "ignore" });

  const stop = async () => {
    await front?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    for (const c of children) {
      if (c.exitCode === null) c.kill("SIGTERM");
    }
    await sleep(200);
    for (const c of children) {
      if (c.exitCode === null) c.kill("SIGKILL");
    }
    try {
      pg(["pg_ctl", "-D", join(dir, "data"), "-m", "immediate", "stop"]);
    } catch {
    }
    if (process.env.ZSI_KEEP_LOGS) o.log?.(`[zsi] ${o.kind} logs kept at ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", () => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    try {
      execFileSync(join(o.bins.pgbin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {
    }
  });

  try {
    pg(["initdb", "-D", join(dir, "data"), "-U", "postgres", "-A", "trust"]);
    execFileSync(join(o.bins.pgbin, "pg_ctl"), [
      "-D", join(dir, "data"), "-l", join(dir, "pg.log"), "-w", "-o",
      `-p ${pgPort} -k ${dir} -c listen_addresses=127.0.0.1 -c max_connections=120`,
      "start",
    ], { stdio: "ignore" });

    const { Pool: PgPool, Client } = req("pg") as typeof import("pg");
    const su = new Client({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "postgres" });
    await su.connect();
    try {
      await su.query(`
        create role anon nologin noinherit;
        create role authenticated nologin noinherit;
        create role service_role nologin noinherit bypassrls;
        create role authenticator login noinherit password '${pw}';
        grant anon, authenticated, service_role to authenticator;
        create role supabase_auth_admin login noinherit createrole password '${pw}';
        create schema auth authorization supabase_auth_admin;
        grant usage on schema auth to postgres;
        -- Storage's tables (the stand-in in front.ts serves the API; RLS is the shard's 0003).
        create schema storage;
        create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
          file_size_limit bigint, allowed_mime_types text[]);
        create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
          name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
          updated_at timestamptz default now(), unique (bucket_id, name));
        alter table storage.objects enable row level security;
        grant usage on schema storage to anon, authenticated, service_role;
        grant all on storage.objects, storage.buckets to anon, authenticated, service_role;`);
    } finally {
      await su.end();
    }

    const authEnv = {
      ...process.env,
      GOTRUE_API_HOST: "127.0.0.1",
      PORT: String(authPort),
      API_EXTERNAL_URL: `https://${o.ref}.supabase.co/auth/v1`,
      GOTRUE_DB_DRIVER: "postgres",
      DATABASE_URL: `postgres://supabase_auth_admin:${pw}@127.0.0.1:${pgPort}/postgres?sslmode=disable&search_path=auth`,
      GOTRUE_DB_NAMESPACE: "auth",
      GOTRUE_SITE_URL: "https://broker.zsi.invalid",
      GOTRUE_URI_ALLOW_LIST: "https://broker.zsi.invalid/**",
      GOTRUE_JWT_SECRET: randomBytes(32).toString("hex"),
      GOTRUE_JWT_KEYS: JSON.stringify([signerKey.priv, authKey.pub]),
      GOTRUE_JWT_EXP: String(SHARD_JWT_EXP_SECONDS),
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
      GOTRUE_MAILER_AUTOCONFIRM: "false",
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
      GOTRUE_SMTP_MAX_FREQUENCY: "1s",
      GOTRUE_RATE_LIMIT_EMAIL_SENT: String(SHARD_AUTH_RATE_LIMITS.rate_limit_email_sent),
      GOTRUE_RATE_LIMIT_OTP: String(SHARD_AUTH_RATE_LIMITS.rate_limit_otp),
      GOTRUE_RATE_LIMIT_VERIFY: String(SHARD_AUTH_RATE_LIMITS.rate_limit_verify),
      GOTRUE_RATE_LIMIT_TOKEN_REFRESH: String(SHARD_AUTH_RATE_LIMITS.rate_limit_token_refresh),
      GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "true",
      GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI: "pg-functions://postgres/zsite_auth/custom_access_token_hook",
      GOTRUE_HOOK_SEND_EMAIL_ENABLED: "true",
      GOTRUE_HOOK_SEND_EMAIL_URI: `${o.hookBase}/${o.ref}`,
      GOTRUE_HOOK_SEND_EMAIL_SECRETS: hookSecret,
      GOTRUE_LOG_LEVEL: "warn",
    };
    const run = (name: string, bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      const out = createWriteStream(join(dir, `${name}.log`));
      const c = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      c.stdout?.pipe(out);
      c.stderr?.pipe(out);
      children.push(c);
      return c;
    };

    const mig = run("auth-migrate", o.bins.gotrue, ["migrate"], authEnv);
    const code = await new Promise<number | null>((r) => mig.on("exit", r));
    if (code !== 0) throw new Error(`auth migrate exited ${code}: ${readFileSync(join(dir, "auth-migrate.log"), "utf8").slice(-2000)}`);

    pool = new PgPool({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "postgres", max: 8 });
    pool.on("error", () => undefined);
    const sql: ShardSql = {
      async query(_ref, q) {
        const c = await pool!.connect();
        try {
          const r = await c.query(q);
          const all = Array.isArray(r) ? r : [r];
          const last = all.filter((x) => x.rows && x.command === "SELECT").pop() ?? all[all.length - 1];
          return last?.rows ?? [];
        } catch (e) {
          await c.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      },
    };
    const applied = await applyPendingMigrations(sql, o.ref, loadShardMigrations(o.shardSqlDir));
    if (applied.failed) throw new Error(`shard SQL ${applied.failed.version} failed: ${applied.failed.error}`);
    await pool.query(`alter role zsite_broker with login password '${pw}'`);

    run("auth", o.bins.gotrue, ["serve"], authEnv);
    await waitFor("auth", async () => (await fetch(`http://127.0.0.1:${authPort}/health`)).ok, join(dir, "auth.log"));

    const libDirs = [join(o.bins.pgbin, "..", "lib", "postgresql"), join(o.bins.pgbin, "..", "lib")].join(":");
    run("postgrest", o.bins.postgrest, [], {
      ...process.env,
      DYLD_FALLBACK_LIBRARY_PATH: libDirs,
      PGRST_DB_URI: `postgres://authenticator:${pw}@127.0.0.1:${pgPort}/postgres`,
      PGRST_DB_SCHEMAS: "api",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: JSON.stringify({ keys: [authKey.pub, signerKey.pub] }),
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(restPort),
      PGRST_ADMIN_SERVER_PORT: String(adminPort),
      PGRST_LOG_LEVEL: "error",
    });
    await waitFor("postgrest", async () => (await fetch(`http://127.0.0.1:${adminPort}/ready`)).ok, join(dir, "postgrest.log"));

    front = await startFront({
      gotrueUrl: `http://127.0.0.1:${authPort}`,
      postgrestUrl: `http://127.0.0.1:${restPort}`,
      pool,
      jwks: [authKey.pub, signerKey.pub],
      apiKeys: [anonKey, serviceKey],
    });
    o.log?.(`[zsi] shard ${o.kind} ${o.ref} up: pg ${pgPort} auth ${authPort} rest ${restPort} front ${front.url}`);

    return {
      ref: o.ref,
      kind: o.kind,
      publicUrl: `https://${o.ref}.supabase.co`,
      baseUrl: front.url,
      publishableKey: anonKey,
      anonKey,
      serviceKey,
      adminDbUrl: `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
      brokerDbUrl: `postgres://zsite_broker:${pw}@127.0.0.1:${pgPort}/postgres`,
      hookSecret,
      signerJwk: signerKey.priv as unknown as Record<string, unknown>,
      pool,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
