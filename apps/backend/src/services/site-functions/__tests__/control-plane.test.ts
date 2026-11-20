import { describe, expect, it, vi } from "vitest";
import { activateSiteFunctions, reconcileDirtySites, deployTestSiteFunctions, destroyTestSiteFunctions, setSiteFunctionsEnabled, stageSiteFunctions, type DeployDeps } from "../deploy";
import { deleteSiteSecret, putSiteSecret, SecretInputError } from "../secrets";
import { backoffSeconds, invokeRun, invokeRuns, schedulerTick } from "../scheduler";
import { ingestLogBatch, redactValues } from "../logs";
import { signInvocation } from "../signing";
import { runSweep, stopSiteFunctions } from "../sweeper";
import { createSiteFunctionsService } from "../service";
import { liveScriptName, siteFunctionsConfig, testScriptName } from "../config";
import type { ClaimedRun, SiteFunctionsStore } from "../store";
import type { WfpApi } from "../cf-api";
import { createWfpApi } from "../cf-api";
import { signLogBatch, verifyInvocation } from "../../../../../../infra/site-functions/src/shared";

const T = "00000000-0000-4000-8000-00000000000a";
const S = "11111111-1111-4111-8111-111111111111";
const TS = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-02T12:00:30Z");
const REF = "abcdefghijklmnopqrst";

const MANIFEST = {
  functions: {
    endpoints: { checkout: { type: "http" }, "stripe-webhook": { type: "webhook", asAdmin: true } },
    schedules: { nightly: { cron: "0 3 * * *" } },
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    allowedHosts: ["api.example.com"],
  },
};
const FILES: Record<string, string> = {
  "functions/checkout.ts": "export default { zaviFunction: 1, invoke: async () => new Response('c') };",
  "functions/stripe-webhook.ts": "export default { zaviFunction: 1, invoke: async () => new Response('w') };",
  "functions/nightly.ts": "export default { zaviFunction: 1, invoke: async () => new Response('n') };",
};
const reader = { read: async (p: string) => (p in FILES ? FILES[p] : null) };

function fakeStore(over: Partial<SiteFunctionsStore> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, ret: unknown) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(typeof ret === "function" ? (ret as (...x: unknown[]) => unknown)(...a) : ret); };
  const db = { status: "active", generation: null as number | null, script: null as string | null, version: 0, manifests: new Map<string, unknown>(), synced: -1, holder: null as string | null };
  const store = {
    secretValues: rec("secretValues", [{ name: "STRIPE_SECRET_KEY", value: "sk_test_abcdef" }, { name: "UNDECLARED", value: "zzzzzzzz" }]),
    stage: rec("stage", (i: { script: string; manifest: unknown }) => { db.manifests.set(i.script, i.manifest); return "staged"; }),
    activate: rec("activate", (_t: string, _s: string, gen: number, script: string | null) => {
      const prev = db.script;
      db.generation = gen; db.script = script; db.version++;
      return { outcome: "activated", script, previous_script: prev, status: db.status };
    }),
    setStatus: rec("setStatus", (_t: string, _s: string, status: string) => { db.status = status; db.version++; return { outcome: "ok", status }; }),
    reconcileBegin: rec("reconcileBegin", (_s: string, holder: string) => {
      if (db.holder) return null;
      db.holder = holder;
      return {
        site_id: S, tenant_id: T, status: db.status, active_generation: db.generation, active_script: db.script, sync_version: db.version,
        manifest: db.script ? (db.manifests.get(db.script) ?? null) : null,
      };
    }),
    reconcileEnd: rec("reconcileEnd", (_s: string, holder: string, v: number, ok: boolean) => {
      if (db.holder !== holder) return false;
      db.holder = null;
      if (ok && v === db.version) { db.synced = v; return true; }
      return false;
    }),
    dirtySites: rec("dirtySites", []),
    scriptDeleted: rec("scriptDeleted", true),
    secretSet: rec("secretSet", { name: "STRIPE_SECRET_KEY", scope: "live", updated_at: "now", rotated: true }),
    secretDelete: rec("secretDelete", true),
    overview: rec("overview", { state: { active_script: liveScriptName(S, 7), status: "active" } }),
    ...over,
  } as unknown as SiteFunctionsStore;
  return { store, calls, db };
}

