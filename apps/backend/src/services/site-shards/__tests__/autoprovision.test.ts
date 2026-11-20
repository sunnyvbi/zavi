import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  autoProvisionAllowed,
  capacityCheck,
  envHeadroom,
  finishProvision,
  jobStillWanted,
  normalizeSettings,
  provisionAttempt,
  requestProvision,
  shardHardLoad,
  shardLoad,
  type AutoProvSettings,
  type AutoProvStore,
  type CheckDeps,
  type Claim,
  type JobDeps,
  type ProvisionEvent,
  type ShardLoadRow,
  warmTarget,
} from "../autoprovision";

const ENV_OK = { PRAXIS_CONTAINER_ROLE: "canonical", NODE_ENV: "production" };

const FRESH_AT = new Date(Date.UTC(2026, 9, 1, 11, 55)).toISOString();
let id = 0;
function shard(over: Partial<ShardLoadRow> & Record<string, unknown> = {}): ShardLoadRow {
  id++;
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    name: `zavi-shard-prod-${id}`,
    state: "open",
    project_ref: `ref${String(id).padStart(8, "0")}`,
    site_count: 0,
    max_sites: 2000,
    fill_ratio: 0.8,
    lim_records: 20_000_000,
    lim_bytes: 6_442_450_944,
    lim_auth_users: 2_000_000,
    lim_sessions: 4_000_000,
    lim_emails_per_hour: 20_000,
    lim_requests_per_min: 30_000,
    lim_p95_ms: 250,
    lim_cpu_pct: 70,
    lim_connections: 120,
    m_db_at: FRESH_AT,
    m_gateway_at: FRESH_AT,
    m_cpu_at: FRESH_AT,
    ...over,
  } as ShardLoadRow;
}

function fakeStore(rows: ShardLoadRow[], opts: { paused?: boolean } = {}) {
  let chain = Promise.resolve();
  const state = { paused: opts.paused ?? false, paused_reason: opts.paused ? "staff" : null as string | null, failures: 0, last: 0 };
  const ledger: Array<{ id: string; kind: "create" | "resume"; source: string; name: string; status: string; override: boolean }> = [];
  const notices = new Set<string>();
  let lastNotice: string | null = null;
  let now = 1_000_000;
  const store: AutoProvStore = {
    claim: (i) => {
      const run = async (): Promise<Claim> => {
        await new Promise((r) => setTimeout(r, 1));
        if (i.source === "auto" && state.paused) return { action: "none", reason: "paused", paused_reason: state.paused_reason ?? undefined };
        const prov = rows.find((s) => s.state === "provisioning" && /^zavi-shard-(prod|dev)-\d+$/.test(s.name));
        const seq = ledger.length + 1;
        if (prov) {
          if (!ledger.some((l) => l.name === prov.name && l.kind === "create")) return { action: "none", reason: "in_progress_manual", shard_name: prov.name };
          if (i.source === "auto" && state.last && now - state.last < i.minRetrySeconds * 1000) return { action: "none", reason: "backoff", shard_name: prov.name };
          ledger.push({ id: `L${seq}`, kind: "resume", source: i.source, name: prov.name, status: "started", override: false });
          state.last = now;
          return { action: "resume", ledger_id: `L${seq}`, day: "2026-10-01", seq, shard_name: prov.name, region: i.region, canary: false };
        }
        const max = i.source === "staff" && i.override ? 25 : Math.min(Math.max(i.maxPerDay, 0), 10);
        const created = ledger.filter((l) => l.kind === "create").length;
        if (created >= max) return { action: "none", reason: "cap", created_today: created, cap: max };
        const n = Math.max(0, ...rows.map((s) => Number(/-(\d+)$/.exec(s.name)?.[1] ?? 0))) + 1;
        const name = `zavi-shard-${i.env}-${n}`;
        const canary = !rows.some((s) => s.state !== "retired");
        rows.push(shard({ name, state: "provisioning", project_ref: null }));
        ledger.push({ id: `L${seq}`, kind: "create", source: i.source, name, status: "started", override: i.override });
        state.last = now;
        return { action: "create", ledger_id: `L${seq}`, day: "2026-10-01", seq, shard_name: name, n, region: i.region, canary, created_today: created + 1 };
      };
      const p = chain.then(run);
      chain = p.then(() => undefined, () => undefined);
      return p;
    },
    finish: async (ledger_id, status, reason) => {
      const l = ledger.find((x) => x.id === ledger_id)!;
      if (l.status !== "started") return { status: l.status, consecutive_failures: state.failures, paused: state.paused, tripped: false, already: true };
      l.status = status;
      let tripped = false;
      if (status === "open" || status === "ready") state.failures = 0;
      else {
        state.failures++;
        if (state.failures >= 2 && !state.paused) {
          state.paused = true;
          state.paused_reason = `breaker: ${reason}`;
          tripped = true;
        }
      }
      return { status, consecutive_failures: state.failures, paused: state.paused, tripped, already: false };
    },
    setPaused: async (env, paused) => {
      state.paused = paused;
      if (!paused) state.failures = 0;
      lastNotice = null;
      return { env, paused, paused_reason: null, paused_by: null, consecutive_failures: state.failures, last_attempt_at: null };
    },
    status: async (env) => ({ state: { env, paused: state.paused, paused_reason: state.paused_reason, paused_by: null, consecutive_failures: state.failures, last_attempt_at: null }, day: "2026-10-01", created_today: ledger.filter((l) => l.kind === "create").length, ledger: [] }),
    notice: async (_env, key) => {
      notices.add(key);
      if (lastNotice === key) return false;
      lastNotice = key;
      return true;
    },
  };
  return { store, ledger, state, rows, advance: (ms: number) => (now += ms) };
}

