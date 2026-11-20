import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, validateManifest } from "../../manifest";
import { DevStore } from "../../files/src/zavi/devstore";
import { MANIFEST, MEMBERS, STEPS, VALIDATOR_CASES } from "./scenarios";
import { replay, type Engine, type Outcome } from "./replay";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixture.json"), "utf-8")) as {
  generated_from: { migrations: string[]; sha256: string };
  steps: Outcome[];
  validator: Array<{ name: string; sql_accepts: boolean }>;
};

function devEngine(): Engine {
  const canon = validateManifest(MANIFEST);
  if (!canon.ok) throw new Error(JSON.stringify(canon.issues));
  let n = 0;
  let t = Date.UTC(2026, 9, 1);
  const store = new DevStore({
    manifest: canon.value,
    now: () => (t += 7),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  for (const m of MEMBERS) store.setMember(m.id, m.role, m.status ?? "active");
  const wrap = <T>(f: () => T) => Promise.resolve().then(f);
  return {
    create: (c, col, data, key) => wrap(() => store.create(c, col, data, key)),
    get: (c, col, id) => wrap(() => store.get(c, col, id)),
    list: (c, col, filter, limit, cursor, sort) => wrap(() => store.list(c, col, { filter, limit, cursor, sort })),
    update: (c, col, id, patch) => wrap(() => store.update(c, col, id, patch)),
    delete: (c, col, id) => wrap(() => store.delete(c, col, id)),
  };
}

describe("dev mode parity with the shard SQL (fixture.json)", () => {
  it("the fixture covers every step of the script (regenerate it after editing scenarios.ts)", () => {
    expect(fixture.steps).toHaveLength(STEPS.length);
    expect(fixture.generated_from.migrations).toEqual(expect.arrayContaining(["0001_core.sql", "0002_api.sql", "0004_membership_slots_perf.sql"]));
  });

  it("the script exercises both allows and refusals of every kind", () => {
    const reasons = new Set(fixture.steps.filter((s) => !s.ok).map((s) => (s as { reason: string }).reason.split(":")[0]));
    for (const r of ["rls", "not_found", "anonymous_write_forbidden", "filter_not_allowed", "sort_not_allowed", "invalid_filter",
      "invalid_cursor", "idempotency_key_required", "idempotency_conflict", "idempotency_key_invalid", "field_not_writable",
      "schema_violation", "unknown_collection", "invalid_patch"]) {
      expect(reasons, r).toContain(r);
    }
    expect(fixture.steps.filter((s) => s.ok).length).toBeGreaterThan(50);
  });

  it("every step: same outcome as the shard", async () => {
    const dev = await replay(devEngine());
    const diffs = dev
      .map((d, i) => ({ i, step: STEPS[i], shard: fixture.steps[i], dev: d }))
      .filter((x) => canonicalJson(x.shard) !== canonicalJson(x.dev));
    if (process.env.PARITY_DUMP) require("node:fs").writeFileSync(process.env.PARITY_DUMP, JSON.stringify(diffs, null, 1));
    expect(diffs.map((d) => d.i)).toEqual([]);
  });
});

describe("manifest validator parity with the shard CHECK (fixture.json)", () => {
  it.each(VALIDATOR_CASES.map((v) => [v.name, v] as const))("%s", (_n, v) => {
    const sql = fixture.validator.find((x) => x.name === v.name);
    expect(sql, "regenerate fixture.json").toBeDefined();
    const def: Record<string, unknown> = { rules: v.rules };
    if (v.kind) def.kind = v.kind;
    if (v.schema !== undefined) def.schema = v.schema;
    if (v.fields !== undefined) def.fields = v.fields;
    const ts = validateManifest({ schemaVersion: 1, collections: { [`v_${v.name}`]: def } }).ok;
    if (v.stricter) {
      expect(ts).toBe(false);
    } else {
      expect(ts).toBe(sql!.sql_accepts);
    }
  });
});
