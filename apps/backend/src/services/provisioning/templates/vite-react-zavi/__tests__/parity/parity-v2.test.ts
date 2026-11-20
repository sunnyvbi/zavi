import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, validateManifest } from "../../manifest";
import { DevStore } from "../../files/src/zavi/devstore";
import { CALLERS_V2, MANIFEST_V2, MEMBERS_V2, STEPS_V2 } from "./scenarios-v2";
import { replay, type Engine, type Outcome } from "./replay";

const FIXTURE = join(__dirname, "fixture-v2.json");
const fixture = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, "utf-8")) as { generated_from: { migrations: string[] }; steps: Outcome[] })
  : null;

function devEngine(): Engine {
  const canon = validateManifest(MANIFEST_V2);
  if (!canon.ok) throw new Error(JSON.stringify(canon.issues));
  let n = 0;
  let t = Date.UTC(2026, 9, 1);
  const store = new DevStore({
    manifest: canon.value,
    now: () => (t += 7),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  for (const m of MEMBERS_V2) store.setMember(m.id, m.role, m.status ?? "active");
  const wrap = <T>(f: () => T) => Promise.resolve().then(f);
  return {
    create: (c, col, data, key) => wrap(() => store.create(c, col, data, key)),
    get: (c, col, id) => wrap(() => store.get(c, col, id)),
    list: (c, col, filter, limit, cursor, sort) => wrap(() => store.list(c, col, { filter, limit, cursor, sort })),
    update: (c, col, id, patch) => wrap(() => store.update(c, col, id, patch)),
    delete: (c, col, id) => wrap(() => store.delete(c, col, id)),
    transition: (c, col, id, to) => wrap(() => store.transition(c, col, id, to)),
    action: (c, name, target, record, data, key) => wrap(() => store.runAction(c, name, { targetId: target, recordId: record, data }, key)),
    aggregate: (c, name, filter) => wrap(() => store.aggregate(c, name, filter)),
  };
}

describe("relational kernel: the parity script", () => {
  it("runs on dev mode and exercises every kernel refusal", async () => {
    const dev = await replay(devEngine(), STEPS_V2, CALLERS_V2);
    const reasons = new Set(dev.filter((s) => !s.ok).map((s) => (s as { reason: string }).reason.split(":")[0]));
    for (const r of ["invalid_reference", "unique_conflict", "transition_conflict", "action_bound", "idempotency_conflict",
      "action_not_allowed", "aggregate_not_allowed", "invalid_action_input", "invalid_idempotency_key", "idempotency_key_required",
      "field_not_writable", "reference_restricted", "not_found", "rls", "filter_not_allowed", "invalid_filter", "schema_violation"]) {
      expect(reasons, r).toContain(r);
    }
    expect(dev.filter((s) => s.ok).length).toBeGreaterThan(40);
  });

  it.skipIf(!fixture)("every step: same outcome as the shard (fixture-v2.json)", async () => {
    expect(fixture!.steps).toHaveLength(STEPS_V2.length);
    expect(fixture!.generated_from.migrations).toEqual(expect.arrayContaining(["0006_contract_v2.sql", "0007_relational_slots_rls.sql", "0008_relational_api.sql"]));
    const dev = await replay(devEngine(), STEPS_V2, CALLERS_V2);
    const diffs = dev
      .map((d, i) => ({ i, step: STEPS_V2[i], shard: fixture!.steps[i], dev: d }))
      .filter((x) => canonicalJson(x.shard) !== canonicalJson(x.dev));
    if (process.env.PARITY_DUMP) require("node:fs").writeFileSync(process.env.PARITY_DUMP, JSON.stringify(diffs, null, 1));
    expect(diffs.map((d) => d.i)).toEqual([]);
  });
});