const SETTINGS: AutoProvSettings = { enabled: true, thresholdPct: 20, maxPerDay: 10, region: "us-west-1", dryRun: false };

function deps(rows: ShardLoadRow[], over: Partial<CheckDeps> = {}, storeOpts: { paused?: boolean } = {}) {
  const f = fakeStore(rows, storeOpts);
  const sent: ProvisionEvent[] = [];
  const alerts: Array<[string, string]> = [];
  const d: CheckDeps = {
    env: "prod",
    allowed: () => autoProvisionAllowed(ENV_OK),
    listShards: async () => rows,
    settings: async () => SETTINGS,
    prereqsMissing: () => [],
    store: f.store,
    send: async (e) => void sent.push(e),
    alert: async (code, msg) => void alerts.push([code, msg]),
    log: () => undefined,
    now: () => Date.UTC(2026, 9, 1, 12),
    ...over,
  };
  return { d, f, sent, alerts };
}

describe("threshold math", () => {
  it("load is the WORST dimension (sites, records, bytes, auth users, sessions, email, requests), like SQL site_shard_load", () => {
    expect(shardLoad(shard())).toBe(0);
    expect(shardLoad(shard({ site_count: 1000 }))).toBeCloseTo(0.5);
    expect(shardLoad(shard({ site_count: 10, m_records: 15_000_000 }))).toBeCloseTo(0.75);
    expect(shardLoad(shard({ m_auth_users: 1_800_000 }))).toBeCloseTo(0.9);
    expect(shardLoad(shard({ m_emails_per_hour: 20_000 }))).toBeCloseTo(1);
    expect(shardLoad(shard({ m_bytes: "3221225472" }))).toBeCloseTo(0.5);
    expect(shardLoad(shard({ m_requests_per_min: 30_000, m_unconfigured: ["gateway"] }))).toBe(0);
    expect(shardLoad(shard({ m_cpu_pct: 70, m_unconfigured: ["cpu"] }))).toBe(0);
    expect(shardLoad(shard({ m_cpu_pct: 70, m_unconfigured: ["gateway"] }))).toBeCloseTo(1);
  });

  it("headroom = room left on open shards (to their fill ratio) over open + full capacity; draining/retired/kernel/provisioning do not count", () => {
    expect(envHeadroom([])).toMatchObject({ open: 0, headroom: 0 });
    expect(envHeadroom([shard()]).headroom).toBeCloseTo(1);
    expect(envHeadroom([shard({ site_count: 800 })]).headroom).toBeCloseTo(0.5);
    const fleet = [...Array.from({ length: 10 }, () => shard({ state: "full", site_count: 1700 })), shard({ site_count: 800 })];
    expect(envHeadroom(fleet).headroom).toBeCloseTo(0.4 / 8.8);
    expect(envHeadroom(fleet).open).toBe(1);
    const ignored = [
      shard({ state: "draining" }),
      shard({ state: "retired" }),
      shard({ state: "provisioning", project_ref: null }),
      shard({ name: `zavi-shard-prod-k${"a".repeat(32)}`, dedicated_site_id: "x", state: "full", max_sites: 1, site_count: 1 }),
    ];
    expect(envHeadroom(ignored)).toMatchObject({ open: 0, headroom: 0 });
    expect(envHeadroom([shard({ m_records: 18_000_000 })])).toMatchObject({ open: 0, headroom: 0 });
  });

  it("settings are clamped to the rails whatever the row says", () => {
    expect(normalizeSettings({ enabled: true, thresholdPct: 500, maxPerDay: 99, region: "mars; drop", dryRun: false })).toEqual({ enabled: true, thresholdPct: 90, maxPerDay: 10, region: "us-west-1", dryRun: false });
    expect(normalizeSettings({ enabled: true, thresholdPct: -1, maxPerDay: -5, region: "eu-west-1", dryRun: true })).toMatchObject({ thresholdPct: 1, maxPerDay: 0, region: "eu-west-1" });
  });
});