function fakeWfp() {
  const ops: Array<[string, ...unknown[]]> = [];
  const api: WfpApi = {
    upload: async (i) => { ops.push(["upload", i.script, i.secrets.map((s) => s.name), i.modules.length, i.tags]); },
    remove: async (s) => { ops.push(["remove", s]); },
    putSecret: async (s, n) => { ops.push(["putSecret", s, n]); return "ok"; },
    deleteSecret: async (s, n) => { ops.push(["deleteSecret", s, n]); return "ok"; },
  };
  return { api, ops };
}

function fakeKv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, kv: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } } };
}

function deps(over: Partial<DeployDeps> = {}) {
  const { store, calls, db } = fakeStore();
  const { api, ops } = fakeWfp();
  const { kv, m } = fakeKv();
  const d: DeployDeps = {
    store, wfp: () => api, kv,
    shardRef: async () => REF,
    now: () => NOW,
    log: () => undefined,
    newId: (() => { let n = 0; return () => `f0000000-0000-4000-8000-00000000000${++n}`; })(),
    ...over,
  };
  return { d, calls, ops, kvMap: m, db };
}

describe("deploy: stage then activate", () => {
  it("stages (tracked before upload), uploads only declared secrets, and reports the missing ones", async () => {
    const { d, calls, ops } = deps();
    const r = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    expect(r).toMatchObject({ kind: "staged", script: liveScriptName(S, 7), missing_secrets: ["STRIPE_WEBHOOK_SECRET"] });
    const stageIdx = calls.findIndex((c) => c[0] === "stage");
    expect(stageIdx).toBeGreaterThan(-1);
    expect(ops[0]).toEqual(["upload", liveScriptName(S, 7), ["STRIPE_SECRET_KEY"], 5, [`site:${S}`, "gen:7", "kind:live"]]);
    const staged = calls[stageIdx][1][0] as Record<string, unknown>;
    expect(JSON.stringify(staged)).not.toContain("sk_test_abcdef");
  });

  it("a superseded generation uploads nothing", async () => {
    const { d, ops } = deps({ store: fakeStore({ stage: async () => "superseded" as const }).store });
    expect(await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 3, manifestRaw: MANIFEST, reader })).toEqual({ kind: "superseded" });
    expect(ops).toEqual([]);
  });

  it("no functions block: nothing staged, nothing uploaded", async () => {
    const { d, ops, calls } = deps();
    expect(await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 3, manifestRaw: { collections: {} }, reader })).toEqual({ kind: "none" });
    expect(ops).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("activation: DB CAS, principals, fresh secrets, then the KV pointer (last)", async () => {
    const { d, calls, ops, kvMap } = deps();
    const staged = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    const r = await activateSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, staged });
    expect(r).toEqual({ outcome: "activated", script: liveScriptName(S, 7) });
    const act = calls.find((c) => c[0] === "activate")!;
    expect(act[1].slice(0, 4)).toEqual([T, S, 7, liveScriptName(S, 7)]);
    expect(act[1][4]).toEqual([{ name: "nightly", cron: "0 3 * * *", data_access: "function", next_run_at: "2026-10-03T03:00:00.000Z" }]);
    expect(JSON.parse(kvMap.get(`fnprincipal:${S}`)!)).toEqual({ v: 1, shard_id: REF, admin_fns: ["stripe-webhook"] });
    expect(ops.filter((o) => o[0] === "putSecret" || o[0] === "deleteSecret")).toEqual([
      ["putSecret", liveScriptName(S, 7), "STRIPE_SECRET_KEY"],
      ["deleteSecret", liveScriptName(S, 7), "STRIPE_WEBHOOK_SECRET"],
    ]);
    expect(calls.find((c) => c[0] === "reconcileEnd")![1].slice(2)).toEqual([1, true]);
    const rec = JSON.parse(kvMap.get(`fnsite:${S}`)!);
    expect(rec).toMatchObject({
      v: 1, site_id: S, status: "active", generation: 7, script: liveScriptName(S, 7), allowed_hosts: ["api.example.com"],
      endpoints: { checkout: { type: "http", principals: ["anyone"], data: "function" }, "stripe-webhook": { type: "webhook", principals: [], data: "admin" } },
      schedules: { nightly: { data: "function" } },
    });
  });

  it("a DB-superseded activation never touches KV", async () => {
    const { d, kvMap } = deps({ store: fakeStore({ activate: async () => ({ outcome: "superseded" as const }) }).store });
    const r = await activateSiteFunctions(d, { tenant_id: T, site_id: S, generation: 5, manifestRaw: MANIFEST, staged: { kind: "staged", generation: 5, script: liveScriptName(S, 5), bundle_sha256: "x", missing_secrets: [] } });
    expect(r.outcome).toBe("superseded");
    expect(kvMap.size).toBe(0);
  });

  it("KV is rebuilt from the DB's active generation, so a slower older activation can never win", async () => {
    const { d, kvMap, db } = deps();
    await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 8, manifestRaw: MANIFEST, reader });
    await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    db.generation = 8; db.script = liveScriptName(S, 8); db.version = 5;
    const store7 = { ...d.store, activate: async () => ({ outcome: "activated" as const, script: liveScriptName(S, 7), previous_script: null, status: "active" }) };
    await activateSiteFunctions({ ...d, store: store7 }, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, staged: { kind: "staged", generation: 7, script: liveScriptName(S, 7), bundle_sha256: "x", missing_secrets: [] } });
    const rec = JSON.parse(kvMap.get(`fnsite:${S}`)!);
    expect(rec).toMatchObject({ generation: 8, script: liveScriptName(S, 8) });
  });

  it("one reconciler per site: a held lease answers busy and writes nothing", async () => {
    const { d, kvMap, db } = deps();
    const staged = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    db.holder = "someone-else";
    const r = await activateSiteFunctions({ ...d, sleep: async () => undefined }, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, staged });
    expect(r.outcome).toBe("activated");
    expect(kvMap.has(`fnsite:${S}`)).toBe(false);
    expect(db.synced).toBe(-1);
  });

  it("a failed KV write leaves the row dirty, and the dirty sweep repairs it", async () => {
    const { d, kvMap, db } = deps();
    const staged = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    let fail = true;
    const kv = { ...d.kv, put: async (k: string, v: string) => { if (fail) throw new Error("kv write failed (500)"); kvMap.set(k, v); } };
    await expect(activateSiteFunctions({ ...d, kv }, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, staged })).rejects.toThrow(/kv write failed/);
    expect(db.synced).toBe(-1);
    fail = false;
    const store = { ...d.store, dirtySites: async () => [S] };
    expect(await reconcileDirtySites({ ...d, kv, store })).toEqual({ synced: 1, failed: 0 });
    expect(JSON.parse(kvMap.get(`fnsite:${S}`)!).generation).toBe(7);
    expect(db.synced).toBe(db.version);
  });

  it("activating 'no functions' clears the pointer and the principals", async () => {
    const { d, kvMap } = deps();
    kvMap.set(`fnsite:${S}`, "{}");
    kvMap.set(`fnprincipal:${S}`, "{}");
    const r = await activateSiteFunctions(d, { tenant_id: T, site_id: S, generation: 8, manifestRaw: {}, staged: { kind: "none" } });
    expect(r).toEqual({ outcome: "activated", script: null });
    expect(kvMap.has(`fnsite:${S}`)).toBe(false);
    expect(kvMap.has(`fnprincipal:${S}`)).toBe(false);
  });

  it("admin only for functions marked asAdmin; a disabled site keeps no function identity", async () => {
    const { d, kvMap } = deps();
    const m = { functions: { ...MANIFEST.functions, endpoints: { checkout: { type: "http" }, "stripe-webhook": { type: "webhook" } } } };
    const staged = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: m, reader });
    await activateSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: m, staged });
    expect(JSON.parse(kvMap.get(`fnprincipal:${S}`)!)).toEqual({ v: 1, shard_id: REF, admin_fns: [] });
    await setSiteFunctionsEnabled(d, { tenant_id: T, site_id: S, enabled: false });
    expect(kvMap.has(`fnprincipal:${S}`)).toBe(false);
    expect(JSON.parse(kvMap.get(`fnsite:${S}`)!).status).toBe("disabled");
  });

  it("kill switch flips the DB, then the dispatcher's record", async () => {
    const { d, kvMap, calls } = deps();
    const staged = await stageSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, reader });
    await activateSiteFunctions(d, { tenant_id: T, site_id: S, generation: 7, manifestRaw: MANIFEST, staged });
    await setSiteFunctionsEnabled(d, { tenant_id: T, site_id: S, enabled: false, reason: "owner" });
    expect(calls.find((c) => c[0] === "setStatus")![1]).toEqual([T, S, "disabled", "owner"]);
    expect(JSON.parse(kvMap.get(`fnsite:${S}`)!).status).toBe("disabled");
  });
});

