
import { describe, expect, it, vi } from "vitest";
import {
  createPooledReadiness,
  gatewayConfigured,
  missingPrerequisites,
  signerConfigured,
  type PooledReadinessDeps,
} from "../readiness";
import type { SiteStarterProvider } from "@/services/sites/contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const KEK_PUBLIC = JSON.stringify({ kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43), kid: "kek-1" });

const READY_ENV: Record<string, string> = {
  SITE_AUTH_ALIAS_KEY: "k".repeat(48),
  SITE_GATEWAY_BROKER_SECRET: "g".repeat(48),
  SITE_SIGNER_KEK_PUBLIC_JWK: KEK_PUBLIC,
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_STATIC_API_TOKEN: "tok",
  CLOUDFLARE_ZONE_ID: "zone",
  ZAVI_STATIC_R2_BUCKET: "bucket",
  ZAVI_STATIC_KV_NAMESPACE_ID: "kv",
  ZAVI_STATIC_WORKER_NAME: "static-host",
  ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway",
};
const starterWithLock: SiteStarterProvider = { starterFiles: () => ({ files: { "package-lock.json": "{}" }, starter_sql: "", manifest_json: "{}" }) };
const starterNoLock: SiteStarterProvider = {
  starterFiles: () => {
    throw new Error("no package-lock.json");
  },
};
const READY = { open: 1, placeable: 1, stale: 0, paused: 0 };
type Counts = typeof READY;

function harness(over: Partial<PooledReadinessDeps> & { envPatch?: Record<string, string | undefined> } = {}) {
  const logs: string[] = [];
  const alerts: string[] = [];
  let t = 0;
  const placement = vi.fn(async (): Promise<Counts> => READY);
  const deps: PooledReadinessDeps = {
    env: () => ({ ...READY_ENV, ...(over.envPatch ?? {}) }),
    seams: () => ({ manifest: {}, auth: {}, starter: starterWithLock }),
    shardEnv: () => "prod",
    placement,
    now: () => t,
    log: (l) => logs.push(l),
    alert: async (m) => void alerts.push(m),
    ...over,
  };
  return { r: createPooledReadiness(deps), logs, alerts, placement: (over.placement as typeof placement) ?? placement, tick: (ms: number) => (t += ms) };
}

describe("prerequisite checks", () => {
  it("signer: a PUBLIC P-256 KEK, or all three Worker-secret settings", () => {
    expect(signerConfigured({ SITE_SIGNER_KEK_PUBLIC_JWK: KEK_PUBLIC })).toBe(true);
    expect(signerConfigured({ SITE_SIGNER_KEK_PUBLIC_JWK: "not json" })).toBe(false);
    const { kid: _kid, ...noKid } = JSON.parse(KEK_PUBLIC);
    expect(signerConfigured({ SITE_SIGNER_KEK_PUBLIC_JWK: JSON.stringify(noKid) })).toBe(false);
    expect(signerConfigured({ SITE_SIGNER_KEK_PUBLIC_JWK: JSON.stringify({ ...JSON.parse(KEK_PUBLIC), d: "secret" }) })).toBe(false);
    expect(signerConfigured({ CLOUDFLARE_ACCOUNT_ID: "a", SITE_SIGNER_WORKER_NAME: "s", CLOUDFLARE_SIGNER_API_TOKEN: "t" })).toBe(true);
    expect(signerConfigured({ CLOUDFLARE_ACCOUNT_ID: "a", SITE_SIGNER_WORKER_NAME: "s" })).toBe(false);
    expect(signerConfigured({})).toBe(false);
  });
  it("gateway: static-host config plus the gateway Worker name", () => {
    expect(gatewayConfigured(READY_ENV)).toBe(true);
    expect(gatewayConfigured({ ...READY_ENV, ZAVI_SITE_GATEWAY_WORKER_NAME: "" })).toBe(false);
    expect(gatewayConfigured({ ...READY_ENV, ZAVI_STATIC_KV_NAMESPACE_ID: "" })).toBe(false);
  });
  it("names every missing piece with a stable code", () => {
    expect(missingPrerequisites({ manifest: {}, auth: {}, starter: starterWithLock }, READY_ENV)).toEqual([]);
    expect(missingPrerequisites({ manifest: null, auth: null, starter: starterNoLock }, {})).toEqual([
      "manifest_not_wired",
      "auth_broker_not_wired",
      "broker_secrets_missing",
      "signer_not_configured",
      "gateway_not_configured",
      "starter_lockfile_missing",
    ]);
  });
});

