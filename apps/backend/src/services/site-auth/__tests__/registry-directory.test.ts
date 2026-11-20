
import { describe, expect, it } from "vitest";
import { createRegistryDirectory, siteDisplayName, type DirectorySiteRow } from "../directory";
import { renderSiteAuthMail } from "../templates";
import { createSiteAuthHandler } from "@/routes/public/site-auth";
import { renderHostRecord } from "@/services/sites/host-record";
import type { SiteRow } from "@/services/sites/contract";
import type { ShardRow } from "@/services/site-shards/contract";
import { handle as gatewayHandle } from "../../../../../../infra/site-gateway/src/worker";
import { ALIAS_KEY, SITE_A, world } from "./fakes";

const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const SHARD_UUID = "5a5a5a5a-0000-4000-8000-00000000005a";
const HOST = "a-shop.zaviagent.com";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const SECRET = "g".repeat(40);

function shardRow(over: Partial<ShardRow> = {}): ShardRow {
  return {
    id: SHARD_UUID, env: "dev", name: "zavi-shard-dev-1", project_ref: REF, url: `https://${REF}.supabase.co`,
    region: "us-west-1", state: "open", is_canary: false, schema_version: "1002_broker", provision_step: "done",
    max_sites: 2000, site_count: 1, created_at: "2026-10-01T00:00:00Z", ...over,
  };
}
const siteRow = (over: Partial<DirectorySiteRow> = {}): DirectorySiteRow => ({
  id: SITE_A, hostname: HOST, label: "a-shop", name: "A Shop", status: "live", shard_id: SHARD_UUID, backend_mode: "pooled", ...over,
});

function setup(o: { rows?: ShardRow[]; site?: DirectorySiteRow | null; now?: () => number } = {}) {
  const w = world({ now: o.now ?? (() => NOW) });
  let listCalls = 0;
  let made = 0;
  const cfg = { url: `https://${REF}.supabase.co`, anonKey: "anon", serviceKey: "svc", dbUrl: "postgres://x", hookSecret: w.shard.hookSecret };
  const dir = createRegistryDirectory({
    readSite: async (id) => (id === SITE_A ? (o.site === undefined ? siteRow() : o.site) : null),
    listShards: async () => (listCalls++, o.rows ?? [shardRow()]),
    resolveConfig: async (id) => (id === SHARD_UUID ? cfg : null),
    makeHandle: (ref) => (made++, { ...w.shard, shardId: ref }),
    now: o.now ?? (() => NOW),
  });
  return { w, dir, calls: () => ({ listCalls, made }) };
}