describe("deploy: publish-gate test sites", () => {
  it("test copy gets TEST secrets only, its own script and KV record; destroy removes all of it", async () => {
    const values = vi.fn(async (_t: string, _s: string, scope: string) => (scope === "test" ? [{ name: "STRIPE_SECRET_KEY", value: "sk_test_gate1" }] : [{ name: "STRIPE_SECRET_KEY", value: "sk_live_zzzzzz" }]));
    const { store } = fakeStore({ secretValues: values as never });
    const { d, ops, kvMap } = deps({ store });
    const r = await deployTestSiteFunctions(d, { tenant_id: T, live_site_id: S, test_site_id: TS, shard_ref: "validationshard00001", manifestRaw: MANIFEST, reader });
    expect(r).toMatchObject({ kind: "staged", script: testScriptName(TS) });
    expect(values).toHaveBeenCalledWith(T, S, "test");
    expect(values).not.toHaveBeenCalledWith(T, S, "live");
    expect(ops[0][1]).toBe(testScriptName(TS));
    expect(JSON.parse(kvMap.get(`fnsite:${TS}`)!)).toMatchObject({ site_id: TS, test: true, status: "active" });
    await destroyTestSiteFunctions(d, { test_site_id: TS });
    expect(kvMap.has(`fnsite:${TS}`)).toBe(false);
    expect(kvMap.has(`fnprincipal:${TS}`)).toBe(false);
    expect(ops.at(-1)).toEqual(["remove", testScriptName(TS)]);
  });
});

