import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  envHeadroom,
  isPooledShard,
  isValidationShard,
  provisionAttempt,
  type AutoProvStore,
  type CheckDeps,
  type Claim,
  type JobDeps,
  type ShardLoadRow,
} from "../autoprovision";
import { provisionShard } from "../provision";
import type { ShardRow } from "../contract";
import { isWarmValidation, validationCapacityCheck, validationRegions, VALIDATION_WARM_TARGET } from "../validation-capacity";
import { world } from "./provision-world";

let n = 0;
function row(over: Partial<ShardLoadRow> & Record<string, unknown> = {}): ShardLoadRow & { provision_step?: string } {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `zavi-shard-prod-${n}`, state: "open", project_ref: `ref${String(n).padStart(17, "0")}`, region: "us-west-1",
    site_count: 0, max_sites: 2000, fill_ratio: 0.8, provision_step: "done", purpose: "pool", ...over,
  } as ShardLoadRow & { provision_step?: string };
}

const SQL = readFileSync(join(__dirname, "../../../../../../supabase/migrations/20261012050000_site_validation_shards_test_sites.sql"), "utf8");

describe("validation shards are never customer capacity", () => {
  it("isPooledShard excludes validation shards; envHeadroom ignores them", () => {
    const v = row({ purpose: "validation", state: "full" });
    const p = row({ state: "open" });
    expect(isPooledShard(v)).toBe(false);
    expect(isValidationShard(v)).toBe(true);
    expect(isPooledShard(p)).toBe(true);
    expect(isPooledShard({ name: "zavi-shard-prod-9" })).toBe(true);
    expect(envHeadroom([p, v])).toEqual(envHeadroom([p]));
  });

  it("the migration fences them at every placement path", () => {
    expect(SQL).toMatch(/constraint site_shards_validation_never_open\s+check \(purpose <> 'validation' or \(state <> 'open' and dedicated_site_id is null\)\)/);
    const place = SQL.slice(SQL.indexOf("create or replace function public.site_backend_place"), SQL.indexOf("-- ── site_shard_record_metrics"));
    expect(place.match(/sh\.purpose = 'pool'/g)?.length).toBe(3);
    expect(place).toMatch(/if v_shard\.purpose <> 'pool' then/);
    const metrics = SQL.slice(SQL.indexOf("create or replace function public.site_shard_record_metrics"), SQL.indexOf("-- ── site_shard_autoprov_claim"));
    expect(metrics.match(/v_row\.purpose = 'pool'/g)?.length).toBe(2);
    const dir = SQL.slice(SQL.indexOf("create or replace function public.site_auth_directory"));
    expect(dir).toMatch(/sh\.purpose = 'validation'/);
    expect(dir).toMatch(/t\.state in \('creating', 'active'\) and t\.expires_at > now\(\)/);
    const create = SQL.slice(SQL.indexOf("create or replace function public.site_test_site_create"), SQL.indexOf("-- The row + its shard handle"));
    expect(create).toMatch(/sh\.purpose = 'validation' and sh\.state = 'full'/);
    const fns = [...SQL.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    for (const f of fns) expect(SQL, f).toMatch(new RegExp(`revoke all on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated;`));
  });
});

describe("warm validation capacity (N+1 per region)", () => {
  it("counts only serving validation shards with room", () => {
    expect(isWarmValidation(row({ purpose: "validation", state: "full" }))).toBe(true);
    expect(isWarmValidation(row({ purpose: "validation", state: "provisioning" }))).toBe(false);
    expect(isWarmValidation(row({ purpose: "validation", state: "full", site_count: 2000 }))).toBe(false);
    expect(isWarmValidation(row({ purpose: "validation", state: "full", provision_step: "schema" }))).toBe(false);
    expect(isWarmValidation(row({ state: "full" }))).toBe(false);
  });

  it("regions = every serving customer region + the configured one", () => {
    const rows = [row({ region: "us-east-1" }), row({ purpose: "validation", state: "full", region: "us-east-1" }), row({ region: "eu-west-2", state: "retired" })];
    expect(validationRegions(rows, "us-west-1")).toEqual([
      { region: "us-east-1", serving: 1, warm: 1, target: VALIDATION_WARM_TARGET },
      { region: "us-west-1", serving: 0, warm: 0, target: VALIDATION_WARM_TARGET },
    ]);
  });
});

function checkDeps(rows: ShardLoadRow[], over: Partial<CheckDeps> = {}, claim?: Claim) {
  const claims: Array<Parameters<AutoProvStore["claim"]>[0]> = [];
  const sent: unknown[] = [];
  const alerts: string[] = [];
  const store = {
    claim: vi.fn(async (i: Parameters<AutoProvStore["claim"]>[0]) => {
      claims.push(i);
      return claim ?? ({ action: "create", ledger_id: "L1", day: "2026-10-01", seq: 1, shard_name: "zavi-shard-prod-9", n: 9, region: i.region, canary: false, created_today: 1, purpose: "validation" } as Claim);
    }),
    notice: vi.fn(async () => true),
  } as unknown as AutoProvStore;
  const deps: CheckDeps = {
    env: "prod",
    allowed: () => ({ ok: true }),
    listShards: async () => rows,
    settings: async () => ({ enabled: true, thresholdPct: 20, maxPerDay: 10, region: "us-west-1", dryRun: false }),
    prereqsMissing: () => [],
    store,
    send: async (e) => {
      sent.push(e);
    },
    alert: async (code, msg) => {
      alerts.push(`${code}: ${msg}`);
    },
    log: () => undefined,
    now: () => Date.parse("2026-10-01T12:00:00Z"),
    ...over,
  };
  return { deps, claims, sent, alerts };
}

describe("validationCapacityCheck", () => {
  it("claims ONE validation shard in the short region through the shared rails and alerts", async () => {
    const t = checkDeps([row(), row({ purpose: "validation", state: "full" })]);
    const r = await validationCapacityCheck(t.deps);
    expect(r).toMatchObject({ action: "enqueued", kind: "create", region: "us-west-1" });
    expect(t.claims).toEqual([expect.objectContaining({ purpose: "validation", region: "us-west-1", source: "auto", maxPerDay: 10 })]);
    expect(t.sent).toEqual([expect.objectContaining({ data: expect.objectContaining({ purpose: "validation", shard_name: "zavi-shard-prod-9" }) })]);
    expect(t.alerts.join()).toMatch(/sites\.shards\.validation_create.*never placeable/);
  });

  it("does nothing with N+1 warm, or while any shard is provisioning", async () => {
    const warm = checkDeps([row(), row({ purpose: "validation", state: "full" }), row({ purpose: "validation", state: "full" })]);
    expect((await validationCapacityCheck(warm.deps)).action).toBe("ok");
    const busy = checkDeps([row(), row({ state: "provisioning", project_ref: null })]);
    expect(await validationCapacityCheck(busy.deps)).toMatchObject({ action: "none", reason: "in_progress" });
    expect(warm.claims.length + busy.claims.length).toBe(0);
  });

  it("honors the off switch, dry run, prerequisites and the deployed-backend guard (no claim)", async () => {
    const off = checkDeps([row()], { settings: async () => ({ enabled: false, thresholdPct: 20, maxPerDay: 10, region: "us-west-1", dryRun: false }) });
    expect((await validationCapacityCheck(off.deps)).action).toBe("alert_only");
    const dry = checkDeps([row()], { settings: async () => ({ enabled: true, thresholdPct: 20, maxPerDay: 10, region: "us-west-1", dryRun: true }) });
    expect((await validationCapacityCheck(dry.deps)).action).toBe("dry_run");
    const pre = checkDeps([row()], { prereqsMissing: () => ["SUPABASE_MGMT_TOKEN"] });
    expect((await validationCapacityCheck(pre.deps)).action).toBe("alert_only");
    const guard = checkDeps([row()], { allowed: () => ({ ok: false, reason: "probe_container" }) });
    expect(await validationCapacityCheck(guard.deps)).toEqual({ action: "skipped", reason: "probe_container" });
    expect(off.claims.length + dry.claims.length + pre.claims.length + guard.claims.length).toBe(0);
  });

  it("the daily cap stops it (alert once), and it never throws", async () => {
    const cap = checkDeps([row()], {}, { action: "none", reason: "cap", created_today: 10, cap: 10 });
    expect(await validationCapacityCheck(cap.deps)).toMatchObject({ action: "none", reason: "cap" });
    expect(cap.alerts.join()).toMatch(/validation_cap/);
    const broken = checkDeps([row()], { listShards: async () => { throw new Error("db down"); } });
    expect(await validationCapacityCheck(broken.deps)).toEqual({ action: "skipped", reason: "check_failed" });
  });
});

describe("provisioning a validation shard", () => {
  it("finishes it as 'full' (validationReady) and never opens it", async () => {
    const w = world();
    const reg = w.deps.registry as unknown as Record<string, unknown>;
    const register = reg.register as (i: unknown) => Promise<ShardRow>;
    reg.register = async (i: unknown) => ({ ...(await register(i)), purpose: "validation" });
    const ready = vi.fn(async (id: string) => ({ ...w.row, id, state: "full" as const, purpose: "validation" as const }));
    reg.validationReady = ready;
    const update = reg.update as (id: string, p: Record<string, unknown>) => Promise<ShardRow>;
    reg.update = async (id: string, p: Record<string, unknown>) => ({ ...(await update(id, p)), purpose: "validation" });
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1", open: true });
    expect(r.status).toBe("ready");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(w.regUpdates.some((p) => p.state === "open")).toBe(false);
  });

  it("the job asks for a never-opened shard when the claim is a validation one", async () => {
    const provision = vi.fn(async () => ({ status: "ready" as const, shard: { name: "zavi-shard-prod-9" } }));
    const deps = { allowed: () => ({ ok: true }), stillWanted: async () => null, provision, store: {} as AutoProvStore, alert: async () => undefined } as unknown as JobDeps;
    await provisionAttempt(deps, { env: "prod", ledger_id: "L1", shard_name: "zavi-shard-prod-9", n: 9, region: "us-west-1", canary: false, source: "auto", purpose: "validation" }, 1);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ open: false }));
    await provisionAttempt(deps, { env: "prod", ledger_id: "L2", shard_name: "zavi-shard-prod-9", n: 9, region: "us-west-1", canary: false, source: "auto" }, 1);
    expect(provision).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
  });
});
