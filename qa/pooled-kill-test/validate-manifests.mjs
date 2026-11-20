import { readFileSync, writeFileSync } from "node:fs";
import { KIT, loadReal, MANIFEST_PKG, validatorSupportsV2 } from "./lib/paths.mjs";
import { lintV2, v1Projection } from "./lib/contract-v2.mjs";

const { validateManifest } = await loadReal();
const v2 = validatorSupportsV2(validateManifest);
const compat = JSON.parse(readFileSync(`${KIT}/compat.json`, "utf8"));
const out = {
  validator: MANIFEST_PKG,
  source: process.env.KK_SRC_LABEL ?? null,
  mode: v2 ? "real v2 validator" : "PENDING K3 VALIDATOR: real v1 validator on a v1 projection + contract lint (lib/contract-v2.mjs)",
  at: new Date().toISOString(),
  sites: [],
  attack_site: null,
};
let bad = 0;

function check(file) {
  const text = readFileSync(file, "utf8");
  const man = JSON.parse(text);
  const lint = lintV2(man);
  if (v2) {
    const r = validateManifest(text);
    const res = r.ok ? { verdict: "valid", hash: r.hash } : { verdict: "invalid", issues: r.issues };
    if (r.ok && lint.length) res.lint_disagrees = lint;
    return res;
  }
  const base = validateManifest(v1Projection(man));
  const issues = [...(base.ok ? [] : base.issues.map((i) => ({ ...i, by: "real v1 validator" }))), ...lint.map((i) => ({ ...i, by: "contract lint" }))];
  return issues.length ? { verdict: "invalid", issues } : { verdict: "pending_k3_validator" };
}

for (const site of compat.sites) {
  const res = check(`${KIT}/sites/${site.n}/zavi-site.json`);
  out.sites.push({ n: site.n, ...res });
  const expect = v2 ? "valid" : "pending_k3_validator";
  if (res.verdict !== expect) { bad++; console.error(`site ${site.n}: ${res.verdict} (expected ${expect})`); }
}
out.attack_site = check(`${KIT}/attack-site.zavi-site.json`);
if (out.attack_site.verdict === "invalid") bad++;

const col = (extra = {}) => ({ kind: "records", rules: { list: ["admin"], get: ["admin"], create: ["signed_in"], update: ["admin"], delete: ["admin"] }, schema: { type: "object", properties: { a: { type: "string", maxLength: 5 }, r: { type: "string", maxLength: 36, format: "uuid" }, n: { type: "integer", minimum: 0, maximum: 9 }, s: { type: "string", maxLength: 1, enum: ["x", "y"] } }, required: ["r", "s"] }, fields: {}, indexes: {}, unique: [], references: {}, ...extra });
const v2m = (collections, extra = {}) => ({ schemaVersion: 2, roles: [], capabilities: [], actions: {}, aggregates: {}, collections, ...extra });
const mustFail = {
  v1_anyone_update: { schemaVersion: 1, collections: { x: { rules: { update: ["anyone"] }, schema: { type: "object", properties: { a: { type: "string", maxLength: 5 } } } } } },
  v1_unbounded_string: { schemaVersion: 1, collections: { x: { rules: {}, schema: { type: "object", properties: { a: { type: "string" } } } } } },
  v1_reserved_field: { schemaVersion: 1, collections: { x: { rules: {}, schema: { type: "object", properties: { owner_id: { type: "string", maxLength: 36 } } } } } },
  recipient_without_recipient_config: v2m({ x: col({ rules: { list: ["recipient"], get: ["admin"], create: ["signed_in"], update: ["admin"], delete: ["admin"] } }) }),
  recipient_on_create: v2m({ t: col(), x: col({ rules: { list: ["admin"], get: ["admin"], create: ["recipient"], update: ["admin"], delete: ["admin"] }, recipient: { reference: "r" }, references: { r: { collection: "t", on_delete: "restrict" } } }) }),
  role_not_allowlisted: v2m({ x: col({ rules: { list: ["role:ghost"], get: ["admin"], create: ["signed_in"], update: ["admin"], delete: ["admin"] } }) }),
  reference_cycle: v2m({ x: col({ references: { r: { collection: "y", on_delete: "restrict" } } }), y: col({ references: { r: { collection: "x", on_delete: "restrict" } } }) }),
  state_enum_mismatch: v2m({ x: col({ states: { field: "s", values: ["x", "z"], initial: "x", transitions: [] } }) }),
  aggregate_signed_in: v2m({ x: col() }, { aggregates: { c: { collection: "x", fn: "count", principals: ["signed_in"] } } }),
  unknown_capability: v2m({ x: col() }, { capabilities: ["telepathy"] }),
  counter_not_integer: v2m({ t: col(), x: col({ references: { r: { collection: "t", on_delete: "restrict" } } }) }, { actions: { go: { target: { collection: "t", counter: "a" }, delta: 1, initial: 0, bounds: { min: 0, max: 5 }, creates: { collection: "x", targetField: "r" }, principals: ["signed_in"], idempotency: "required" } } }),
  nullify_required: v2m({ t: col(), x: col({ references: { r: { collection: "t", on_delete: "nullify" } } }) }),
};
const refusedBy = (m) => {
  if (m.schemaVersion === 1 || v2) return validateManifest(m).ok === false;
  return lintV2(m).length > 0 || validateManifest(v1Projection(m)).ok === false;
};
out.negative_controls = Object.fromEntries(Object.entries(mustFail).map(([k, m]) => [k, refusedBy(m)]));
for (const [k, refused] of Object.entries(out.negative_controls)) if (!refused) { bad++; console.error(`ACCEPTED negative control ${k}`); }

writeFileSync(`${KIT}/results/manifest-validation.json`, JSON.stringify(out, null, 2) + "\n");
const tally = (v) => out.sites.filter((s) => s.verdict === v).length;
const verdicts = compat.sites.reduce((a, s) => ({ ...a, [s.verdict]: (a[s.verdict] ?? 0) + 1 }), {});
console.log(JSON.stringify({
  mode: out.mode,
  manifests: { valid: tally("valid"), pending_k3_validator: tally("pending_k3_validator"), invalid: tally("invalid"), of: out.sites.length },
  attack_site: out.attack_site.verdict,
  negative_controls_refused: Object.values(out.negative_controls).every(Boolean),
  compat: verdicts,
  bar: ">= 18/20 pooled-or-dedicated WORKING in prod (journeys), not just expressible",
}));
for (const s of out.sites) if (s.verdict === "invalid") console.error(s.n, JSON.stringify(s.issues));
if (out.attack_site.verdict === "invalid") console.error("attack-site", JSON.stringify(out.attack_site.issues));
process.exit(bad ? 1 : 0);