describe("secrets", () => {
  it("validates, stores, and pushes to the running script; never echoes the value", async () => {
    const { store, calls } = fakeStore();
    const { api, ops } = fakeWfp();
    const r = await putSiteSecret({ store, wfp: () => api }, { tenant_id: T, site_id: S, name: "STRIPE_SECRET_KEY", value: "fake-owner-secret-value" });
    expect(r).toEqual({ name: "STRIPE_SECRET_KEY", scope: "live", updated_at: "now", rotated: true, applied: true });
    expect(JSON.stringify(r)).not.toContain("fake-owner-secret-value");
    expect(ops).toEqual([["putSecret", liveScriptName(S, 7), "STRIPE_SECRET_KEY"]]);
    expect(calls[0][1]).toEqual([T, S, "live", "STRIPE_SECRET_KEY", "fake-owner-secret-value"]);
    for (const bad of [{ name: "lower" }, { name: "ZAVI_X" }, { name: "OK_NAME", value: "" }, { name: "OK_NAME", value: "short" }, { name: "OK_NAME", value: "x".repeat(9000) }, { name: "OK_NAME", scope: "prod" }]) {
      await expect(putSiteSecret({ store, wfp: () => api }, { tenant_id: T, site_id: S, value: "v", ...bad } as never)).rejects.toBeInstanceOf(SecretInputError);
    }
  });

  it("a failed push is reported (applied:false) and logged without the value", async () => {
    const { store } = fakeStore();
    const lines: string[] = [];
    const api = { ...fakeWfp().api, putSecret: async () => { throw new Error("cloudflare put_secret failed (500)"); } };
    const r = await putSiteSecret({ store, wfp: () => api, log: (l) => lines.push(JSON.stringify(l)) }, { tenant_id: T, site_id: S, name: "STRIPE_SECRET_KEY", value: "fake-owner-secret-value" });
    expect(r.applied).toBe(false);
    expect(lines.join("")).not.toContain("fake-owner-secret-value");
  });

  it("delete removes the binding from the running script", async () => {
    const { store } = fakeStore();
    const { api, ops } = fakeWfp();
    expect(await deleteSiteSecret({ store, wfp: () => api }, { tenant_id: T, site_id: S, name: "STRIPE_SECRET_KEY" })).toEqual({ name: "STRIPE_SECRET_KEY", scope: "live", deleted: true, applied: true });
    expect(ops).toEqual([["deleteSecret", liveScriptName(S, 7), "STRIPE_SECRET_KEY"]]);
  });
});

