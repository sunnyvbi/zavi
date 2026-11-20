import { describe, expect, it, vi } from "vitest";
import {
  convergePlatformWorkerSecrets,
  secretFingerprint,
  workerEnvRefusal,
  type FingerprintStore,
} from "../platform-worker-secrets";

const ACC = "acc123";
const TOKEN = "tok-abc-0123456789";
const PREVIEW = "p".repeat(40);
const BROKER = "b".repeat(40);

const baseEnv = (extra: Record<string, string | undefined> = {}) => ({
  CLOUDFLARE_ACCOUNT_ID: ACC,
  CLOUDFLARE_WFP_API_TOKEN: TOKEN,
  ZAVI_STATIC_WORKER_NAME: "zavi-static-host",
  ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway",
  SITE_PREVIEW_HMAC_SECRET: PREVIEW,
  SITE_GATEWAY_BROKER_SECRET: BROKER,
  ...extra,
});

function fakeCf(scripts: Record<string, Record<string, string>>, opts: { failPut?: string; failList?: string } = {}) {
  const puts: Array<{ worker: string; name: string; text: string }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/.exec(url);
    if (!m) throw new Error(`unexpected url ${url}`);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const worker = decodeURIComponent(m[2]);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (!(worker in scripts)) return json(404, { success: false, errors: [{ code: 10007, message: "workers.api.error.script_not_found" }] });
    if (init?.method === "GET") {
      if (opts.failList === worker) return json(500, { success: false, errors: [{ code: 10013, message: "internal" }] });
      return json(200, { success: true, result: Object.keys(scripts[worker]).map((name) => ({ name, type: "secret_text" })) });
    }
    const body = JSON.parse(String(init?.body)) as { name: string; text: string; type: string };
    expect(body.type).toBe("secret_text");
    if (opts.failPut === `${worker}/${body.name}`) return json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    scripts[worker][body.name] = body.text;
    puts.push({ worker, name: body.name, text: body.text });
    return json(200, { success: true, result: { name: body.name, type: "secret_text" } });
  });
  return { f: f as unknown as typeof fetch, puts };
}

function memStore(): FingerprintStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async load(acc) {
      const m = new Map<string, string>();
      for (const [k, v] of rows) {
        const [a, w, s] = k.split("|");
        if (a === acc) m.set(`${w}\u0000${s}`, v);
      }
      return m;
    },
    async save(acc, w, s, fp) {
      rows.set(`${acc}|${w}|${s}`, fp);
    },
  };
}

const quiet = () => {};