describe("capacity check (hourly)", () => {
  it("NO open shard (the first prod shard after a deploy): enqueues ONE create of zavi-shard-prod-1 as the canary, and alerts", async () => {
    const { d, sent, alerts, f } = deps([]);
    const r = await capacityCheck(d);
    expect(r).toMatchObject({ action: "enqueued", kind: "create", shard_name: "zavi-shard-prod-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "site-shard-provision:prod:2026-10-01:1", name: "site-shards/provision.requested", data: { env: "prod", n: 1, shard_name: "zavi-shard-prod-1", canary: true, region: "us-west-1", source: "auto" } });
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.auto_create"]);
    expect(alerts[0][1]).toMatch(/no shard is open/);
    expect(f.ledger).toHaveLength(1);
  });

  it("headroom under the threshold provisions the next free number; above it does nothing", async () => {
    const busy = [shard({ name: "zavi-shard-prod-1", site_count: 1500 }), shard({ name: "zavi-shard-prod-3", state: "retired" })];
    const a = deps(busy);
    expect(await capacityCheck(a.d)).toMatchObject({ action: "enqueued", shard_name: "zavi-shard-prod-4" });
    const calm = deps([shard({ name: "zavi-shard-prod-1", site_count: 100 })]);
    expect(await capacityCheck(calm.d)).toMatchObject({ action: "ok" });
    expect(calm.sent).toEqual([]);
    expect(calm.alerts).toEqual([]);
  });

  it("in-progress guard: while one is provisioning, every later tick resumes THAT shard (after the backoff), never a second", async () => {
    const t = deps([]);
    await capacityCheck(t.d);
    for (let i = 0; i < 5; i++) await capacityCheck(t.d);
    expect(t.f.ledger.filter((l) => l.kind === "create")).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
    t.f.advance(31 * 60_000);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "enqueued", kind: "resume", shard_name: "zavi-shard-prod-1" });
    expect(t.f.rows.filter((s) => s.state === "provisioning")).toHaveLength(1);
  });

  it("a shard someone provisions by hand (CLI) is never touched; one notice", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-1", state: "provisioning", project_ref: null })]);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "none", reason: "in_progress_manual" });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "none", reason: "in_progress_manual" });
    expect(t.sent).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_waiting"]);
  });

  it("cap: at most 10 new shards a day; the 11th need is refused with ONE cap alert", async () => {
    const rows: ShardLoadRow[] = [];
    const t = deps(rows);
    for (let i = 0; i < 14; i++) {
      await capacityCheck(t.d);
      const p = rows.find((s) => s.state === "provisioning");
      if (p) Object.assign(p, { state: "open", project_ref: `ref${i}aaaaaaaa`, site_count: 1999 });
    }
    expect(t.f.ledger.filter((l) => l.kind === "create")).toHaveLength(10);
    expect(t.sent).toHaveLength(10);
    expect(t.alerts.filter((a) => a[0] === "sites.shards.auto_cap")).toHaveLength(1);
    expect(t.alerts.filter((a) => a[0] === "sites.shards.auto_create")).toHaveLength(10);
  });

  it("cap setting above 10 is clamped to 10", async () => {
    const rows: ShardLoadRow[] = [];
    const t = deps(rows, { settings: async () => ({ ...SETTINGS, maxPerDay: 50 }) });
    for (let i = 0; i < 15; i++) {
      await capacityCheck(t.d);
      const p = rows.find((s) => s.state === "provisioning");
      if (p) Object.assign(p, { state: "open", project_ref: `ref${i}bbbbbbbb`, site_count: 1999 });
    }
    expect(t.f.ledger.filter((l) => l.kind === "create")).toHaveLength(10);
  });

  it("CONCURRENCY: 20 backends checking at once create exactly ONE shard", async () => {
    const t = deps([]);
    const rs = await Promise.all(Array.from({ length: 20 }, () => capacityCheck(t.d)));
    expect(rs.filter((r) => r.action === "enqueued" && r.kind === "create")).toHaveLength(1);
    expect(t.f.ledger.filter((l) => l.kind === "create")).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
  });

  it("setting OFF: alerts only (once per day), never claims or enqueues", async () => {
    const t = deps([], { settings: async () => ({ ...SETTINGS, enabled: false }) });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "alert_only", reason: "setting_off" });
    await capacityCheck(t.d);
    expect(t.sent).toEqual([]);
    expect(t.f.ledger).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_off"]);
  });

  it("dry run: says what it WOULD create, creates nothing", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-2", site_count: 1900 })], { settings: async () => ({ ...SETTINGS, dryRun: true }) });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "dry_run", would: "create zavi-shard-prod-3 in us-west-1" });
    expect(t.sent).toEqual([]);
    expect(t.f.ledger).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_dry_run"]);
  });

  it("missing provisioning env: no paid project is created (it would only stop later); one alert", async () => {
    const t = deps([], { prereqsMissing: () => ["SUPABASE_MGMT_TOKEN"] });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "alert_only", reason: "prereqs_missing" });
    expect(t.f.ledger).toEqual([]);
    expect(t.alerts[0][1]).toMatch(/SUPABASE_MGMT_TOKEN/);
  });

  it("paused (breaker or staff): no claim, one alert", async () => {
    const t = deps([], {}, { paused: true });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "none", reason: "paused" });
    await capacityCheck(t.d);
    expect(t.sent).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_paused"]);
  });

  it("never throws: a registry outage is a logged skip", async () => {
    const t = deps([], { listShards: async () => { throw new Error("db down"); } });
    expect(await capacityCheck(t.d)).toEqual({ action: "skipped", reason: "check_failed" });
  });
});