describe("scheduler", () => {
  const run: ClaimedRun = {
    id: "44444444-4444-4444-8444-444444444444", site_id: S, tenant_id: T, schedule_name: "nightly", slot: "2026-10-02T03:00:00Z",
    idempotency_key: `${S}:nightly:1790910000`, attempt: 2, max_attempts: 5, data_access: "function", hostname: "Shop.Example.com",
  };

  it("fires the latest due slot once and claims runs", async () => {
    const fire = vi.fn(async (..._a: unknown[]) => "fired" as const);
    const { store } = fakeStore({
      schedulesDue: async () => [{ id: "sc1", site_id: S, tenant_id: T, name: "nightly", cron: "*/5 * * * *", next_run_at: "2026-10-02T10:00:00Z" }],
      scheduleFire: fire,
      runsClaim: async () => [run],
    } as never);
    const r = await schedulerTick({ store, now: () => NOW, log: () => undefined });
    expect(r).toMatchObject({ fired: 1, claimed: [run] });
    expect(fire).toHaveBeenCalledWith("sc1", "2026-10-02T10:00:00Z", new Date("2026-10-02T12:00:00Z"), new Date("2026-10-02T12:05:00Z"), 5);
  });

  it("signs a schedule invocation the dispatcher accepts, with no user", async () => {
    let captured = null as { headers: Headers; body: Uint8Array } | null;
    const finish = vi.fn(async (..._a: unknown[]) => "succeeded");
    const { store } = fakeStore({ runFinish: finish } as never);
    const fetchFn = (async (_u: string, init: RequestInit) => {
      captured = { headers: new Headers(init.headers), body: new Uint8Array(init.body as Buffer) };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await invokeRun({ store, dispatchUrl: "https://fn.example.com/v1/invoke", dispatchSecret: "dispatch-secret-0123456789", fetchFn, now: () => NOW, log: () => undefined }, run)).toBe("succeeded");
    const meta = await verifyInvocation("dispatch-secret-0123456789", captured!.headers, captured!.headers.get("x-zavi-fd-method")!, captured!.body, NOW.getTime());
    expect(meta).toMatchObject({ kind: "schedule", site_id: S, host: "shop.example.com", name: "nightly", user: null, idempotency_key: run.idempotency_key, attempt: 2 });
    expect(finish).toHaveBeenCalledWith(run.id, 2, true, 200, null, null);
  });

  it("retries 5xx / network with backoff; dead on other 4xx", async () => {
    const finish = vi.fn(async (..._a: unknown[]) => "retry");
    const { store } = fakeStore({ runFinish: finish } as never);
    const mk = (status: number | "throw") => (async () => { if (status === "throw") throw new Error("ECONNRESET"); return new Response(JSON.stringify({ error: { code: "x" } }), { status }); }) as unknown as typeof fetch;
    const base = { store, dispatchUrl: "https://fn.example.com/v1/invoke", dispatchSecret: "s", now: () => NOW, log: () => undefined, random: () => 0.5 };
    await invokeRun({ ...base, fetchFn: mk(503) }, run);
    expect(finish.mock.calls[0].slice(2, 6)).toEqual([false, 503, "x", new Date(NOW.getTime() + backoffSeconds(2, () => 0.5) * 1000)]);
    await invokeRun({ ...base, fetchFn: mk("throw") }, run);
    expect(finish.mock.calls[1].slice(2, 5)).toEqual([false, null, "dispatch_unreachable"]);
    await invokeRun({ ...base, fetchFn: mk(404) }, run);
    expect(finish.mock.calls[2][5]).toBeNull();
    await invokeRun({ ...base, fetchFn: mk(500) }, { ...run, attempt: 5 });
    expect(finish.mock.calls[3][5]).toBeNull();
    expect(backoffSeconds(1, () => 0.5)).toBe(30);
    expect(backoffSeconds(20, () => 0.5)).toBe(3600);
  });

  it("the fan-out batch re-reads each run from the DB and ignores refs that lost their lease", async () => {
    const leased = vi.fn(async (id: string) => (id === run.id ? run : null));
    const { store } = fakeStore({ runLeased: leased, runFinish: async () => "succeeded" } as never);
    const fetchFn = (async () => new Response("ok")) as unknown as typeof fetch;
    const counts = await invokeRuns({ store, dispatchUrl: "https://fn.example.com/v1/invoke", dispatchSecret: "s", fetchFn, now: () => NOW, log: () => undefined },
      [{ id: run.id, attempt: 2 }, { id: "55555555-5555-4555-8555-555555555555", attempt: 1 }, { id: "not-a-uuid", attempt: 1 }]);
    expect(counts).toEqual({ succeeded: 1, not_leased: 2 });
    expect(leased).toHaveBeenCalledTimes(2);
  });
});

describe("logs ingest", () => {
  const secret = "log-secret-0123456789";
  it("verifies the tail Worker's signature and redacts exact secret values before storing", async () => {
    const inserted: unknown[] = [];
    const { store } = fakeStore({
      secretsForScripts: async () => [{ script: liveScriptName(S, 7), value: "my-custom-api-key-1234" }],
      logsInsert: async (e: unknown[]) => { inserted.push(...e); return e.length; },
    } as never);
    const body = Buffer.from(JSON.stringify({ v: 1, entries: [{ script: liveScriptName(S, 7), ts: NOW.getTime(), level: "info", message: "calling with my-custom-api-key-1234 now", outcome: "ok", path: "/api/fn/checkout", status: 200 }, { script: "evil", ts: 1, level: "info", message: "x" }] }));
    const h = await signLogBatch(secret, new Uint8Array(body), NOW.getTime());
    const r = await ingestLogBatch({ store, secret, now: () => NOW.getTime() }, (n) => (h as Record<string, string>)[n], body);
    expect(r).toEqual({ status: 200, body: { stored: 1 } });
    expect(JSON.stringify(inserted)).not.toContain("my-custom-api-key-1234");
    expect((inserted[0] as { message: string }).message).toBe("calling with [redacted] now");
    const bad = await ingestLogBatch({ store, secret, now: () => NOW.getTime() }, () => undefined, body);
    expect(bad.status).toBe(401);
    expect((await ingestLogBatch({ store, secret: undefined }, () => undefined, body)).status).toBe(503);
  });

  it("redacts the longest value first", () => {
    expect(redactValues("aaaaaaXXXX and aaaaaa", ["aaaaaa", "aaaaaaXXXX"])).toBe("[redacted] and [redacted]");
  });
});

describe("sweeper", () => {
  it("tears down a deleted site's functions and removes stale scripts", async () => {
    const order: string[] = [];
    const { store } = fakeStore({
      sweepCandidates: async () => [
        { kind: "site", site_id: S, tenant_id: T, script: null },
        { kind: "script", site_id: TS, tenant_id: T, script: testScriptName(TS) },
      ],
      teardownBegin: async () => { order.push("begin"); return [liveScriptName(S, 7)]; },
      teardownFinish: async () => { order.push("finish"); return true; },
      scriptDeleted: async (s: string) => { order.push(`deleted:${s}`); return true; },
      retention: async () => ({ logs: 3, runs: 1 }),
    } as never);
    const { api, ops } = fakeWfp();
    const { kv, m } = fakeKv({ [`fnsite:${S}`]: "{}", [`fnprincipal:${S}`]: "{}", [`fnsite:${TS}`]: "{}" });
    const r = await runSweep({ store, wfp: () => api, kv, now: () => NOW, log: () => undefined });
    expect(r).toEqual({ sites: 1, scripts: 1, failed: 0, logs: 3, runs: 1 });
    expect(order).toEqual(["begin", `deleted:${liveScriptName(S, 7)}`, "finish", `deleted:${testScriptName(TS)}`]);
    expect(ops).toEqual([["remove", liveScriptName(S, 7)], ["remove", testScriptName(TS)]]);
    expect(m.size).toBe(0);
  });
});

describe("config + Cloudflare client", () => {
  it("unconfigured env is typed missing, never a default", () => {
    expect(siteFunctionsConfig({})).toMatchObject({ ok: false });
    const ok = siteFunctionsConfig({
      CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_WFP_API_TOKEN: "tok", SITE_FN_NAMESPACE: "zavi-sites-fn-prod",
      SITE_FN_TAIL_WORKER: "zavi-fn-tail", SITE_FN_DISPATCH_URL: "https://fn.example.com/v1/invoke", SITE_FN_DISPATCH_SECRET: "s",
    });
    expect(ok.ok).toBe(true);
    expect(siteFunctionsConfig({ ...{ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_WFP_API_TOKEN: "t", SITE_FN_NAMESPACE: "n_bad", SITE_FN_TAIL_WORKER: "t", SITE_FN_DISPATCH_URL: "https://x/v1/invoke", SITE_FN_DISPATCH_SECRET: "s" } }).ok).toBe(false);
  });

  it("uploads modules + secret bindings + tail consumer to the namespace; errors never include values", async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    const api = createWfpApi(
      { accountId: "acc", token: "tok", namespace: "zavi-sites-fn-prod", tailWorker: "zavi-fn-tail", dispatchUrl: "https://x/v1/invoke", dispatchSecret: "s" },
      async (url, init) => { seen.push({ url, method: init.method, body: init.body }); return { status: url.includes("secrets") ? 500 : 200, text: async () => '{"errors":[{"code":10000}]}' }; },
    );
    await api.upload({ script: "zfn-abc-1", mainModule: "__zavi_entry.js", modules: [{ name: "__zavi_entry.js", content: "export default {}" }], secrets: [{ name: "K", value: "sk_live_value" }], tags: ["site:x"] });
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/workers/dispatch/namespaces/zavi-sites-fn-prod/scripts/zfn-abc-1");
    const form = seen[0].body as FormData;
    const meta = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(meta).toMatchObject({ main_module: "__zavi_entry.js", bindings: [{ type: "secret_text", name: "K", text: "sk_live_value" }], tail_consumers: [{ service: "zavi-fn-tail" }], tags: ["site:x"] });
    await expect(api.putSecret("zfn-abc-1", "K", "sk_live_value")).rejects.toThrow(/put_secret failed \(500 10000\)/);
    await api.putSecret("zfn-abc-1", "K", "sk_live_value").catch((e: Error) => expect(e.message).not.toContain("sk_live_value"));
    await expect(api.remove("../evil")).rejects.toThrow(/invalid script name/);
  });
});