describe("createPooledReadiness", () => {
  it("default: ON with no env flag at all when every prerequisite is ready", async () => {
    const h = harness();
    expect(await h.r.enabledFor(T1)).toBe(true);
    expect(await h.r.reasons()).toEqual([]);
  });

  it("has no off switch: SITE_BACKEND_POOLED=0 is ignored, and every tenant gets the same answer", async () => {
    const h = harness({ envPatch: { SITE_BACKEND_POOLED: "0" } });
    expect(await h.r.enabledFor(T1)).toBe(true);
    expect(await h.r.enabledFor("22222222-2222-4222-8222-222222222222")).toBe(true);
  });

  it.each([
    ["broker secrets missing", { SITE_GATEWAY_BROKER_SECRET: "" }, "broker_secrets_missing"],
    ["signer not configured", { SITE_SIGNER_KEK_PUBLIC_JWK: "" }, "signer_not_configured"],
    ["gateway not configured", { ZAVI_SITE_GATEWAY_WORKER_NAME: "" }, "gateway_not_configured"],
  ])("fails closed when %s (no DB read)", async (_n, envPatch, code) => {
    const h = harness({ envPatch });
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(await h.r.reasons()).toEqual([code]);
    expect(h.placement).not.toHaveBeenCalled();
  });

  it("fails closed when the starter has no lockfile", async () => {
    const h = harness({ seams: () => ({ manifest: {}, auth: {}, starter: starterNoLock }) });
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(await h.r.reasons()).toEqual(["starter_lockfile_missing"]);
  });

  it("fails closed with no OPEN shard and alerts", async () => {
    const placement = vi.fn(async () => ({ open: 0, placeable: 0, stale: 0, paused: 0 }));
    const h = harness({ placement });
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(await h.r.reasons()).toEqual(["no_open_shard_prod"]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("no_open_shard_prod");
  });

  it("an unreadable shard registry is off for that build, never a throw, and is not cached", async () => {
    let fail = true;
    const placement = vi.fn(async () => {
      if (fail) throw new Error("db down");
      return READY;
    });
    const h = harness({ placement });
    expect(await h.r.enabledFor(T1)).toBe(false);
    fail = false;
    expect(await h.r.enabledFor(T1)).toBe(true);
  });

  it("never caches a positive answer: the last shard filling or draining turns it off on the next build", async () => {
    let counts: Counts = READY;
    const placement = vi.fn(async () => counts);
    const h = harness({ placement });
    expect(await h.r.enabledFor(T1)).toBe(true);
    counts = { open: 0, placeable: 0, stale: 0, paused: 0 };
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(placement).toHaveBeenCalledTimes(2);
  });

  it("an open shard placement would refuse is NOT ready: full by load, paused, or stale metrics", async () => {
    const cases: Array<[Counts, string]> = [
      [{ open: 1, placeable: 0, stale: 0, paused: 0 }, "no_shard_capacity_prod"],
      [{ open: 1, placeable: 0, stale: 0, paused: 1 }, "shard_placement_paused_prod"],
      [{ open: 2, placeable: 0, stale: 1, paused: 1 }, "shard_metrics_stale_prod"],
    ];
    for (const [counts, code] of cases) {
      const h = harness({ placement: vi.fn(async () => counts) });
      expect(await h.r.enabledFor(T1)).toBe(false);
      expect(await h.r.reasons()).toEqual([code]);
    }
  });

  it("one placeable shard is enough, whatever the others look like", async () => {
    expect(await harness({ placement: vi.fn(async () => ({ open: 3, placeable: 1, stale: 1, paused: 1 })) }).r.enabledFor(T1)).toBe(true);
  });

  it("STALE metrics ask for an immediate sweep (throttled), are not cached, and turn ready once the sweep lands", async () => {
    let counts: Counts = { open: 1, placeable: 0, stale: 1, paused: 0 };
    const placement = vi.fn(async () => counts);
    const requestMetricsSweep = vi.fn(async () => undefined);
    const h = harness({ placement, requestMetricsSweep });
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(await h.r.enabledFor(T1)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(requestMetricsSweep).toHaveBeenCalledTimes(1);
    expect(requestMetricsSweep).toHaveBeenCalledWith("prod");
    h.tick(60_001);
    await h.r.enabledFor(T1);
    await new Promise((r) => setTimeout(r, 0));
    expect(requestMetricsSweep).toHaveBeenCalledTimes(2);
    counts = READY;
    expect(await h.r.enabledFor(T1)).toBe(true);
    expect(placement).toHaveBeenCalledTimes(4);
  });

  it("a failing sweep request is logged, never thrown into the build", async () => {
    const requestMetricsSweep = vi.fn(async () => {
      throw new Error("inngest down");
    });
    const h = harness({ placement: vi.fn(async () => ({ open: 1, placeable: 0, stale: 1, paused: 0 })), requestMetricsSweep });
    expect(await h.r.enabledFor(T1)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.logs.some((l) => l.includes("metrics sweep request failed"))).toBe(true);
  });

  it("caches a 'no open shard' answer for 60s, then re-reads", async () => {
    let counts: Counts = { open: 0, placeable: 0, stale: 0, paused: 0 };
    const placement = vi.fn(async () => counts);
    const h = harness({ placement });
    expect(await h.r.enabledFor(T1)).toBe(false);
    counts = READY;
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(placement).toHaveBeenCalledTimes(1);
    h.tick(60_001);
    expect(await h.r.enabledFor(T1)).toBe(true);
  });

  it("logs and alerts each unavailable state ONCE, only when it changes, including the first one", async () => {
    let envPatch: Record<string, string> = { SITE_SIGNER_KEK_PUBLIC_JWK: "" };
    const h = harness({ env: () => ({ ...READY_ENV, ...envPatch }) });
    for (let i = 0; i < 5; i++) await h.r.enabledFor(T1);
    await Promise.resolve();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("signer_not_configured");
    expect(h.alerts).toHaveLength(1);
    envPatch = {};
    for (let i = 0; i < 3; i++) await h.r.enabledFor(T1);
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toContain("ready again");
    envPatch = { ZAVI_SITE_GATEWAY_WORKER_NAME: "" };
    await h.r.enabledFor(T1);
    await h.r.enabledFor(T1);
    await Promise.resolve();
    expect(h.logs).toHaveLength(3);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]).toContain("gateway_not_configured");
  });

  it("a ready first state is not logged (nothing changed)", async () => {
    const h = harness();
    await h.r.enabledFor(T1);
    expect(h.logs).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("a throwing prerequisite read never escapes enabledFor", async () => {
    const h = harness({
      seams: () => {
        throw new Error("seams exploded");
      },
    });
    expect(await h.r.enabledFor(T1)).toBe(false);
    expect(h.logs[0]).toContain("readiness_check_failed");
  });
});
