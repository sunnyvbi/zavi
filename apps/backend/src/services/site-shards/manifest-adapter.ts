
import {
  EMPTY_SITE_CONTRACT,
  type ActionDef,
  type AggregateDef,
  type CollectionDef,
  type CollectionStates,
  type ManifestValidation,
  type SiteContractDef,
  type SiteManifestPackage,
} from "./contract";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function toDef(name: string, raw: unknown): CollectionDef {
  const c = obj(raw);
  const recipient = obj(c.recipient);
  return {
    name,
    kind: c.kind === "files" ? "files" : "records",
    rules: obj(c.rules) as Record<string, string[]>,
    schema: obj(c.schema),
    fields: obj(c.fields),
    indexes: obj(c.indexes),
    recipient: typeof recipient.reference === "string" ? { reference: recipient.reference } : null,
    unique: Array.isArray(c.unique) ? (c.unique as CollectionDef["unique"]) : [],
    states: c.states && typeof c.states === "object" && !Array.isArray(c.states) ? (c.states as CollectionStates) : null,
    references: obj(c.references) as CollectionDef["references"],
  };
}

export function siteContractOf(value: unknown): SiteContractDef {
  const v = obj(value);
  if (v.schemaVersion !== 2) return { ...EMPTY_SITE_CONTRACT };
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    schema_version: 2,
    roles: strings(v.roles),
    capabilities: strings(v.capabilities),
    actions: obj(v.actions) as Record<string, ActionDef>,
    aggregates: obj(v.aggregates) as Record<string, AggregateDef>,
  };
}

const CARRIED_COLLECTION_KEYS = new Set(["name", "kind", "rules", "schema", "fields", "indexes", "recipient", "unique", "states", "references"]);
const CARRIED_TOP_KEYS = new Set(["schemaVersion", "$schema", "collections", "smoke", "roles", "capabilities", "actions", "aggregates"]);

export function uncarriedParts(value: unknown): string[] {
  const out: string[] = [];
  const v = obj(value);
  for (const k of Object.keys(v)) if (!CARRIED_TOP_KEYS.has(k)) out.push(k);
  const cols = v.collections;
  const entries: Array<[string, unknown]> = Array.isArray(cols)
    ? cols.map((c) => [String(obj(c).name ?? ""), c] as [string, unknown])
    : Object.entries(obj(cols));
  for (const [name, c] of entries) for (const k of Object.keys(obj(c))) if (!CARRIED_COLLECTION_KEYS.has(k)) out.push(`collections.${name}.${k}`);
  return out;
}

export function usesV2(value: unknown): boolean {
  const v = obj(value);
  if (v.schemaVersion === 2) return true;
  const c = siteContractOf(value);
  if (c.roles.length || c.capabilities.length || Object.keys(c.actions).length || Object.keys(c.aggregates).length) return true;
  return collectionsOf(value).some(
    (d) => !!d.recipient || (d.unique?.length ?? 0) > 0 || !!d.states || Object.keys(d.references ?? {}).length > 0,
  );
}

export function collectionsVia(pkg: SiteManifestPackage | null, value: unknown): CollectionDef[] {
  const cols = obj(obj(value).collections);
  if (!pkg?.shardCollectionRow || Array.isArray(obj(value).collections)) return collectionsOf(value);
  return Object.keys(cols).map((name) => {
    const r = pkg.shardCollectionRow!(name, cols[name]);
    return {
      name: r.name,
      kind: r.kind === "files" ? "files" : "records",
      rules: obj(r.rules) as Record<string, string[]>,
      schema: obj(r.schema),
      fields: obj(r.fields),
      indexes: obj(r.indexes),
      recipient: (r.recipient as CollectionDef["recipient"]) ?? null,
      unique: Array.isArray(r.uniques) ? (r.uniques as CollectionDef["unique"]) : [],
      states: (r.states as CollectionDef["states"]) ?? null,
      references: obj(r.references) as CollectionDef["references"],
    };
  });
}

export function siteContractVia(pkg: SiteManifestPackage | null, value: unknown): SiteContractDef {
  if (!pkg?.siteContractRow) return siteContractOf(value);
  const r = pkg.siteContractRow(value);
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    schema_version: r.schema_version === 2 ? 2 : 1,
    roles: strings(r.roles),
    capabilities: strings(r.capabilities),
    actions: obj(r.actions) as Record<string, ActionDef>,
    aggregates: obj(r.aggregates) as Record<string, AggregateDef>,
  };
}

export function collectionsOf(value: unknown): CollectionDef[] {
  const cols = obj(value).collections ?? (value as { collections?: unknown } | null)?.collections;
  if (Array.isArray(cols)) {
    return cols
      .map((c) => [String(obj(c).name ?? ""), c] as const)
      .filter(([n]) => n)
      .map(([n, c]) => toDef(n, c));
  }
  return Object.entries(obj(cols)).map(([n, c]) => toDef(n, c));
}

export function validateWith(pkg: SiteManifestPackage | null, raw: unknown): ManifestValidation {
  if (!pkg) throw new Error("site manifest package is not wired");
  return pkg.validateManifest(raw);
}

export function validationErrors(v: Extract<ManifestValidation, { ok: false }>): string[] {
  const fromIssues = (v.issues ?? []).map((i) => [i.path, i.message].filter(Boolean).join(": "));
  const all = [...fromIssues, ...(v.errors ?? [])].filter(Boolean);
  return all.length ? all : ["zavi-site.json is not valid"];
}