describe("signing parity with the Worker", () => {
  it("node signInvocation verifies in the Worker code", async () => {
    const meta = { v: 1 as const, site_id: S, host: "shop.example.com", kind: "schedule" as const, name: "nightly", request_id: "run-1", user: null, scheduled_time: "2026-10-02T03:00:00.000Z", idempotency_key: `${S}:nightly:1`, attempt: 1 };
    const h = signInvocation("sec", meta, "POST", Buffer.alloc(0), NOW.getTime());
    expect(await verifyInvocation("sec", new Headers(h), "POST", new Uint8Array(0), NOW.getTime())).toEqual(meta);
    expect(await verifyInvocation("other", new Headers(h), "POST", new Uint8Array(0), NOW.getTime())).toBeNull();
  });
});

describe("owner service (S8b SiteFunctionsService contract)", () => {
  it("maps secrets, functions, runs and refusals to the contract shapes", async () => {
    const { store } = fakeStore({
      secretList: async () => [{ name: "STRIPE_SECRET_KEY", scope: "live", created_at: "c", updated_at: "u" }, { name: "TEST_ONLY", scope: "test", created_at: "c", updated_at: "u" }],
      overview: async () => ({
        hostname: "shop.example.com",
        deployment: { manifest: { endpoints: { checkout: { type: "http" }, "stripe-webhook": { type: "webhook" } }, schedules: { nightly: { cron: "0 3 * * *" } }, secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] } },
        schedules: [{ name: "nightly", cron: "0 3 * * *", enabled: true }],
        state: { active_script: liveScriptName(S, 7), status: "active" },
      }),
      runsList: async () => [{ id: "r1", schedule: "nightly", slot: "s", state: "dead", last_status: 500, created_at: "2026-10-02T03:00:00Z", finished_at: "2026-10-02T03:00:02Z", last_error: "function_error" }],
      scheduleSetEnabled: async () => true,
    } as never);
    const { api } = fakeWfp();
    const { d } = deps({ store, wfp: () => api });
    const svc = createSiteFunctionsService(d);
    const site = { tenant_id: T, site_id: S };
    expect(await svc.listSecrets(site)).toEqual({ secrets: [{ name: "STRIPE_SECRET_KEY", updated_at: "u" }], required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] });
    const fns = await svc.listFunctions(site);
    expect(fns.map((f) => [f.name, f.kind, f.url])).toEqual([
      ["checkout", "http", "https://shop.example.com/api/fn/checkout"],
      ["nightly", "schedule", null],
      ["stripe-webhook", "webhook", "https://shop.example.com/api/hooks/stripe-webhook"],
    ]);
    expect(fns[1].last_run).toMatchObject({ id: "r1", status: "error", duration_ms: 2000, http_status: 500 });
    expect(await svc.listRuns(site, "nope", { limit: 5 })).toBeNull();
    expect(await svc.listRuns(site, "checkout", { limit: 5 })).toEqual([]);
    expect((await svc.listRuns(site, "nightly", { limit: 5 }))![0].log[0]).toMatchObject({ level: "error", message: "function_error" });
    expect(await svc.putSecret(site, "STRIPE_SECRET_KEY", "fake-owner-secret-value", { user_id: "u" })).toEqual({ name: "STRIPE_SECRET_KEY", updated_at: "now" });
    await expect(svc.putSecret(site, "ZAVI_X", "fake-owner-secret-value", { user_id: "u" })).rejects.toMatchObject({ status: 400, code: "invalid_secret" });
    expect((await svc.setScheduleEnabled(site, "nightly", false, { user_id: "u" }))?.kind).toBe("schedule");
  });
});