describe("deployed backend only", () => {
  it.each([
    [{}, "not_deployed_backend"],
    [{ NODE_ENV: "production" }, "not_deployed_backend"],
    [{ PRAXIS_CONTAINER_ROLE: "probe", NODE_ENV: "production" }, "probe_container"],
    [{ PRAXIS_CONTAINER_ROLE: "canonical", NODE_ENV: "development" }, "not_production"],
    [{ PRAXIS_CONTAINER_ROLE: "dev:laptop", NODE_ENV: "production", PRAXIS_DRAIN_SHARED_QUEUE: "1" }, "not_deployed_backend"],
  ])("%j is refused (%s)", (env, reason) => {
    expect(autoProvisionAllowed(env)).toEqual({ ok: false, reason });
  });

  it("only the canonical production container is allowed", () => {
    expect(autoProvisionAllowed(ENV_OK)).toEqual({ ok: true });
  });

  it("a local / probe backend: the check, the staff request AND the job all refuse before any claim or provision", async () => {
    for (const env of [{ PRAXIS_CONTAINER_ROLE: "probe", NODE_ENV: "production" }, { NODE_ENV: "development" }]) {
      const t = deps([], { allowed: () => autoProvisionAllowed(env) });
      const claim = vi.spyOn(t.f.store, "claim");
      expect((await capacityCheck(t.d)).action).toBe("skipped");
      expect(await requestProvision(t.d, { actor: "ops@zavi", override: false })).toMatchObject({ ok: false, code: "not_deployed_backend" });
      const provision = vi.fn();
      const r = await provisionAttempt({ allowed: () => autoProvisionAllowed(env), stillWanted: async () => null, provision, store: t.f.store, alert: async () => undefined }, { env: "prod", ledger_id: "L1", shard_name: "zavi-shard-prod-1", n: 1, region: "us-west-1", canary: true, source: "auto" }, 6);
      expect(r.status).toBe("refused");
      expect(provision).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(t.sent).toEqual([]);
    }
  });
});

describe("staff create-now", () => {
  it("respects the in-progress guard and the cap; override_cap lifts the cap (still one at a time)", async () => {
    const rows: ShardLoadRow[] = [];
    const t = deps(rows, { settings: async () => ({ ...SETTINGS, maxPerDay: 1 }) });
    expect(await requestProvision(t.d, { actor: "ops@zavi", override: false })).toMatchObject({ ok: true, action: "create", shard_name: "zavi-shard-prod-1" });
    expect(await requestProvision(t.d, { actor: "ops@zavi", override: false })).toMatchObject({ ok: true, action: "resume", shard_name: "zavi-shard-prod-1" });
    Object.assign(rows[0], { state: "open", project_ref: "refaaaaaaaa1" });
    expect(await requestProvision(t.d, { actor: "ops@zavi", override: false })).toMatchObject({ ok: false, code: "cap" });
    expect(await requestProvision(t.d, { actor: "ops@zavi", override: true })).toMatchObject({ ok: true, action: "create", shard_name: "zavi-shard-prod-2", cap_override: true });
    expect(t.f.ledger.filter((l) => l.kind === "create").map((l) => l.override)).toEqual([false, true]);
    expect(t.alerts.some(([c, m]) => c === "sites.shards.auto_create" && /daily-cap override/.test(m))).toBe(true);
  });

  it("dry run applies to the staff button too", async () => {
    const t = deps([], { settings: async () => ({ ...SETTINGS, dryRun: true }) });
    expect(await requestProvision(t.d, { actor: "ops@zavi", override: false })).toEqual({ ok: true, action: "dry_run", would: "create zavi-shard-prod-1" });
    expect(t.f.ledger).toEqual([]);
  });
});

