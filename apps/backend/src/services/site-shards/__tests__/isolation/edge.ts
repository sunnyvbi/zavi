import express from "express";
import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createRequire } from "node:module";
import { handle, clearAnonCache, TURNSTILE_VERIFY_URL, type Env, type RateLimitLike } from "../../../../../../../infra/site-gateway/src/worker";
import { clearJwksCache } from "../../../../../../../infra/site-gateway/src/jwt";
import { handleSigner, shardKeySecretName, sealedShardKeyKey, clearUnsealedCache } from "../../../../../../../infra/site-gateway/signer/src/signer";
import { createSiteAuthHandler } from "@/routes/public/site-auth";
import { createSiteAuthHookHandler } from "@/routes/public/site-auth-hook";
import type { BrokerDeps } from "@/services/site-auth/broker";
import { createRegistryDirectory, type DirectorySiteRow } from "@/services/site-auth/directory";
import { createGoTrue } from "@/services/site-auth/gotrue";
import { createShardStore } from "@/services/site-auth/store";
import { createSiteMailer } from "@/services/site-auth/mailer";
import type { SiteAuthDirectory } from "@/services/site-auth/types";
import type { ShardRow } from "../../contract";
import { sealShardKey } from "../../shard-keys";
import { renderHostRecord } from "@/services/sites/host-record";
import type { SiteRow } from "@/services/sites/contract";
import type { ShardTarget } from "./target";

const req = createRequire(__filename);

export const BROKER_BASE = "https://broker.zsi.invalid/api/public/site-auth";

export interface SiteSpec {
  key: string;
  siteId: string;
  hostname: string;
  label: string;
  shard: ShardTarget;
  mode: "pooled" | "dedicated";
}

export interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  siteName: string;
}

export interface CapturedBrokerCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface GwInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  ip?: string;
  url?: string;
}

export function windowLimiter(limit: number, periodMs = 60_000): RateLimitLike & { reset(): void } {
  const w = new Map<string, { n: number; start: number }>();
  return {
    async limit({ key }) {
      const now = Date.now();
      const cur = w.get(key);
      if (!cur || now - cur.start >= periodMs) {
        w.set(key, { n: 1, start: now });
        return { success: true };
      }
      cur.n += 1;
      return { success: cur.n <= limit };
    },
    reset: () => w.clear(),
  };
}