describe("registry-backed directory: the shard id is the project ref", () => {
  it("site() names the shard by its project ref; shard(ref) resolves it; the registry uuid resolves nothing", async () => {
    const { dir } = setup();
    expect(await dir.site(SITE_A)).toEqual({ siteId: SITE_A, shardId: REF, hostname: HOST, name: "A Shop", active: true });
    expect((await dir.shard(REF))?.shardId).toBe(REF);
    expect(await dir.shard(SHARD_UUID)).toBeNull();
  });

  it("mail names the site by its founder-given name, never the hostname label; the hostname only when it has none", async () => {
    const named = await setup({ site: siteRow({ label: "bubbles-bows-dog-spa-f0a31770-e864e7", name: "Bubbles & Bows" }) }).dir.site(SITE_A);
    expect(named?.name).toBe("Bubbles & Bows");
    const mail = renderSiteAuthMail({ site: named!, to: "a@example.com", kind: "verify_signup", link: `https://${HOST}/x` });
    expect(mail.subject).toBe("Confirm your email for Bubbles & Bows");
    expect(mail.subject).not.toContain("e864e7");
    expect(mail.html).toContain("Bubbles &amp; Bows");
    for (const name of [null, undefined, "", "   ", "\n\t"]) {
      expect((await setup({ site: siteRow({ label: "a-shop", name }) }).dir.site(SITE_A))?.name).toBe(HOST);
    }
    expect(siteDisplayName({ name: "Evil\r\nBcc: x@y.z", hostname: HOST })).toBe("Evil Bcc: x@y.z");
  });

  it("[malicious] fails closed: non-pooled / unplaced site, retired shard, url not https://<ref>.supabase.co, unknown ref", async () => {
    expect(await setup({ site: siteRow({ backend_mode: "dedicated" }) }).dir.site(SITE_A)).toBeNull();
    expect(await setup({ site: siteRow({ backend_mode: "dedicated", shard_id: null, kernel_shard_id: "6b6b6b6b-0000-4000-8000-00000000006b" }) }).dir.site(SITE_A)).toBeNull();
    expect(await setup({ site: siteRow({ backend_mode: "supabase", shard_id: SHARD_UUID }) }).dir.site(SITE_A)).toBeNull();
    expect(await setup({ site: siteRow({ shard_id: null }) }).dir.site(SITE_A)).toBeNull();
    expect(await setup({ rows: [shardRow({ state: "retired" })] }).dir.site(SITE_A)).toBeNull();
    expect(await setup({ rows: [shardRow({ state: "retired" })] }).dir.shard(REF)).toBeNull();
    expect(await setup({ rows: [shardRow({ url: "https://evil.example.com" })] }).dir.shard(REF)).toBeNull();
    expect(await setup().dir.shard(OTHER_REF)).toBeNull();
    expect(await setup().dir.shard("../x")).toBeNull();
    expect(await setup().dir.site("not-a-uuid")).toBeNull();
  });

  it("a graduated site (dedicated + kernel_shard_id) resolves to its one-site kernel shard; sign-in works there", async () => {
    const KREF = "kernelkernelkernel01";
    const KID = "6b6b6b6b-0000-4000-8000-00000000006b";
    const s = setup({
      site: siteRow({ backend_mode: "dedicated", shard_id: null, kernel_shard_id: KID }),
      rows: [shardRow(), shardRow({ id: KID, project_ref: KREF, url: `https://${KREF}.supabase.co`, state: "full", max_sites: 1 })],
    });
    expect(await s.dir.site(SITE_A)).toMatchObject({ siteId: SITE_A, shardId: KREF, active: true });
    const w = s.w;
    const kshard = { ...w.shard, shardId: KREF };
    const directory = { site: s.dir.site, shard: async (ref: string) => (ref === KREF ? kshard : null) };
    const deps = { ...w.deps, directory, sleep: async () => {} };
    const ctx = { siteId: SITE_A, shardId: KREF, host: HOST, ip: "203.0.113.9", requestId: "r-grad-1" };
    const brokerMod = await import("../broker");
    await brokerMod.signup(deps, ctx, { email: "g@x.com" });
    await w.settle();
    const token = new URL(w.mailer.sent.find((m) => m.kind === "verify_signup")!.link!).searchParams.get("token_hash");
    const c = await brokerMod.confirmSignup(deps, ctx, { type: "signup", token_hash: token });
    await brokerMod.changePassword(deps, ctx, { password: "graduated pw 1" }, `Bearer ${c.session!.access_token}`);
    const login = await brokerMod.login(deps, ctx, { email: "g@x.com", password: "graduated pw 1" });
    expect(login.session.access_token).toBeTruthy();
    await expect(brokerMod.login(deps, { ...ctx, shardId: REF }, { email: "g@x.com", password: "graduated pw 1" })).rejects.toThrow();
  });

  it("an unknown ref (public hook URL path) refreshes the shard list at most once per throttle window; handles are reused", async () => {
    let t = NOW;
    const s = setup({ now: () => t });
    await s.dir.shard(REF);
    for (let i = 0; i < 20; i++) await s.dir.shard(OTHER_REF);
    expect(s.calls().listCalls).toBe(1);
    t += 11_000;
    await s.dir.shard(OTHER_REF);
    expect(s.calls().listCalls).toBe(2);
    t += 6 * 60_000;
    await s.dir.shard(REF);
    expect(s.calls().made).toBe(1);
  });
});

