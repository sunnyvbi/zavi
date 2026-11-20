
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  shadowSig,
  isShadowReadAllowedByName,
  type ShadowToolResult,
} from "@/services/agents/engine/shadow-tool-policy";
import { HarnessFailure } from "@/services/eval/shadow-harness";

export type EvidenceRecord = {
  tenant_id: string;
  tool_name: string;
  input: unknown;
  content: string;
  is_error: boolean;
};

export type BenchCohort = "role" | "channel";

export type ProdReference = {
  run_id: string;
  model_used: string;
  date: string;
  repo: string;
  start_sha: string;
  head_sha: string;
  source: "shipped_commit" | "branch_merge_base";
  summary: string;
  diff: string;
  typecheck_ok: boolean | null;
  tests_failed: number | null;
};

export type TaskFixture = {
  fixture_version: number;
  task_id: string;
  tenant_id: string;
  company: string;
  agent_slug: string;
  unit: string;
  cohort: BenchCohort;
  source_run_id: string;
  input: {
    trigger: string;
    payload: unknown;
    prompt: { system: string; initial_user: string };
  };
  evidence: EvidenceRecord[];
  pinned_sha?: string;
  filled_by: string[];
  prod_reference?: ProdReference;
  expected?: unknown;
};

export function hashFixture(f: TaskFixture): string {
  return createHash("sha256").update(stableJson(f)).digest("hex").slice(0, 16);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

export function assertFixtureTenant(f: TaskFixture, activeTenant: string): void {
  if (f.tenant_id !== activeTenant) {
    throw new HarnessFailure(
      `fixture ${f.task_id} belongs to tenant ${f.tenant_id}, active run is ${activeTenant}`,
    );
  }
  for (const r of f.evidence) {
    if (r.tenant_id !== activeTenant) {
      throw new HarnessFailure(
        `fixture ${f.task_id} carries an evidence record for tenant ${r.tenant_id}; ` +
          `active tenant is ${activeTenant}. Refusing the whole fixture.`,
      );
    }
  }
}

export function fixtureToShadowMap(
  f: TaskFixture,
  activeTenant: string,
): Map<string, ShadowToolResult[]> {
  assertFixtureTenant(f, activeTenant);
  const map = new Map<string, ShadowToolResult[]>();
  for (const r of f.evidence) {
    if (!isShadowReadAllowedByName(r.tool_name)) continue;
    const sig = shadowSig(r.tool_name, r.input);
    const q = map.get(sig) ?? [];
    q.push({ content: r.content, is_error: r.is_error });
    map.set(sig, q);
  }
  return map;
}

export function mergeFillCaptures(
  tenantId: string,
  perModel: ReadonlyArray<ReadonlyArray<EvidenceRecord>>,
): EvidenceRecord[] {
  const best = new Map<string, EvidenceRecord[]>();
  const order: string[] = [];
  for (const recs of perModel) {
    const local = new Map<string, EvidenceRecord[]>();
    for (const r of recs) {
      if (r.tenant_id !== tenantId) {
        throw new HarnessFailure(
          `fill capture for tenant ${r.tenant_id} while building tenant ${tenantId}`,
        );
      }
      const sig = shadowSig(r.tool_name, r.input);
      const arr = local.get(sig) ?? [];
      arr.push(r);
      local.set(sig, arr);
    }
    for (const [sig, arr] of local) {
      if (!best.has(sig)) order.push(sig);
      if ((best.get(sig)?.length ?? 0) < arr.length) best.set(sig, arr);
    }
  }
  return order.flatMap((s) => best.get(s) ?? []);
}

export const DEFAULT_BENCH_DIR = resolve(process.cwd(), ".model-bench");

export function ensureBenchDir(dir: string = DEFAULT_BENCH_DIR): string {
  for (const d of [dir, join(dir, "fixtures"), join(dir, "runs")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  return dir;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

export function writeFixture(f: TaskFixture, dir: string = DEFAULT_BENCH_DIR): string {
  ensureBenchDir(dir);
  const p = join(dir, "fixtures", `${safeName(f.tenant_id)}__${safeName(f.task_id)}.json`);
  writeFileSync(p, JSON.stringify(f, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

const TMP_PREFIX = ".tmp-";
const TMP_SUFFIX = ".partial";

export function replaceTenantFixtures(
  tenantId: string,
  fixtures: ReadonlyArray<TaskFixture>,
  dir: string = DEFAULT_BENCH_DIR,
  requiredFilledBy: ReadonlyArray<string> = [],
  scopeUnits?: ReadonlySet<string> | null,
  noSubstantiveUnits?: ReadonlySet<string>,
): { written: string[]; keptStale: TaskFixture[]; droppedStale: TaskFixture[] } {
  for (const f of fixtures) {
    if (f.tenant_id !== tenantId) {
      throw new HarnessFailure(`replaceTenantFixtures(${tenantId}) given a fixture for ${f.tenant_id}`);
    }
  }
  ensureBenchDir(dir);
  const fdir = join(dir, "fixtures");
  const keep = new Set<string>();
  for (const f of fixtures) {
    const name = `${safeName(f.tenant_id)}__${safeName(f.task_id)}.json`;
    const tmp = join(fdir, `${TMP_PREFIX}${process.pid}-${name}${TMP_SUFFIX}`);
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(fdir, name));
    keep.add(name);
  }
  const rebuiltUnits = new Set(fixtures.map((f) => `${f.cohort}:${f.unit}`));
  const prefix = `${safeName(tenantId)}__`;
  const keptStale: TaskFixture[] = [];
  const droppedStale: TaskFixture[] = [];
  for (const n of readdirSync(fdir)) {
    if (n.startsWith(TMP_PREFIX)) {
      rmSync(join(fdir, n), { force: true });
      continue;
    }
    if (!n.startsWith(prefix) || !n.endsWith(".json") || keep.has(n)) continue;
    const old = JSON.parse(readFileSync(join(fdir, n), "utf8")) as TaskFixture;
    if (scopeUnits && scopeUnits.size > 0 && !scopeUnits.has(old.unit)) continue;
    if (rebuiltUnits.has(`${old.cohort}:${old.unit}`) || noSubstantiveUnits?.has(old.unit)) rmSync(join(fdir, n), { force: true });
    else if (requiredFilledBy.every((k) => old.filled_by.includes(k))) keptStale.push(old);
    else {
      rmSync(join(fdir, n), { force: true });
      droppedStale.push(old);
    }
  }
  return { written: [...keep], keptStale, droppedStale };
}

export function loadFixtures(dir: string = DEFAULT_BENCH_DIR): TaskFixture[] {
  const fdir = join(dir, "fixtures");
  if (!existsSync(fdir)) return [];
  return readdirSync(fdir)
    .filter((n) => n.endsWith(".json") && !n.startsWith(TMP_PREFIX))
    .map((n) => {
      const f = JSON.parse(readFileSync(join(fdir, n), "utf8")) as TaskFixture;
      assertFixtureTenant(f, f.tenant_id);
      return f;
    });
}

export type NoSubstantiveEntry = { company: string; unit: string };

const coveragePath = (dir: string) => join(dir, "no-substantive-run.json");

export function loadNoSubstantive(dir: string = DEFAULT_BENCH_DIR): NoSubstantiveEntry[] {
  const p = coveragePath(dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as NoSubstantiveEntry[]) : [];
}

export function saveNoSubstantive(
  scanned: { companies: ReadonlyArray<string>; units: ReadonlySet<string> | null },
  found: ReadonlyArray<NoSubstantiveEntry>,
  dir: string = DEFAULT_BENCH_DIR,
): void {
  ensureBenchDir(dir);
  const wasScanned = (e: NoSubstantiveEntry) =>
    scanned.companies.includes(e.company) && (!scanned.units || scanned.units.has(e.unit));
  const next = [...loadNoSubstantive(dir).filter((e) => !wasScanned(e)), ...found];
  writeFileSync(coveragePath(dir), JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(coveragePath(dir), 0o600);
}

export function clearFixtures(dir: string = DEFAULT_BENCH_DIR): void {
  rmSync(dir, { recursive: true, force: true });
}
