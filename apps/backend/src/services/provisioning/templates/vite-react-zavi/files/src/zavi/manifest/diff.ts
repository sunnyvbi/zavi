

import { canonicalJson, jsonEqual } from "./canonical";
import {
  OPS, type ActionDef, type AggregateDef, type Collection, type FieldMask, type IndexDef, type Manifest, type Op, type PropertySchema,
  type RecipientDef, type ReferenceDef, type StatesDef, type UniqueDef,
} from "./manifest";

export type ManifestChange =
  | { type: "collection_added"; collection: string; kind: Collection["kind"]; breaking: false }
  | { type: "collection_removed"; collection: string; kind: Collection["kind"]; breaking: true }
  | { type: "kind_changed"; collection: string; from: Collection["kind"]; to: Collection["kind"]; breaking: true }
  | { type: "rules_changed"; collection: string; op: Op; from: string[]; to: string[]; breaking: false }
  | { type: "field_added"; collection: string; field: string; required: boolean; breaking: boolean }
  | { type: "field_removed"; collection: string; field: string; breaking: true }
  | { type: "field_changed"; collection: string; field: string; from: PropertySchema; to: PropertySchema; breaking: true }
  | { type: "required_changed"; collection: string; added: string[]; removed: string[]; breaking: boolean }
  | { type: "mask_changed"; collection: string; field: string; from: FieldMask | null; to: FieldMask | null; breaking: false }
  | { type: "index_added"; collection: string; field: string; index: IndexDef; breaking: true }
  | { type: "index_removed"; collection: string; field: string; index: IndexDef; breaking: false }
  | { type: "index_changed"; collection: string; field: string; from: IndexDef; to: IndexDef; breaking: true }
  | { type: "roles_changed"; added: string[]; removed: string[]; breaking: boolean }
  | { type: "capabilities_changed"; added: string[]; removed: string[]; breaking: boolean }
  | { type: "recipient_changed"; collection: string; from: RecipientDef | null; to: RecipientDef | null; breaking: true }
  | { type: "unique_added"; collection: string; unique: UniqueDef; breaking: true }
  | { type: "unique_removed"; collection: string; unique: UniqueDef; breaking: false }
  | { type: "unique_changed"; collection: string; from: UniqueDef; to: UniqueDef; breaking: boolean }
  | { type: "states_changed"; collection: string; from: StatesDef | null; to: StatesDef | null; breaking: true }
  | { type: "references_changed"; collection: string; field: string; from: ReferenceDef | null; to: ReferenceDef | null; breaking: true }
  | { type: "actions_changed"; action: string; from: ActionDef | null; to: ActionDef | null; breaking: true }
  | { type: "aggregates_changed"; aggregate: string; from: AggregateDef | null; to: AggregateDef | null; breaking: false };

const EMPTY: Manifest = { schemaVersion: 2, roles: [], capabilities: [], collections: {}, actions: {}, aggregates: {} };

const setDiff = (a: readonly string[], b: readonly string[]) => ({
  added: b.filter((x) => !a.includes(x)).sort(),
  removed: a.filter((x) => !b.includes(x)).sort(),
});
const keysOf = (...os: Array<Record<string, unknown>>) => [...new Set(os.flatMap((o) => Object.keys(o)))].sort();