export interface Edge {
  sites: Map<string, SiteSpec>;
  gw(host: string, path: string, init?: GwInit): Promise<Response>;
  direct(shard: ShardTarget, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<Response>;
  brokerDirect(path: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<Response>;
  signer(body: unknown): Promise<Response>;
  env: Env;
  brokerDeps: BrokerDeps;
  directory: SiteAuthDirectory;
  mails: CapturedMail[];
  brokerCalls: CapturedBrokerCall[];
  limiters: { read: ReturnType<typeof windowLimiter>; write: ReturnType<typeof windowLimiter>; site: ReturnType<typeof windowLimiter> };
  logs: string[];
  strayAuthEmails: Set<string>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface BrokerServer {
  url: string;
  hookBase: string;
  bind(handler: express.RequestHandler, hook: express.RequestHandler): void;
  close(): Promise<void>;
}

export async function startBrokerServer(): Promise<BrokerServer> {
  let route: express.RequestHandler = (_q, r) => void r.status(503).json({ error: "not bound" });
  let hook: express.RequestHandler = (_q, r) => void r.status(503).json({ error: "not bound" });
  const app = express();
  app.set("trust proxy", 1);
  app.post("/api/public/site-auth/hooks/send-email/:shardId", express.raw({ type: () => true, limit: "64kb" }), (q, r, n) => hook(q, r, n));
  app.post("/api/public/site-auth/:op", express.raw({ type: () => true, limit: "16kb" }), (q, r, n) => route(q, r, n));
  app.get("/api/public/site-auth/:op", (q, r, n) => route(q, r, n));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hookBase: `http://127.0.0.1:${port}/api/public/site-auth/hooks/send-email`,
    bind(h, k) {
      route = h;
      hook = k;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function headerRecord(h: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
}

export async function startEdge(o: {
  broker: BrokerServer;
  sites: SiteSpec[];
  turnstile?: boolean;
}): Promise<Edge> {
  clearAnonCache();
  clearJwksCache();
  clearUnsealedCache();
  const shards = new Map<string, ShardTarget>();
  for (const s of o.sites) shards.set(s.shard.ref, s.shard);
  const sites = new Map(o.sites.map((s) => [s.key, s] as const));
  const mails: CapturedMail[] = [];
  const brokerCalls: CapturedBrokerCall[] = [];
  const logs: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const pools: Pool[] = [];
  const brokerSecret = randomBytes(32).toString("hex");
  const aliasKey = randomBytes(32).toString("hex");
  const turnstileSecret = "zsi-platform-turnstile-secret";

  const kv = new Map<string, string>();
  for (const s of o.sites) {
    const rendered = renderHostRecord({
      id: s.siteId,
      tenant_id: randomUUID(),
      status: "live",
      host_version: 1,
      updated_at: new Date().toISOString(),
      gateway_binding: { shard_id: s.shard.ref, shard_url: s.shard.publicUrl, status: "active", manifest_hash: "zsi" },
      gateway_config: null,
    } as unknown as SiteRow);
    if (!rendered) throw new Error(`host record for ${s.key} did not render`);
    kv.set(`host:${s.hostname}`, JSON.stringify(rendered.value));
  }
  for (const sh of shards.values()) kv.set(`shard:${sh.ref}`, JSON.stringify({ apikey: sh.publishableKey }));

  const kek = (() => {
    const { generateKeyPairSync } = req("node:crypto") as typeof import("node:crypto");
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return {
      priv: { ...(k.privateKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "zsi-kek-1" },
      pub: { ...(k.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "zsi-kek-1" },
    };
  })();
  const signerEnv: Record<string, unknown> = { SITE_SIGNER_KEK: JSON.stringify(kek.priv) };
  for (const sh of shards.values()) {
    if (sh.kind === "kernel") kv.set(sealedShardKeyKey(sh.ref), JSON.stringify(sealShardKey(kek.pub, sh.ref, sh.signerJwk)));
    else signerEnv[shardKeySecretName(sh.ref)] = JSON.stringify(sh.signerJwk);
  }
  const kvReader = { async get(key: string) { return kv.get(key) ?? null; } };
  signerEnv.HOSTS = kvReader;
  const signer = (r: Request) => handleSigner(r, signerEnv);

  const brokerOrigin = new URL(BROKER_BASE).origin;
  const realFetch = globalThis.fetch;
  const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === TURNSTILE_VERIFY_URL) {
      const form = init?.body instanceof FormData ? init.body : null;
      const secret = form?.get("secret");
      const token = String(form?.get("response") ?? "");
      const m = /^zsi-turnstile:([a-z0-9.-]+)$/.exec(token);
      const ok = secret === turnstileSecret && !!m;
      return new Response(JSON.stringify({ success: ok, hostname: m?.[1] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${brokerOrigin}/`)) {
      const body = await bodyBytes(init?.body);
      const call = { url, method: init?.method ?? "GET", headers: headerRecord(init?.headers), body };
      brokerCalls.push(call);
      return realFetch(o.broker.url + url.slice(brokerOrigin.length), {
        method: call.method, headers: call.headers, body: call.method === "GET" ? undefined : body, redirect: "manual",
      });
    }
    for (const sh of shards.values()) {
      if (url === sh.publicUrl || url.startsWith(`${sh.publicUrl}/`)) {
        return realFetch(sh.baseUrl + url.slice(sh.publicUrl.length), init);
      }
    }
    throw new Error(`zsi: unexpected egress to ${url.slice(0, 80)}`);
  };

  const limiters = { read: windowLimiter(300), write: windowLimiter(30), site: windowLimiter(3000) };
  const env: Env = {
    HOSTS: kvReader as Env["HOSTS"],
    SIGNER: { fetch: signer },
    RL_READ: limiters.read,
    RL_WRITE: limiters.write,
    RL_SITE: limiters.site,
    AUTH_BROKER_URL: BROKER_BASE,
    BROKER_HMAC_SECRET: brokerSecret,
    STORAGE_PROXY_SECRET: randomBytes(32).toString("hex"),
    ...(o.turnstile === false ? {} : { TURNSTILE_SECRET: turnstileSecret, TURNSTILE_SITE_KEY: "0x4AAAAAAAzsiPlatformKey" }),
  };

  const regId = (ref: string) => `00000000-0000-4000-8000-${Buffer.from(ref).toString("hex").slice(0, 12)}`;
  const shardRows: ShardRow[] = [...shards.values()].map((sh) => ({
    id: regId(sh.ref), env: "dev", name: `zsi-${sh.kind}`, project_ref: sh.ref, url: sh.publicUrl, region: "local",
    state: "open", is_canary: false, schema_version: null, provision_step: "done", max_sites: 1000, site_count: 0,
    created_at: new Date().toISOString(), dedicated_site_id: null,
  }) as unknown as ShardRow);
  const siteRows = new Map<string, DirectorySiteRow>(o.sites.map((s) => [s.siteId, {
    id: s.siteId, hostname: s.hostname, label: s.label, status: "live",
    shard_id: s.mode === "pooled" ? regId(s.shard.ref) : null,
    backend_mode: s.mode,
    kernel_shard_id: s.mode === "dedicated" ? regId(s.shard.ref) : null,
  }]));
  const { Pool: PgPool } = req("pg") as typeof import("pg");
  const directory = createRegistryDirectory({
    readSite: async (id) => siteRows.get(id) ?? null,
    listShards: async () => shardRows,
    resolveConfig: async (id) => {
      const sh = [...shards.values()].find((x) => regId(x.ref) === id);
      return sh ? { url: sh.publicUrl, anonKey: sh.anonKey, serviceKey: sh.serviceKey, dbUrl: sh.brokerDbUrl, hookSecret: sh.hookSecret } : null;
    },
    makeHandle: (ref, cfg) => {
      const sh = shards.get(ref)!;
      const pool = new PgPool({ connectionString: cfg.dbUrl, max: 4, idleTimeoutMillis: 5_000, statement_timeout: 10_000 });
      pool.on("error", () => undefined);
      pools.push(pool);
      return {
        shardId: ref,
        gotrue: createGoTrue({ url: sh.baseUrl, anonKey: cfg.anonKey, serviceKey: cfg.serviceKey }),
        store: createShardStore(async (sql, params) => (await pool.query(sql, params)).rows),
        hookSecret: cfg.hookSecret,
      };
    },
    now: () => Date.now(),
  });
  const mailer = createSiteMailer(async (to, subject, html, text, from) => {
    mails.push({ to, subject, html, text, siteName: from.name });
  });
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const brokerDeps: BrokerDeps = {
    directory,
    mailer,
    aliasKey: () => aliasKey,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    background: track,
    schedule: () => undefined,
    fetch: route as typeof fetch,
    turnstileSecret: async () => null,
    log: (m) => logs.push(m),
  };
  o.broker.bind(
    createSiteAuthHandler({ broker: () => brokerDeps, gatewaySecret: () => brokerSecret, now: () => Date.now(), log: (m) => logs.push(m) }) as express.RequestHandler,
    createSiteAuthHookHandler(() => ({ directory, mailer, now: () => Date.now(), log: (m) => logs.push(m) })) as express.RequestHandler,
  );

  return {
    sites,
    env,
    brokerDeps,
    directory,
    mails,
    brokerCalls,
    limiters,
    logs,
    strayAuthEmails: new Set<string>(),
    async gw(host, path, init = {}) {
      const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "198.51.100.7", ...(init.headers ?? {}) };
      const request = new Request(init.url ?? `https://${host}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body),
      });
      return handle(request, env, { fetch: route as typeof fetch });
    },
    async direct(shard, path, init = {}) {
      return realFetch(shard.baseUrl + path, {
        method: init.method ?? "GET",
        headers: { apikey: shard.publishableKey, ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body),
        redirect: "manual",
      });
    },
    async brokerDirect(path, init) {
      return realFetch(o.broker.url + new URL(BROKER_BASE).pathname + path, {
        method: init.method, headers: init.headers, body: init.method === "GET" ? undefined : init.body ? Buffer.from(init.body) : undefined, redirect: "manual",
      });
    },
    async signer(body) {
      return signer(new Request("https://signer.internal/mint-anon", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    },
    async settle() {
      for (let i = 0; i < 50 && pending.size; i++) await Promise.allSettled([...pending]);
    },
    async close() {
      await Promise.allSettled([...pending]);
      for (const p of pools) await p.end().catch(() => undefined);
    },
  };
}