describe("gateway -> broker contract (real gateway signer, real broker route, registry directory)", () => {
  async function throughGateway(o: { kvShardId?: string } = {}) {
    const { w, dir } = setup();
    const deps = { ...w.deps, directory: dir, aliasKey: () => ALIAS_KEY, sleep: async () => {} };
    const broker = createSiteAuthHandler({ broker: () => deps, gatewaySecret: () => SECRET, now: () => NOW });
    const row = {
      id: SITE_A, tenant_id: "t", status: "live", host_version: 3, updated_at: "2026-10-01T00:00:00Z",
      gateway_binding: { shard_id: o.kvShardId ?? REF, shard_url: `https://${o.kvShardId ?? REF}.supabase.co`, status: "active", manifest_hash: "h" },
    } as unknown as SiteRow;
    const kv: Record<string, string> = {
      [`host:${HOST}`]: JSON.stringify(renderHostRecord(row)!.value),
      [`shard:${o.kvShardId ?? REF}`]: JSON.stringify({ apikey: "sb_publishable_x" }),
    };
    const env = {
      HOSTS: { async get(k: string) { return k in kv ? kv[k] : null; } },
      SIGNER: { fetch: async () => new Response("{}", { status: 500 }) },
      RL_READ: { limit: async () => ({ success: true }) }, RL_WRITE: { limit: async () => ({ success: true }) },
      RL_SITE: { limit: async () => ({ success: true }) },
      AUTH_BROKER_URL: "https://api.zaviagent.com/api/public/site-auth",
      BROKER_HMAC_SECRET: SECRET,
      STORAGE_PROXY_SECRET: "x".repeat(32),
    };
    const fetch = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const action = u.pathname.split("/").pop()!;
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
      let status = 200;
      let payload: unknown;
      const res = {
        status(c: number) { status = c; return res; },
        json(b: unknown) { payload = b; return res; },
        setHeader() {},
      };
      await broker({ method: init.method, originalUrl: `/api/public/site-auth/${action}${u.search}`, params: { op: action }, headers, body } as never, res as never);
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    };
    const req = new Request(`https://${HOST}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5", "cf-ray": "8f2b1c3d4e5f6a7b-SJC", origin: `https://${HOST}` },
      body: JSON.stringify({ email: "alice@x.com", password: "correct horse 1" }),
    });
    const out = await gatewayHandle(req, env as never, { now: () => NOW, fetch: fetch as never });
    return { w, status: out.status, body: await out.json() };
  }

  it("a gateway-signed signup is admitted by the broker against the registry directory", async () => {
    const r = await throughGateway();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { status: "check_email" } });
    expect(r.w.store.signups).toMatchObject([{ siteId: SITE_A, email: "alice@x.com", state: "pending" }]);
  });

  it("[malicious] a binding naming another shard than the site's own is refused before any account work", async () => {
    const r = await throughGateway({ kvShardId: OTHER_REF });
    expect(r.status).toBe(401);
    expect(r.w.store.idents).toHaveLength(0);
    expect(r.w.store.signups).toHaveLength(0);
  });
});

describe("publish-gate test sites in the directory", () => {
  it("a row flagged is_test resolves as a test site (mail suppressed); others carry no flag", async () => {
    expect(await setup({ site: siteRow({ is_test: true }) }).dir.site(SITE_A)).toMatchObject({ siteId: SITE_A, test: true });
    expect(await setup().dir.site(SITE_A)).not.toHaveProperty("test");
  });

  it("a test site is served by a 'full' validation shard", async () => {
    expect(await setup({ site: siteRow({ is_test: true }), rows: [shardRow({ state: "full", purpose: "validation" })] }).dir.site(SITE_A)).toMatchObject({ shardId: REF, active: true, test: true });
  });
});