describe("convergePlatformWorkerSecrets", () => {
  it("writes every configured secret on first run, then nothing on the next boot", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store = memStore();
    const alert = vi.fn(async () => {});
    const r1 = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, alert, log: quiet });
    expect(r1.skipped).toBeUndefined();
    if (r1.skipped) return;
    expect(r1.ok).toBe(true);
    expect(cf.puts.map((p) => `${p.worker}/${p.name}`).sort()).toEqual([
      "zavi-site-gateway/BROKER_HMAC_SECRET",
      "zavi-site-gateway/PREVIEW_HMAC_SECRET",
      "zavi-static-host/PREVIEW_HMAC_SECRET",
    ]);
    expect(cf.puts.find((p) => p.name === "BROKER_HMAC_SECRET")?.text).toBe(BROKER);
    expect(store.rows.size).toBe(3);
    for (const v of store.rows.values()) {
      expect(v).toMatch(/^[0-9a-f]{64}$/);
      expect(v).not.toContain(PREVIEW);
    }

    const r2 = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, alert, log: quiet });
    if (r2.skipped) throw new Error("skipped");
    expect(r2.counts).toMatchObject({ put: 0, unchanged: 3, errors: 0 });
    expect(cf.puts).toHaveLength(3);
    expect(alert).not.toHaveBeenCalled();
  });

  it("re-writes only the secret whose value rotated", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store = memStore();
    await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    cf.puts.length = 0;
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv({ SITE_GATEWAY_BROKER_SECRET: "c".repeat(40) }), fetch: cf.f, store, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts.map((p) => `${p.worker}/${p.name}`)).toEqual(["zavi-site-gateway/BROKER_HMAC_SECRET"]);
    expect(r.secrets.find((s) => s.secret === "BROKER_HMAC_SECRET")).toMatchObject({ action: "put", reason: "changed" });
  });

  it("re-writes a secret that vanished from the Worker even when the fingerprint matches", async () => {
    const scripts: Record<string, Record<string, string>> = { "zavi-static-host": {}, "zavi-site-gateway": {} };
    const cf = fakeCf(scripts);
    const store = memStore();
    await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    delete scripts["zavi-site-gateway"].PREVIEW_HMAC_SECRET;
    cf.puts.length = 0;
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts.map((p) => `${p.worker}/${p.name}`)).toEqual(["zavi-site-gateway/PREVIEW_HMAC_SECRET"]);
    expect(r.secrets.find((s) => s.action === "put")?.reason).toBe("absent_on_worker");
  });

  it("dry run writes nothing and stores nothing", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store = memStore();
    const r = await convergePlatformWorkerSecrets({ dryRun: true }, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(r.counts.would_put).toBe(3);
    expect(cf.puts).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("force rewrites unchanged secrets", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store = memStore();
    await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    cf.puts.length = 0;
    await convergePlatformWorkerSecrets({ force: true }, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    expect(cf.puts).toHaveLength(3);
  });

  it("a missing Worker is reported and paged, the others still converge, and nothing throws", async () => {
    const cf = fakeCf({ "zavi-static-host": {} });
    const store = memStore();
    const alert = vi.fn(async () => {});
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, alert, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(r.ok).toBe(false);
    expect(r.workers.find((w) => w.worker === "zavi-site-gateway")?.status).toBe("missing_worker");
    expect(cf.puts.map((p) => `${p.worker}/${p.name}`)).toEqual(["zavi-static-host/PREVIEW_HMAC_SECRET"]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0] as unknown[])[0]).toBe("sites.worker_secrets.worker_missing");
    expect(JSON.stringify(alert.mock.calls)).not.toContain(PREVIEW);
    expect(JSON.stringify(alert.mock.calls)).not.toContain(TOKEN);
  });

  it("a failed PUT stores no fingerprint (retried next run) and pages", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} }, { failPut: "zavi-site-gateway/BROKER_HMAC_SECRET" });
    const store = memStore();
    const alert = vi.fn(async () => {});
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, alert, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(r.ok).toBe(false);
    expect([...store.rows.keys()].some((k) => k.endsWith("BROKER_HMAC_SECRET"))).toBe(false);
    expect((alert.mock.calls[0] as unknown[])[0]).toBe("sites.worker_secrets.failed");
  });

  it("refuses to write when the fingerprint store is unreadable (no re-PUT storm)", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store: FingerprintStore = { load: async () => { throw new Error("db down"); }, save: async () => {} };
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store, log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.secrets.every((s) => s.error === "fingerprint_store_unavailable")).toBe(true);
  });

  it("skips secrets whose source or Worker name is unset, and Cloudflare when unconfigured", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv({ SITE_GATEWAY_BROKER_SECRET: undefined, ZAVI_STATIC_WORKER_NAME: "" }), fetch: cf.f, store: memStore(), log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts.map((p) => `${p.worker}/${p.name}`)).toEqual(["zavi-site-gateway/PREVIEW_HMAC_SECRET"]);

    const r2 = await convergePlatformWorkerSecrets({}, { env: baseEnv({ CLOUDFLARE_WFP_API_TOKEN: "", CLOUDFLARE_STATIC_API_TOKEN: "" }), fetch: cf.f, store: memStore(), log: quiet });
    const alert = vi.fn(async () => {});
    const r3 = await convergePlatformWorkerSecrets({}, { env: baseEnv({ CLOUDFLARE_WFP_API_TOKEN: "", CLOUDFLARE_STATIC_API_TOKEN: "" }), fetch: cf.f, store: memStore(), alert, log: quiet });
    expect(r3).toEqual({ ok: false, skipped: "not_configured", missing: ["CLOUDFLARE_WFP_API_TOKEN"] });
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0] as unknown[])[0]).toBe("sites.worker_secrets.failed");
  });

  it("scrubs a held value or the token that Cloudflare echoes in an error", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const echo = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10021, message: `bad value ${PREVIEW} for ${TOKEN}` }] }), { status: 400 });
      }
      return (cf.f as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const alert = vi.fn(async () => {});
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: echo, store: memStore(), alert, log: (l) => lines.push(l) });
    const everything = JSON.stringify(r) + lines.join("\n") + JSON.stringify(alert.mock.calls);
    expect(everything).toContain("[redacted]");
    expect(everything).not.toContain(PREVIEW);
    expect(everything).not.toContain(TOKEN);
  });

  it("uses PLATFORM_SECRET_FINGERPRINT_KEY when set, so a token rotation does not rewrite secrets", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const store = memStore();
    await convergePlatformWorkerSecrets({}, { env: baseEnv({ PLATFORM_SECRET_FINGERPRINT_KEY: "k".repeat(40) }), fetch: cf.f, store, log: quiet });
    expect(store.rows.get(`${ACC}|zavi-site-gateway|PREVIEW_HMAC_SECRET`)).toBe(
      secretFingerprint("k".repeat(40), ACC, "zavi-site-gateway", "PREVIEW_HMAC_SECRET", PREVIEW),
    );
    expect(store.rows.get(`${ACC}|zavi-site-gateway|PREVIEW_HMAC_SECRET`)).not.toBe(
      secretFingerprint(TOKEN, ACC, "zavi-site-gateway", "PREVIEW_HMAC_SECRET", PREVIEW),
    );
  });

  it("the admin script refuses Apply off the canonical container", async () => {
    const { getScript } = await import("@/services/admin-scripts/registry");
    const script = getScript("platform-worker-secrets")!;
    const ctx = { staff: { user_id: "u", email: "e@x" }, env: baseEnv({ PRAXIS_CONTAINER_ROLE: undefined }) };
    await expect(script.prepareApply!({ force: false }, ctx, "CONVERGE WORKER SECRETS")).rejects.toMatchObject({ code: "not_canonical" });
  });

  it("refuses a value with surrounding whitespace instead of guessing", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} });
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv({ SITE_GATEWAY_BROKER_SECRET: ` ${BROKER}\n` }), fetch: cf.f, store: memStore(), log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts.some((p) => p.name === "BROKER_HMAC_SECRET")).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("a staging backend never writes a prod Worker, and prod never writes a -dev one", async () => {
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {}, "zavi-site-gateway-dev": {} });
    const r = await convergePlatformWorkerSecrets({}, { env: baseEnv({ EXECUTION_ENV: "staging" }), fetch: cf.f, store: memStore(), log: quiet });
    if (r.skipped) throw new Error("skipped");
    expect(cf.puts).toHaveLength(0);
    expect(r.workers.every((w) => w.status === "refused")).toBe(true);
    expect((cf.f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    const r2 = await convergePlatformWorkerSecrets({}, { env: baseEnv({ ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway-dev" }), fetch: cf.f, store: memStore(), log: quiet });
    if (r2.skipped) throw new Error("skipped");
    expect(cf.puts.some((p) => p.worker === "zavi-site-gateway-dev")).toBe(false);

    expect(workerEnvRefusal("zavi-site-gateway-dev", { EXECUTION_ENV: "staging" })).toBeNull();
    expect(workerEnvRefusal("zavi-site-gateway", {})).toBeNull();
  });

  it("never logs a value or the token", async () => {
    const lines: string[] = [];
    const cf = fakeCf({ "zavi-static-host": {}, "zavi-site-gateway": {} }, { failPut: "zavi-static-host/PREVIEW_HMAC_SECRET" });
    await convergePlatformWorkerSecrets({}, { env: baseEnv(), fetch: cf.f, store: memStore(), log: (l) => lines.push(l) });
    const all = lines.join("\n");
    expect(all).not.toContain(PREVIEW);
    expect(all).not.toContain(BROKER);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("zavi-static-host PREVIEW_HMAC_SECRET: error");
  });

  it("fingerprints are keyed and bound to account, worker and secret", () => {
    const a = secretFingerprint("k1", "acc", "w", "S", "v");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(secretFingerprint("k2", "acc", "w", "S", "v")).not.toBe(a);
    expect(secretFingerprint("k1", "acc", "w2", "S", "v")).not.toBe(a);
    expect(secretFingerprint("k1", "acc", "w", "S2", "v")).not.toBe(a);
    expect(secretFingerprint("k1", "acc2", "w", "S", "v")).not.toBe(a);
  });
});