describe("stopSiteFunctions (site deletion)", () => {
  it("marks the functions deleting in the DB, then drops the dispatcher pointer and the signer record", async () => {
    const order: string[] = [];
    const { store } = fakeStore({ teardownBegin: async () => { order.push("db"); return []; } } as never);
    const { kv, m } = fakeKv({ [`fnsite:${S}`]: "{}", [`fnprincipal:${S}`]: "{}" });
    await stopSiteFunctions({ store, kv: { ...kv, delete: async (k: string) => { order.push(`kv:${k.split(":")[0]}`); m.delete(k); } } }, S);
    expect(order).toEqual(["db", "kv:fnsite", "kv:fnprincipal"]);
    expect(m.size).toBe(0);
  });

  it("a site that never had functions costs no KV delete (the hourly reaper retries a deleting site)", async () => {
    const { store } = fakeStore({ teardownBegin: async () => [] } as never);
    let deletes = 0;
    const { kv } = fakeKv();
    await stopSiteFunctions({ store, kv: { ...kv, delete: async () => { deletes++; } }, hasFunctionState: async () => false }, S);
    expect(deletes).toBe(0);
  });

  it("still drops both records when the site has a function state row, or a script even without one", async () => {
    for (const [scripts, has] of [[[], true], [[liveScriptName(S, 7)], false]] as const) {
      const { store } = fakeStore({ teardownBegin: async () => [...scripts] } as never);
      const gone: string[] = [];
      const { kv } = fakeKv();
      await stopSiteFunctions({ store, kv: { ...kv, delete: async (k: string) => { gone.push(k.split(":")[0]); } }, hasFunctionState: async () => has }, S);
      expect(gone).toEqual(["fnsite", "fnprincipal"]);
    }
  });

  it("a KV failure fails the stop (teardown stays incomplete, the reaper retries); so does a DB failure", async () => {
    const { store } = fakeStore({ teardownBegin: async () => [] } as never);
    const { kv } = fakeKv();
    await expect(stopSiteFunctions({ store, kv: { ...kv, delete: async () => { throw new Error("kv down"); } }, log: () => undefined }, S)).rejects.toThrow(/kv down/);
    const bad = fakeStore({ teardownBegin: async () => { throw new Error("db down"); } } as never).store;
    await expect(stopSiteFunctions({ store: bad, kv }, S)).rejects.toThrow(/db down/);
  });
});
