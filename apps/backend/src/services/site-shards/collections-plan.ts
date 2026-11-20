
import type { ActionDef, CollectionDef, SiteContractDef } from "./contract";

export type CollectionPlan = {
  add: CollectionDef[];
  change: CollectionDef[];
  archive: string[];
  unchanged: string[];
  reindex: string[];
};

export class CollectionPlanRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CollectionPlanRefused";
  }
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const isArchived = (c: CollectionDef) => c.archived === true;

export const COLLECTION_KEYS = ["rules", "schema", "fields", "indexes", "recipient", "unique", "states", "references"] as const;
const EMPTY: Record<(typeof COLLECTION_KEYS)[number], unknown> = {
  rules: {}, schema: {}, fields: {}, indexes: {}, recipient: null, unique: [], states: null, references: {},
};
export const defValue = (c: CollectionDef, k: (typeof COLLECTION_KEYS)[number]): unknown =>
  (c as Record<string, unknown>)[k] ?? EMPTY[k];

export function planCollections(current: CollectionDef[], desired: CollectionDef[]): CollectionPlan {
  const plan: CollectionPlan = { add: [], change: [], archive: [], unchanged: [], reindex: [] };
  const names = new Set<string>();
  for (const d of desired) {
    if (names.has(d.name)) throw new CollectionPlanRefused(`collection "${d.name}" is declared twice`);
    names.add(d.name);
  }
  const byName = new Map(current.map((c) => [c.name, c]));
  for (const d of desired) {
    const c = byName.get(d.name);
    if (!c) {
      plan.add.push(d);
      continue;
    }
    if (c.kind !== d.kind) {
      throw new CollectionPlanRefused(`collection "${d.name}" cannot change from ${c.kind} to ${d.kind}; use a new name`);
    }
    const same = COLLECTION_KEYS.every(
      (k) => canonical(defValue(c, k)) === canonical(defValue(d, k)),
    );
    if (same && !isArchived(c)) {
      plan.unchanged.push(d.name);
      continue;
    }
    plan.change.push(d);
    if (canonical(c.indexes ?? {}) !== canonical(d.indexes ?? {})) plan.reindex.push(d.name);
  }
  for (const c of current) {
    if (names.has(c.name)) continue;
    if (isArchived(c)) plan.unchanged.push(c.name);
    else plan.archive.push(c.name);
  }
  return plan;
}

export const planIsEmpty = (p: CollectionPlan) => !p.add.length && !p.change.length && !p.archive.length;

export type ManifestChangeKind =
  | "roles_changed"
  | "recipient_changed"
  | "unique_added"
  | "unique_removed"
  | "unique_changed"
  | "states_changed"
  | "references_changed"
  | "actions_changed"
  | "aggregates_changed"
  | "capabilities_changed";
export type ManifestChange = { kind: ManifestChangeKind; collection?: string; name?: string };

type Unique = NonNullable<CollectionDef["unique"]>[number];

export type BackfillPlan = {
  uniques: Array<{ collection: string; fields: string[]; nulls: Unique["nulls"] }>;
  states: Array<{ collection: string; field: string; values: string[]; initial: string }>;
  references: Array<{ collection: string; field: string; target: string }>;
  recipients: Array<{ collection: string; field: string; target: string }>;
  counters: Array<{ action: string; collection: string; counter: string; initial: number; bounds: ActionDef["bounds"] }>;
  removedRoles: string[];
};

export type SitePlan = {
  collections: CollectionPlan;
  contract: { current: SiteContractDef; desired: SiteContractDef; changed: boolean };
  changes: ManifestChange[];
  backfill: BackfillPlan;
};

const uniqueKey = (u: Unique) => JSON.stringify(u.fields);

export function planSite(
  current: CollectionDef[],
  desired: CollectionDef[],
  currentContract: SiteContractDef,
  desiredContract: SiteContractDef,
): SitePlan {
  const collections = planCollections(current, desired);
  const changes: ManifestChange[] = [];
  const backfill: BackfillPlan = { uniques: [], states: [], references: [], recipients: [], counters: [], removedRoles: [] };
  const cur = new Map(current.map((c) => [c.name, c]));
  for (const d of collections.change) {
    const c = cur.get(d.name);
    if (!c) continue;
    const rc = defValue(c, "recipient") as CollectionDef["recipient"];
    const rd = defValue(d, "recipient") as CollectionDef["recipient"];
    if (canonical(rc) !== canonical(rd)) {
      changes.push({ kind: "recipient_changed", collection: d.name });
      const target = rd ? d.references?.[rd.reference]?.collection : undefined;
      if (rd && target) backfill.recipients.push({ collection: d.name, field: rd.reference, target });
    }
    const uc = new Map(((defValue(c, "unique") as Unique[]) ?? []).map((u) => [uniqueKey(u), u]));
    const ud = new Map(((defValue(d, "unique") as Unique[]) ?? []).map((u) => [uniqueKey(u), u]));
    for (const [k, u] of ud) {
      const was = uc.get(k);
      if (!was) changes.push({ kind: "unique_added", collection: d.name });
      else if (was.nulls !== u.nulls) changes.push({ kind: "unique_changed", collection: d.name });
      else continue;
      backfill.uniques.push({ collection: d.name, fields: [...u.fields], nulls: u.nulls });
    }
    for (const k of uc.keys()) if (!ud.has(k)) changes.push({ kind: "unique_removed", collection: d.name });
    const sd = defValue(d, "states") as CollectionDef["states"];
    if (canonical(defValue(c, "states")) !== canonical(sd)) {
      changes.push({ kind: "states_changed", collection: d.name });
      if (sd) backfill.states.push({ collection: d.name, field: sd.field, values: [...sd.values], initial: sd.initial });
    }
    const fc = (defValue(c, "references") ?? {}) as NonNullable<CollectionDef["references"]>;
    const fd = (defValue(d, "references") ?? {}) as NonNullable<CollectionDef["references"]>;
    if (canonical(fc) !== canonical(fd)) {
      changes.push({ kind: "references_changed", collection: d.name });
      for (const [field, r] of Object.entries(fd)) {
        if (fc[field]?.collection !== r.collection) backfill.references.push({ collection: d.name, field, target: r.collection });
      }
    }
  }
  const a = currentContract;
  const b = desiredContract;
  if (canonical([...a.roles].sort()) !== canonical([...b.roles].sort())) {
    changes.push({ kind: "roles_changed" });
    const keep = new Set(b.roles);
    backfill.removedRoles = a.roles.filter((r) => !keep.has(r)).sort();
  }
  if (canonical([...a.capabilities].sort()) !== canonical([...b.capabilities].sort())) changes.push({ kind: "capabilities_changed" });
  if (canonical(a.actions) !== canonical(b.actions)) {
    changes.push({ kind: "actions_changed" });
    for (const [name, act] of Object.entries(b.actions)) {
      if (canonical(a.actions[name] ?? null) === canonical(act)) continue;
      if (!cur.has(act.target.collection)) continue;
      backfill.counters.push({ action: name, collection: act.target.collection, counter: act.target.counter, initial: act.initial, bounds: act.bounds });
    }
  }
  if (canonical(a.aggregates) !== canonical(b.aggregates)) changes.push({ kind: "aggregates_changed" });
  const contractChanged = canonical(a) !== canonical(b);
  return { collections, contract: { current: a, desired: b, changed: contractChanged }, changes, backfill };
}

export const sitePlanIsEmpty = (p: SitePlan) => planIsEmpty(p.collections) && !p.contract.changed;