describe("the job + the breaker", () => {
  const EVENT = { env: "prod" as const, ledger_id: "L1", shard_name: "zavi-shard-prod-1", n: 1, region: "us-west-1", canary: true, source: "auto" as const };

  function job(f: ReturnType<typeof fakeStore>, provision: JobDeps["provision"]) {
    const alerts: Array<[string, string]> = [];
    const jd: JobDeps = { allowed: () => autoProvisionAllowed(ENV_OK), stillWanted: async () => null, provision, store: f.store, alert: async (c, m) => void alerts.push([c, m]), log: () => undefined };
    return { jd, alerts };
  }

  it("success: open, the breaker count resets, a completion alert", async () => {
    const rows: ShardLoadRow[] = [];
    const t = deps(rows);
    await capacityCheck(t.d);
    const provision = vi.fn(async () => ({ status: "open" as const, shard: { name: "zavi-shard-prod-1" } }));
    const { jd, alerts } = job(t.f, provision);
    const out = await provisionAttempt(jd, EVENT, 6);
    expect(provision).toHaveBeenCalledWith({ env: "prod", n: 1, region: "us-west-1", canary: true, open: true, healthPolls: 6, holder: "job:L1", source: "auto" });
    expect(out).toEqual({ status: "open", shard: "zavi-shard-prod-1" });
    await finishProvision(jd, EVENT, out as never);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.auto_done"]);
    await finishProvision(jd, EVENT, out as never);
    expect(alerts).toHaveLength(1);
  });

  it("2 failures in a row trip the breaker: auto pauses + alerts; the next tick claims nothing; staff resume re-arms it", async () => {
    const rows: ShardLoadRow[] = [];
    const t = deps(rows);
    const provision = vi.fn(async () => ({ status: "blocked" as const, shard: { name: "zavi-shard-prod-1" }, step: "auth_config", reason: "hook not enabled" }));
    const { jd, alerts } = job(t.f, provision);

    await capacityCheck(t.d);
    const first = t.sent[0].data;
    await finishProvision(jd, first, (await provisionAttempt(jd, first, 6)) as never);
    expect(t.f.state.paused).toBe(false);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.auto_failed"]);

    t.f.advance(31 * 60_000);
    await capacityCheck(t.d);
    const second = t.sent[1].data;
    expect(second.shard_name).toBe("zavi-shard-prod-1");
    await finishProvision(jd, second, (await provisionAttempt(jd, second, 6)) as never);
    expect(t.f.state.paused).toBe(true);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.auto_failed", "sites.shards.auto_failed", "sites.shards.auto_breaker"]);

    t.f.advance(24 * 3600_000);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "none", reason: "paused" });
    expect(t.sent).toHaveLength(2);
    expect(t.f.ledger.filter((l) => l.kind === "create")).toHaveLength(1);

    await t.f.store.setPaused("prod", false, "ops@zavi", null);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "enqueued", kind: "resume" });
  });

  it("a queued job re-checks right before provisioning: paused / off / dry run refuse (staff jobs: dry run only); unreadable = refuse", async () => {
    const st = (paused: boolean) => async () => ({ state: { env: "prod" as const, paused, paused_reason: null, paused_by: null, consecutive_failures: 0, last_attempt_at: null }, day: "d", created_today: 0, ledger: [] });
    const S = async () => SETTINGS;
    expect(await jobStillWanted(EVENT, { settings: S, status: st(false) })).toBeNull();
    expect(await jobStillWanted(EVENT, { settings: S, status: st(true) })).toBe("paused");
    expect(await jobStillWanted(EVENT, { settings: async () => ({ ...SETTINGS, enabled: false }), status: st(false) })).toBe("setting_off");
    expect(await jobStillWanted(EVENT, { settings: async () => ({ ...SETTINGS, dryRun: true }), status: st(false) })).toBe("dry_run");
    expect(await jobStillWanted({ ...EVENT, source: "staff" }, { settings: async () => ({ ...SETTINGS, enabled: false }), status: st(true) })).toBeNull();

    const t = deps([]);
    const provision = vi.fn();
    const { jd } = job(t.f, provision);
    expect(await provisionAttempt({ ...jd, stillWanted: async () => "paused" }, EVENT, 6)).toEqual({ status: "refused", reason: "paused" });
    expect(await provisionAttempt({ ...jd, stillWanted: async () => { throw new Error("db"); } }, EVENT, 6)).toEqual({ status: "refused", reason: "state_unreadable" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("the CLI holding the shard's lease is not a failure: the job steps aside (the breaker does not count it)", async () => {
    const t = deps([]);
    const busy = Object.assign(new Error("busy"), { name: "ShardProvisionBusy" });
    const { jd } = job(t.f, async () => { throw busy; });
    expect(await provisionAttempt(jd, EVENT, 6)).toEqual({ status: "refused", reason: "lease_busy" });
  });

  it("a throw inside provisioning is a recorded failure, not a crash", async () => {
    const t = deps([]);
    await capacityCheck(t.d);
    const { jd } = job(t.f, async () => { throw new Error("more than one project named zavi-shard-prod-1; resolve by hand"); });
    expect(await provisionAttempt(jd, t.sent[0].data, 6)).toMatchObject({ status: "failed", reason: /resolve by hand/ });
  });

  it("refuses an event whose name does not match env + number", async () => {
    const t = deps([]);
    const provision = vi.fn();
    const { jd } = job(t.f, provision);
    expect(await provisionAttempt(jd, { ...EVENT, shard_name: "zavi-shard-prod-9" }, 6)).toMatchObject({ status: "failed" });
    expect(provision).not.toHaveBeenCalled();
  });
});

describe("guard refusals from provisioning", () => {
  const EV = { env: "prod" as const, ledger_id: "L1", shard_name: "zavi-shard-prod-1", n: 1, region: "us-west-1", canary: true, source: "auto" as const };
  function jd(provision: JobDeps["provision"]) {
    const f = fakeStore([]);
    const alerts: Array<[string, string]> = [];
    const d: JobDeps = { allowed: () => autoProvisionAllowed(ENV_OK), stillWanted: async () => null, provision, store: f.store, alert: async (c, m) => void alerts.push([c, m]), log: () => undefined };
    return { d, alerts };
  }
  const blocked = (reason: string) => async () => ({ status: "blocked" as const, shard: { name: "zavi-shard-prod-1" }, step: "project", reason });

  it("an expired lease (ShardNeedsStaff) is refused with ONE alert, never a failure the breaker counts", async () => {
    const { ShardNeedsStaff } = await import("../provision-run");
    const { d, alerts } = jd(async () => { throw new ShardNeedsStaff("zavi-shard-prod-1", "its lease expired"); });
    expect(await provisionAttempt(d, EV, 6)).toEqual({ status: "refused", reason: "guard:needs_staff" });
    await provisionAttempt(d, EV, 6);
    expect(alerts.map((a) => a[0])).toEqual(["sites.shards.auto_needs_staff"]);
  });

  it("a lost create response alerts (reconcile pending); settling / paused just wait; duplicates alert", async () => {
    let r = jd(blocked("guard:uncertain: the create response was lost (supabase create project failed (network))"));
    expect(await provisionAttempt(r.d, EV, 6)).toEqual({ status: "refused", reason: "guard:uncertain" });
    expect(r.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_create_uncertain"]);
    for (const code of ["settling", "paused", "setting_off", "cap", "lease_lost"]) {
      r = jd(blocked(`guard:${code}`));
      expect(await provisionAttempt(r.d, EV, 6)).toEqual({ status: "refused", reason: `guard:${code}` });
      expect(r.alerts).toEqual([]);
    }
    r = jd(blocked("guard:duplicates: 2 projects named zavi-shard-prod-1"));
    expect(await provisionAttempt(r.d, EV, 6)).toEqual({ status: "refused", reason: "guard:duplicates" });
    expect(r.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_needs_staff"]);
  });
});

describe("staff recovery", () => {
  function rd(found: Array<{ ref: string }>) {
    const calls: string[] = [];
    const d = {
      allowed: () => autoProvisionAllowed(ENV_OK),
      listProjectsByName: async () => (calls.push("list"), found),
      adoptRef: async (_n: string, ref: string) => void calls.push(`adopt:${ref}`),
      recover: async (_n: string, f: 0 | 1) => (calls.push(`recover:${f}`), { create_state: f ? "created" : "uncertain" }),
      alert: async () => undefined,
    };
    return { d, calls };
  }
  it("lists by name FIRST, adopts the one project, then clears the guard; never creates", async () => {
    const { staffRecover } = await import("../autoprovision");
    const one = rd([{ ref: "refaaaaaaaa1" }]);
    expect(await staffRecover(one.d, "zavi-shard-prod-1", "ops@zavi")).toMatchObject({ ok: true, outcome: "adopted", ref: "refaaaaaaaa1" });
    expect(one.calls).toEqual(["list", "adopt:refaaaaaaaa1", "recover:1"]);
    const none = rd([]);
    expect(await staffRecover(none.d, "zavi-shard-prod-1", "ops@zavi")).toMatchObject({ ok: true, outcome: "none_found", create_state: "uncertain" });
    const two = rd([{ ref: "a" }, { ref: "b" }]);
    expect(await staffRecover(two.d, "zavi-shard-prod-1", "ops@zavi")).toMatchObject({ ok: false, code: "duplicates" });
    expect(two.calls).toEqual(["list"]);
    const local = rd([]);
    expect(await staffRecover({ ...local.d, allowed: () => autoProvisionAllowed({}) }, "zavi-shard-prod-1", "ops@zavi")).toMatchObject({ ok: false, code: "not_deployed_backend" });
    expect(local.calls).toEqual([]);
  });
});

describe("one implementation: the CLI and the job run the same function", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

  it("the CLI's provision calls runProvisionShard and no longer wires provisionShard itself", () => {
    const cli = read("../../../../scripts/site-shards.ts");
    expect(cli).toMatch(/runProvisionShard\(\{ env, n, region/);
    expect(cli).not.toMatch(/\bprovisionShard\(/);
  });

  it("the job's production deps provision through runProvisionShard", async () => {
    vi.resetModules();
    const run = vi.fn(async () => ({ status: "open", shard: { name: "zavi-shard-prod-1" } }));
    vi.doMock("../provision-run", () => ({ runProvisionShard: run, provisionPrereqsMissing: () => [] }));
    const mod = await import("../autoprovision");
    const jd = await mod.productionJobDeps();
    await jd.provision({ env: "prod", n: 1, region: "us-west-1", canary: true, open: true, healthPolls: 6, source: "auto" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: "prod", n: 1, region: "us-west-1", canary: true, open: true, healthPolls: 6, gate: expect.objectContaining({ source: "auto" }) }));
    expect(typeof jd.stillWanted).toBe("function");
    vi.doUnmock("../provision-run");
  });

  it("the worker calls provisionAttempt with productionJobDeps (event-triggered, retries 0, concurrency 1 per env)", () => {
    const w = read("../../../../workers/functions/site-shard-provision.ts");
    expect(w).toContain("provisionAttempt(await productionJobDeps(), data, 6)");
    expect(w).toContain('retries: 0, concurrency: { limit: 1, key: "event.data.env" }');
    expect(w).toContain("{ event: SHARD_PROVISION_EVENT }");
    expect(w).not.toMatch(/\{ cron:/);
  });
});

describe("S7: warm shards (N+1) and fail-closed metrics", () => {
  const NOW_MS = Date.UTC(2026, 9, 1, 12);
  const STALE_AT = new Date(NOW_MS - 3 * 3600_000).toISOString();
  const none = { placements_1h: 0, placements_24h: 0, lead_time_s: null };

  it("warm target: N = shards the lead-time demand needs, +1 spare; stale / paused / full shards are not warm", () => {
    expect(warmTarget([shard()], none, NOW_MS)).toMatchObject({ demand_sites: 0, need: 1, have: 1, short: false });
    const one = warmTarget([shard()], { placements_1h: 30, placements_24h: 30, lead_time_s: 3600 }, NOW_MS);
    expect(one).toMatchObject({ demand_sites: 60, need: 2, have: 1, short: true });
    expect(warmTarget([shard(), shard()], { placements_1h: 30, placements_24h: 30, lead_time_s: 3600 }, NOW_MS).short).toBe(false);
    expect(warmTarget([shard()], { placements_1h: 0, placements_24h: 48, lead_time_s: 999_999 }, NOW_MS).demand_sites).toBe(96);
    expect(warmTarget([], { placements_1h: 2000, placements_24h: 2000, lead_time_s: 3600 }, NOW_MS).need).toBe(4);
    const rows = [
      shard({ m_gateway_at: STALE_AT }),
      shard({ placement_paused_until: new Date(NOW_MS + 60_000).toISOString() }),
      shard({ placement_paused_until: "infinity" }),
      shard({ site_count: 1600 }),
      shard({ placement_paused_until: new Date(NOW_MS - 60_000).toISOString() }),
    ];
    expect(warmTarget(rows, none, NOW_MS)).toMatchObject({ have: 1, spare_sites: 1600 });
  });

  it("a schema rollout's own short pause is still warm (never buys a shard); an old or foreign pause is not", () => {
    const recent = new Date(NOW_MS - 5 * 60_000).toISOString();
    const old = new Date(NOW_MS - 3 * 3600_000).toISOString();
    const rows = [
      shard({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout in progress (rollout:abc)", placement_paused_at: recent }),
      shard({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout in progress (rollout:abc)", placement_paused_at: old }),
      shard({ placement_paused_until: "infinity", placement_paused_reason: "staff hold", placement_paused_at: recent }),
      shard({ placement_paused_until: "infinity", placement_paused_reason: "schema rollout stopped: 0011 failed", placement_paused_at: recent }),
    ];
    expect(warmTarget(rows, none, NOW_MS)).toMatchObject({ have: 1 });
  });

  it("SOFT (20261016100000): p95 below soft_min_rpm is noise; hard load ignores performance signals", () => {
    expect(shardLoad(shard({ m_p95_ms: 260, m_requests_per_min: 0 }))).toBe(0);
    expect(shardLoad(shard({ m_p95_ms: 260, m_requests_per_min: 60 }))).toBeCloseTo(1.04);
    expect(shardLoad(shard({ m_p95_ms: 260, m_requests_per_min: 5, soft_min_rpm: 5 }))).toBeCloseTo(1.04);
    expect(shardHardLoad(shard({ m_p95_ms: 260, m_requests_per_min: 600, m_cpu_pct: 70 }))).toBe(0);
    expect(shardHardLoad(shard({ site_count: 1000, m_cpu_pct: 70 }))).toBeCloseTo(0.5);
    expect(shardHardLoad(shard({ m_connections: 108 }))).toBeCloseTo(0.9);
  });

  it("SOFT: the only open shard soft-full is no warm headroom, so the hourly check asks for a second pool shard", async () => {
    const softFull = { soft_full_at: new Date(NOW_MS - 20 * 60_000).toISOString(), m_cpu_pct: 66 };
    expect(warmTarget([shard(softFull)], none, NOW_MS)).toMatchObject({ have: 0, need: 1, short: true });
    expect(warmTarget([shard(softFull), shard()], none, NOW_MS)).toMatchObject({ have: 1, short: false });
    const spike = deps([shard({ name: "zavi-shard-prod-1", site_count: 10, m_cpu_pct: 69, m_requests_per_min: 600, m_p95_ms: 240 })]);
    expect(await capacityCheck(spike.d)).toMatchObject({ action: "ok" });
    expect(spike.sent).toEqual([]);
    expect(envHeadroom([shard({ ...softFull })])).toMatchObject({ open: 1, headroom: 0 });
    const t = deps([shard({ name: "zavi-shard-prod-1", site_count: 10, ...softFull })]);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "enqueued", kind: "create", shard_name: "zavi-shard-prod-2" });
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_create"]);
    expect(t.alerts[0][1]).toMatch(/paid Supabase project/);
  });

  it("a short warm pool provisions even when headroom is above the threshold, and says why", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-1", site_count: 10 })], { capacityInputs: async () => ({ placements_1h: 40, placements_24h: 100, lead_time_s: 1800 }) });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "enqueued", kind: "create", shard_name: "zavi-shard-prod-2" });
    expect(t.alerts[0][1]).toMatch(/warm shards 1 < 2.*30-min provisioning lead time/);
  });

  it("an unreadable capacity input falls back to a zero rate (one warm shard), never throws", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-1", site_count: 10 })], { capacityInputs: async () => { throw new Error("rpc down"); } });
    expect(await capacityCheck(t.d)).toMatchObject({ action: "ok" });
  });

  it("BLIND: an open shard with stale metrics -> alert once, never buy shards blind", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-1", m_cpu_at: STALE_AT }), shard({ name: "zavi-shard-prod-2", state: "full", m_db_at: null })]);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "alert_only", reason: "metrics_stale" });
    await capacityCheck(t.d);
    expect(t.sent).toEqual([]);
    expect(t.f.ledger).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_blind"]);
  });

  it("a stale FULL shard next to a fresh open one: judged on the fresh one only", async () => {
    const t = deps([shard({ name: "zavi-shard-prod-1", state: "full", m_db_at: STALE_AT }), shard({ name: "zavi-shard-prod-2", site_count: 10 })]);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "ok" });
    expect(envHeadroom([shard({ m_db_at: STALE_AT }), shard()], { nowMs: NOW_MS })).toMatchObject({ open: 1, stale: 1 });
  });

  it("a just-opened, never-measured shard counts as room (below the 25-site allowance): no extra buy", async () => {
    const rows = [
      shard({ name: "zavi-shard-prod-1", state: "full", site_count: 1700 }),
      shard({ name: "zavi-shard-prod-2", m_db_at: null, m_gateway_at: null, m_cpu_at: null, created_at: new Date(Date.UTC(2026, 9, 1, 11)).toISOString() }),
    ];
    const t = deps(rows);
    expect(await capacityCheck(t.d)).toMatchObject({ action: "ok" });
    expect(t.f.ledger).toEqual([]);
  });

  it("NO LOOP: a shard past the allowance whose sweeps keep failing (stale) next to full fresh shards buys nothing more", async () => {
    const rows = [
      shard({ name: "zavi-shard-prod-1", state: "full", site_count: 1700 }),
      shard({ name: "zavi-shard-prod-2", site_count: 30, m_db_at: null, m_gateway_at: null, m_cpu_at: null }),
    ];
    const t = deps(rows);
    for (let i = 0; i < 5; i++) expect(await capacityCheck(t.d)).toMatchObject({ action: "alert_only", reason: "metrics_stale" });
    expect(t.f.ledger).toEqual([]);
    expect(t.alerts.map((a) => a[0])).toEqual(["sites.shards.auto_blind"]);
    expect(t.alerts[0][1]).toMatch(/zavi-shard-prod-2/);
  });

  it("a shard that just opened is measured at once (placement needs fresh metrics)", async () => {
    const t = deps([]);
    await capacityCheck(t.d);
    const measured: string[] = [];
    const jd: JobDeps = {
      allowed: () => autoProvisionAllowed(ENV_OK), stillWanted: async () => null,
      provision: async () => ({ status: "open" as const, shard: { name: "zavi-shard-prod-1" } }),
      store: t.f.store, alert: async () => undefined, log: () => undefined,
      afterOpen: async () => void measured.push("sweep"),
    };
    const ev = { env: "prod" as const, ledger_id: "L1", shard_name: "zavi-shard-prod-1", n: 1, region: "us-west-1", canary: true, source: "auto" as const };
    await finishProvision(jd, ev, (await provisionAttempt(jd, ev, 6)) as never);
    expect(measured).toEqual(["sweep"]);
    const jd2 = { ...jd, afterOpen: async () => { throw new Error("mgmt down"); } };
    const t2 = deps([]);
    await capacityCheck(t2.d);
    await expect(finishProvision({ ...jd2, store: t2.f.store }, ev, { status: "open", shard: "zavi-shard-prod-1" })).resolves.toMatchObject({ status: "open" });
  });
});