export function diffManifest(previous: Manifest | null, next: Manifest): ManifestChange[] {
  const prev = previous ?? EMPTY;
  const out: ManifestChange[] = [];
  const roles = setDiff(prev.roles ?? [], next.roles ?? []);
  if (roles.added.length || roles.removed.length) out.push({ type: "roles_changed", ...roles, breaking: roles.removed.length > 0 });
  const caps = setDiff(prev.capabilities ?? [], next.capabilities ?? []);
  if (caps.added.length || caps.removed.length) out.push({ type: "capabilities_changed", ...caps, breaking: caps.added.length > 0 });
  const names = [...new Set([...Object.keys(prev.collections), ...Object.keys(next.collections)])].sort();
  for (const name of names) {
    const a = prev.collections[name];
    const b = next.collections[name];
    if (!a && b) { out.push({ type: "collection_added", collection: name, kind: b.kind, breaking: false }); continue; }
    if (a && !b) { out.push({ type: "collection_removed", collection: name, kind: a.kind, breaking: true }); continue; }
    if (!a || !b) continue;
    if (a.kind !== b.kind) { out.push({ type: "kind_changed", collection: name, from: a.kind, to: b.kind, breaking: true }); continue; }

    for (const op of OPS) {
      if (!jsonEqual(a.rules[op], b.rules[op])) out.push({ type: "rules_changed", collection: name, op, from: a.rules[op], to: b.rules[op], breaking: false });
    }
    if (a.kind === "files" || b.kind === "files") continue;

    const pa = a.schema.properties, pb = b.schema.properties;
    const reqA = new Set(a.schema.required), reqB = new Set(b.schema.required);
    for (const f of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
      if (!pa[f]) out.push({ type: "field_added", collection: name, field: f, required: reqB.has(f), breaking: reqB.has(f) });
      else if (!pb[f]) out.push({ type: "field_removed", collection: name, field: f, breaking: true });
      else if (canonicalJson(pa[f]) !== canonicalJson(pb[f])) out.push({ type: "field_changed", collection: name, field: f, from: pa[f], to: pb[f], breaking: true });
    }
    const added = [...reqB].filter((f) => !reqA.has(f) && pa[f]).sort();
    const removed = [...reqA].filter((f) => !reqB.has(f) && pb[f]).sort();
    if (added.length || removed.length) out.push({ type: "required_changed", collection: name, added, removed, breaking: added.length > 0 });

    for (const f of [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].sort()) {
      const ma = a.fields[f] ?? null, mb = b.fields[f] ?? null;
      if (!jsonEqual(ma, mb)) out.push({ type: "mask_changed", collection: name, field: f, from: ma, to: mb, breaking: false });
    }
    for (const f of [...new Set([...Object.keys(a.indexes), ...Object.keys(b.indexes)])].sort()) {
      const ia = a.indexes[f], ib = b.indexes[f];
      if (!ia && ib) out.push({ type: "index_added", collection: name, field: f, index: ib, breaking: true });
      else if (ia && !ib) out.push({ type: "index_removed", collection: name, field: f, index: ia, breaking: false });
      else if (ia && ib && !jsonEqual(ia, ib)) out.push({ type: "index_changed", collection: name, field: f, from: ia, to: ib, breaking: true });
    }

    const ra = a.recipient ?? null, rb = b.recipient ?? null;
    if (!jsonEqual(ra, rb)) out.push({ type: "recipient_changed", collection: name, from: ra, to: rb, breaking: true });
    const ua = a.unique ?? [], ub = b.unique ?? [];
    const fk = (u: UniqueDef) => canonicalJson(u.fields);
    for (const u of ub) {
      const old = ua.find((x) => fk(x) === fk(u));
      if (!old) out.push({ type: "unique_added", collection: name, unique: u, breaking: true });
      else if (old.nulls !== u.nulls) out.push({ type: "unique_changed", collection: name, from: old, to: u, breaking: u.nulls === "not_distinct" });
    }
    for (const u of ua) if (!ub.some((x) => fk(x) === fk(u))) out.push({ type: "unique_removed", collection: name, unique: u, breaking: false });
    const sa = a.states ?? null, sb = b.states ?? null;
    if (!jsonEqual(sa, sb)) out.push({ type: "states_changed", collection: name, from: sa, to: sb, breaking: true });
    const fa = a.references ?? {}, fb = b.references ?? {};
    for (const f of keysOf(fa, fb)) {
      const x = fa[f] ?? null, y = fb[f] ?? null;
      if (!jsonEqual(x, y)) out.push({ type: "references_changed", collection: name, field: f, from: x, to: y, breaking: true });
    }
  }
  const aa = prev.actions ?? {}, ab = next.actions ?? {};
  for (const k of keysOf(aa, ab)) {
    const x = aa[k] ?? null, y = ab[k] ?? null;
    if (!jsonEqual(x, y)) out.push({ type: "actions_changed", action: k, from: x, to: y, breaking: true });
  }
  const ga = prev.aggregates ?? {}, gb = next.aggregates ?? {};
  for (const k of keysOf(ga, gb)) {
    const x = ga[k] ?? null, y = gb[k] ?? null;
    if (!jsonEqual(x, y)) out.push({ type: "aggregates_changed", aggregate: k, from: x, to: y, breaking: false });
  }
  return out;
}
