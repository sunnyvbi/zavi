

import { canonicalJson, isPlainObject, jsonEqual } from "./canonical";
import { sha256Hex } from "./sha256";
import { canonicalFunctions, checkFunctions, FUNCTION_NAME_RE, type FunctionsDef } from "./functions";

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2];
export const OPS = ["list", "get", "create", "update", "delete"] as const;
export type Op = (typeof OPS)[number];
export type Principal = string;
export type Rules = Record<Op, Principal[]>;

export type PropertySchema =
  | { type: "string"; maxLength: number; minLength?: number; enum?: string[]; format?: "email" | "date" | "date-time" | "uuid" }
  | { type: "integer" | "number"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "array"; items: PropertySchema; maxItems: number };

export type CollectionSchema = { type: "object"; properties: Record<string, PropertySchema>; required: string[] };
export type FieldMask = { read?: Principal[]; write?: Principal[] };

export const INDEX_TYPES = ["text", "number", "timestamp"] as const;
export type IndexType = (typeof INDEX_TYPES)[number];
export const INDEX_OPS: Record<IndexType, readonly string[]> = {
  text: ["eq", "in", "range", "prefix"],
  number: ["eq", "in", "range"],
  timestamp: ["eq", "in", "range"],
};
export type IndexOp = "eq" | "in" | "range" | "prefix";
export type IndexDef = { type: IndexType; ops: IndexOp[]; sort: boolean };
export const INDEX_BUDGET = { text: 3, number: 2, timestamp: 2 } as const;
export const TEXT_INDEX_MAX_LENGTH = 512;

export const DEDICATED_CAPABILITIES = [
  "payments", "payouts", "interval_overlap", "multi_step_workflow", "webhooks",
  "secrets", "jobs", "arbitrary_joins", "server_compute", "raw_sql",
] as const;
export type DedicatedCapability = (typeof DEDICATED_CAPABILITIES)[number];

export const ON_DELETE = ["restrict", "cascade", "nullify"] as const;
export type OnDelete = (typeof ON_DELETE)[number];
export type ReferenceDef = { collection: string; on_delete: OnDelete };
export type RecipientDef = { reference: string };
export type UniqueDef = { fields: string[]; nulls: "distinct" | "not_distinct" };
export type StateTransition = { from: string; to: string; principals: Principal[] };
export type StatesDef = {
  field: string;
  values: string[];
  initial: string;
  read?: Record<string, Principal[]>;
  transitions: StateTransition[];
};
export type ActionBounds = { min: number; max: number } | { min: number; maxField: string };
export type ActionInverse = {
  name: string;
  delta: number;
  transition: { from: string; to: string };
  principals: Principal[];
  idempotency: "required";
};
export type ActionDef = {
  target: { collection: string; counter: string };
  delta: number;
  initial: number;
  bounds: ActionBounds;
  creates: { collection: string; targetField: string };
  principals: Principal[];
  idempotency: "required";
  inverse?: ActionInverse;
};
export const AGGREGATE_FNS = ["count", "sum", "avg"] as const;
export type AggregateDef = {
  collection: string;
  fn: (typeof AGGREGATE_FNS)[number];
  field?: string;
  filters: string[];
  principals: Principal[];
};

export const V2_LIMITS = {
  roles: 8,
  uniquePerCollection: 4,
  uniqueFields: 4,
  stateValues: 16,
  stateTransitions: 32,
  referencesPerCollection: 4,
  referencesPerSite: 64,
  referenceDepth: 4,
  deleteFanout: 1000,
  callableActions: 16,
  aggregates: 8,
  aggregateFilters: 2,
  aggregateScanRows: 10000,
  aggregateStatementMs: 250,
  maxDelta: 1000,
  recipientCreatesPerMinute: 30,
} as const;
export const ROLE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

export type RecordsCollection = {
  kind: "records";
  rules: Rules;
  schema: CollectionSchema;
  fields: Record<string, FieldMask>;
  indexes: Record<string, IndexDef>;
  recipient: RecipientDef | null;
  unique: UniqueDef[];
  states: StatesDef | null;
  references: Record<string, ReferenceDef>;
};
export type FilesCollection = {
  kind: "files";
  rules: Rules;
  schema: Record<string, never>;
  fields: Record<string, never>;
  indexes: Record<string, never>;
};
export type Collection = RecordsCollection | FilesCollection;

export type Manifest = {
  schemaVersion: 1 | 2;
  roles: string[];
  capabilities: DedicatedCapability[];
  collections: Record<string, Collection>;
  actions: Record<string, ActionDef>;
  aggregates: Record<string, AggregateDef>;
  functions?: FunctionsDef;
  smoke?: unknown;
};

export type ManifestIssue = { path: string; code: string; message: string };
export type ManifestResult =
  | { ok: true; value: Manifest; hash: string }
  | { ok: false; issues: ManifestIssue[] };

export const MAX_COLLECTIONS = 64;
export const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE_PRINCIPAL = /^role:[a-z][a-z0-9_]{0,31}$/;
export const RESERVED_FIELDS: readonly string[] = ["id", "site_id", "owner_id", "collection", "created_at", "updated_at", "idempotency_key", "mine"];
const PROPERTY_KEYS = new Set(["type", "maxLength", "minLength", "enum", "minimum", "maximum", "format", "items", "maxItems"]);
const FORMATS = ["email", "date", "date-time", "uuid"];
const PRINCIPAL_ORDER = ["anyone", "signed_in", "owner", "recipient", "admin"];

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNumber(v) && Number.isInteger(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

class Issues {
  list: ManifestIssue[] = [];
  add(path: string, code: string, message: string): void {
    this.list.push({ path, code, message });
  }
}

type PCtx = { v2: boolean; roles: ReadonlySet<string>; functions?: ReadonlySet<string> };
const FN_PRINCIPAL = /^fn:([a-z][a-z0-9-]{0,47})$/;
type PAllow = { anyone: boolean; recipient: boolean; onlyAdminRoles?: boolean };

function checkPrincipals(out: Issues, path: string, p: unknown, ctx: PCtx, allow: PAllow): void {
  if (!Array.isArray(p)) return out.add(path, "invalid_principals", "must be an array of principals");
  if (p.length > 8) out.add(path, "too_many_principals", "at most 8 principals");
  p.forEach((e, i) => {
    const at = `${path}[${i}]`;
    if (typeof e !== "string") return out.add(at, "invalid_principal", `${JSON.stringify(e)} is not a principal`);
    if (allow.onlyAdminRoles && e !== "admin" && !ROLE_PRINCIPAL.test(e)) {
      return out.add(at, "principal_not_allowed", "only admin or role:<name> may run an aggregate");
    }
    if (ROLE_PRINCIPAL.test(e)) {
      if (ctx.v2 && !ctx.roles.has(e.slice(5))) out.add(at, "undeclared_role", `${e} is not declared in "roles"`);
      return;
    }
    const fn = FN_PRINCIPAL.exec(e);
    if (fn) {
      if (allow.onlyAdminRoles) return out.add(at, "principal_not_allowed", "only admin or role:<name> may run an aggregate");
      if (!ctx.functions?.has(fn[1])) out.add(at, "undeclared_function", `${e} names no function declared under "functions"`);
      return;
    }
    if (e === "signed_in" || e === "owner" || e === "admin") return;
    if (e === "anyone") {
      if (!allow.anyone) out.add(at, "anyone_not_allowed", '"anyone" is not allowed here (signed-out visitors may only list, get and create, and run actions that declare it)');
      return;
    }
    if (e === "recipient" && ctx.v2) {
      if (!allow.recipient) out.add(at, "recipient_not_allowed", '"recipient" only applies to a collection with "recipient", and never to create');
      return;
    }
    out.add(at, "unknown_principal", `unknown principal ${JSON.stringify(e)} (use anyone, signed_in, owner, ${ctx.v2 ? "recipient, " : ""}admin, role:<name> or fn:<function>)`);
  });
}

function checkRules(out: Issues, path: string, rules: unknown, ctx: PCtx, recipient: boolean): void {
  if (!isPlainObject(rules)) return out.add(path, "invalid_rules", "rules must be an object");
  for (const k of Object.keys(rules)) {
    if (!(OPS as readonly string[]).includes(k)) out.add(`${path}.${k}`, "unknown_op", `unknown operation "${k}" (use ${OPS.join(", ")})`);
  }
  for (const op of OPS) {
    if (has(rules, op)) checkPrincipals(out, `${path}.${op}`, rules[op], ctx, { anyone: op !== "update" && op !== "delete", recipient: recipient && op !== "create" });
  }
}

export function validFieldName(k: string): boolean {
  return NAME_RE.test(k) && !RESERVED_FIELDS.includes(k);
}

function checkProperty(out: Issues, path: string, p: unknown, inArray: boolean): void {
  if (!isPlainObject(p)) return out.add(path, "invalid_property", "a field definition must be an object");
  const unknown = Object.keys(p).filter((k) => !PROPERTY_KEYS.has(k));
  if (unknown.length) return out.add(path, "unsupported_keyword", `unsupported keyword(s): ${unknown.join(", ")}`);
  const t = p.type;
  const forbid = (keys: string[]) => {
    for (const k of keys) if (has(p, k)) out.add(`${path}.${k}`, "keyword_not_allowed", `"${k}" is not allowed on type ${String(t)}`);
  };
  if (t === "string") {
    if (!isInt(p.maxLength) || p.maxLength < 1 || p.maxLength > 10000) {
      out.add(`${path}.maxLength`, "unbounded_string", "every string needs maxLength, a whole number from 1 to 10000");
    }
    if (has(p, "minLength") && (!isInt(p.minLength) || p.minLength < 0)) out.add(`${path}.minLength`, "invalid_value", "minLength must be a whole number >= 0");
    if (isInt(p.minLength) && isInt(p.maxLength) && p.minLength > p.maxLength) out.add(`${path}.minLength`, "invalid_value", "minLength is above maxLength");
    if (has(p, "format") && !(typeof p.format === "string" && FORMATS.includes(p.format))) {
      out.add(`${path}.format`, "invalid_format", `format must be one of ${FORMATS.join(", ")}`);
    }
    if (has(p, "enum") && !(Array.isArray(p.enum) && p.enum.length >= 1 && p.enum.length <= 100 && p.enum.every((e) => typeof e === "string"))) {
      out.add(`${path}.enum`, "invalid_value", "enum must be 1 to 100 strings");
    }
    return forbid(["minimum", "maximum", "items", "maxItems"]);
  }
  if (t === "integer" || t === "number") {
    if (has(p, "minimum") && !isNumber(p.minimum)) out.add(`${path}.minimum`, "invalid_value", "minimum must be a number");
    if (has(p, "maximum") && !isNumber(p.maximum)) out.add(`${path}.maximum`, "invalid_value", "maximum must be a number");
    if (isNumber(p.minimum) && isNumber(p.maximum) && p.minimum > p.maximum) out.add(`${path}.minimum`, "invalid_value", "minimum is above maximum");
    return forbid(["maxLength", "minLength", "format", "enum", "items", "maxItems"]);
  }
  if (t === "boolean") {
    if (Object.keys(p).length !== 1) out.add(path, "keyword_not_allowed", "a boolean takes no other keyword");
    return;
  }
  if (t === "array" && !inArray) {
    if (!isInt(p.maxItems) || p.maxItems < 1 || p.maxItems > 100) out.add(`${path}.maxItems`, "unbounded_array", "every array needs maxItems, a whole number from 1 to 100");
    if (!has(p, "items")) out.add(`${path}.items`, "invalid_property", "items is required");
    else checkProperty(out, `${path}.items`, p.items, true);
    return forbid(["maxLength", "minLength", "format", "enum", "minimum", "maximum"]);
  }
  if (t === "array") return out.add(path, "invalid_type", "arrays of arrays are not supported");
  out.add(`${path}.type`, "invalid_type", "type must be string, integer, number, boolean or array (no nested objects)");
}

function checkSchema(out: Issues, path: string, s: unknown): void {
  if (!isPlainObject(s)) return out.add(path, "invalid_schema", "schema must be an object");
  if (s.type !== "object") out.add(`${path}.type`, "invalid_schema", 'schema.type must be "object"');
  for (const k of Object.keys(s)) {
    if (k !== "type" && k !== "properties" && k !== "required") out.add(`${path}.${k}`, "unsupported_keyword", `unsupported keyword "${k}"`);
  }
  if (!isPlainObject(s.properties)) return out.add(`${path}.properties`, "invalid_schema", "properties must be an object");
  const props = Object.entries(s.properties);
  if (props.length < 1 || props.length > 64) out.add(`${path}.properties`, "invalid_schema", "declare 1 to 64 fields");
  for (const [k, v] of props) {
    if (!validFieldName(k)) {
      out.add(`${path}.properties.${k}`, RESERVED_FIELDS.includes(k) ? "reserved_field" : "invalid_field_name",
        `"${k}" is not a valid field name (lowercase letters, digits and _, starting with a letter; not ${RESERVED_FIELDS.join("/")})`);
    } else checkProperty(out, `${path}.properties.${k}`, v, false);
  }
  if (has(s, "required")) {
    if (!Array.isArray(s.required)) return out.add(`${path}.required`, "invalid_schema", "required must be an array of field names");
    s.required.forEach((r, i) => {
      if (typeof r !== "string" || !has(s.properties as Record<string, unknown>, r)) {
        out.add(`${path}.required[${i}]`, "undeclared_field", `${JSON.stringify(r)} is not a declared field`);
      }
    });
  }
}

const NUMBER_TYPES = new Set(["integer", "number"]);

function checkIndexes(out: Issues, path: string, indexes: Record<string, unknown>, props: Record<string, unknown>): void {
  const entries = Object.entries(indexes);
  const perType: Record<string, number> = { text: 0, number: 0, timestamp: 0 };
  for (const [field, def] of entries) {
    const at = `${path}.${field}`;
    if (!has(props, field)) { out.add(at, "undeclared_field", "only declared fields can be indexed"); continue; }
    if (!isPlainObject(def)) { out.add(at, "invalid_index", 'an index is {"type": "text"|"number"|"timestamp", "ops": [...], "sort": true|false}'); continue; }
    for (const k of Object.keys(def)) if (k !== "type" && k !== "ops" && k !== "sort") out.add(`${at}.${k}`, "unsupported_keyword", `unsupported index keyword "${k}"`);
    const type = def.type;
    if (typeof type !== "string" || !(INDEX_TYPES as readonly string[]).includes(type)) {
      out.add(`${at}.type`, "invalid_index", "index type must be text, number or timestamp");
      continue;
    }
    perType[type]++;
    const prop = isPlainObject(props[field]) ? (props[field] as Record<string, unknown>) : {};
    const ok =
      (type === "text" && prop.type === "string" && prop.format !== "date" && prop.format !== "date-time"
        && isNumber(prop.maxLength) && prop.maxLength <= TEXT_INDEX_MAX_LENGTH) ||
      (type === "text" && prop.type === "boolean") ||
      (type === "number" && NUMBER_TYPES.has(String(prop.type))) ||
      (type === "timestamp" && prop.type === "string" && (prop.format === "date" || prop.format === "date-time"));
    if (!ok) {
      out.add(`${at}.type`, "index_type_mismatch",
        type === "timestamp" ? "a timestamp index needs a string field with format date or date-time"
          : type === "number" ? "a number index needs an integer or number field"
            : prop.type === "string" && (prop.format === "date" || prop.format === "date-time")
              ? `"${field}" is a date: index it as {"type": "timestamp"}, not "text"`
              : `a text index needs a boolean, or a string (not a date) with maxLength <= ${TEXT_INDEX_MAX_LENGTH}`);
    }
    const allowed = INDEX_OPS[type as IndexType];
    if (!Array.isArray(def.ops) || def.ops.length === 0) out.add(`${at}.ops`, "invalid_index", `ops must list at least one of ${allowed.join(", ")}`);
    else {
      const seen = new Set<unknown>();
      def.ops.forEach((op, i) => {
        if (typeof op !== "string" || !allowed.includes(op)) out.add(`${at}.ops[${i}]`, "invalid_index_op", `a ${type} index supports ${allowed.join(", ")}`);
        else if (seen.has(op)) out.add(`${at}.ops[${i}]`, "invalid_index_op", `duplicate op "${op}"`);
        seen.add(op);
      });
    }
    if (has(def, "sort") && typeof def.sort !== "boolean") out.add(`${at}.sort`, "invalid_index", "sort must be true or false");
  }
  for (const t of INDEX_TYPES) {
    if (perType[t] > INDEX_BUDGET[t]) out.add(path, "index_budget", `at most ${INDEX_BUDGET[t]} ${t} indexes per collection`);
  }
}

const V2_COLLECTION_KEYS = ["recipient", "unique", "states", "references"];
const COLLECTION_KEYS = ["kind", "rules", "schema", "fields", "indexes"];

function checkCollection(out: Issues, name: string, def: Record<string, unknown>, ctx: PCtx): void {
  const path = `collections.${name}`;
  if (!NAME_RE.test(name)) out.add(path, "invalid_name", "collection names are lowercase letters, digits and _, starting with a letter (max 63)");
  const allowed = ctx.v2 ? [...COLLECTION_KEYS, ...V2_COLLECTION_KEYS] : COLLECTION_KEYS;
  for (const k of Object.keys(def)) {
    if (!allowed.includes(k)) {
      out.add(`${path}.${k}`, "unknown_key", V2_COLLECTION_KEYS.includes(k)
        ? `"${k}" needs "schemaVersion": 2`
        : `unknown key "${k}" (use ${allowed.join(", ")})`);
    }
  }
  const kind = def.kind ?? "records";
  if (kind !== "records" && kind !== "files") return out.add(`${path}.kind`, "invalid_kind", 'kind must be "records" or "files"');
  const recipient = kind === "records" && ctx.v2 && def.recipient !== undefined;
  if (!has(def, "rules")) out.add(`${path}.rules`, "missing_rules", "every collection needs rules");
  else checkRules(out, `${path}.rules`, def.rules, ctx, recipient);
  const fields = def.fields ?? {};
  const indexes = def.indexes ?? {};
  if (!isPlainObject(fields)) out.add(`${path}.fields`, "invalid_fields", "fields must be an object");
  if (!isPlainObject(indexes)) out.add(`${path}.indexes`, "invalid_indexes", "indexes must be an object");
  if (!isPlainObject(fields) || !isPlainObject(indexes)) return;

  if (kind === "files") {
    if (has(def, "schema") && !jsonEqual(def.schema, {})) out.add(`${path}.schema`, "files_area_shape", "a files area has no schema");
    if (!jsonEqual(fields, {})) out.add(`${path}.fields`, "files_area_shape", "a files area has no fields");
    if (!jsonEqual(indexes, {})) out.add(`${path}.indexes`, "files_area_shape", "a files area has no indexes");
    for (const k of V2_COLLECTION_KEYS) if (has(def, k)) out.add(`${path}.${k}`, "files_area_shape", `a files area has no ${k}`);
    const r = isPlainObject(def.rules) ? def.rules : {};
    const asSet = (v: unknown) => (Array.isArray(v) ? canonicalPrincipals(v as string[]) : v);
    if (!jsonEqual(asSet(r.list ?? []), asSet(r.get ?? []))) out.add(`${path}.rules`, "files_area_shape", "a files area needs the same principals for list and get");
    return;
  }

  checkSchema(out, `${path}.schema`, def.schema);
  const props = isPlainObject(def.schema) && isPlainObject(def.schema.properties) ? def.schema.properties : {};
  for (const [k, mask] of Object.entries(fields)) {
    const at = `${path}.fields.${k}`;
    if (!has(props, k)) { out.add(at, "undeclared_field", "masks only apply to declared fields"); continue; }
    if (!isPlainObject(mask)) { out.add(at, "invalid_mask", 'a mask is {"read": [...], "write": [...]}'); continue; }
    for (const m of Object.keys(mask)) if (m !== "read" && m !== "write") out.add(`${at}.${m}`, "invalid_mask", 'only "read" and "write" are allowed');
    if (has(mask, "read")) checkPrincipals(out, `${at}.read`, mask.read, ctx, { anyone: true, recipient });
    if (has(mask, "write")) checkPrincipals(out, `${at}.write`, mask.write, ctx, { anyone: true, recipient });
  }
  checkIndexes(out, `${path}.indexes`, indexes, props);
  if (ctx.v2) checkRelational(out, path, def, props, ctx, recipient);
}

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);
const prop = (props: Record<string, unknown>, f: string): Record<string, unknown> | null =>
  has(props, f) && isPlainObject(props[f]) ? (props[f] as Record<string, unknown>) : null;
const requiredOf = (def: Record<string, unknown>): string[] =>
  isPlainObject(def.schema) && Array.isArray(def.schema.required) ? (def.schema.required as unknown[]).filter((x): x is string => typeof x === "string") : [];

function checkRelational(out: Issues, path: string, def: Record<string, unknown>, props: Record<string, unknown>, ctx: PCtx, recipient: boolean): void {
  const required = requiredOf(def);

  const refs = def.references ?? {};
  if (!isPlainObject(refs)) out.add(`${path}.references`, "invalid_references", "references must be an object of { field: {collection, on_delete} }");
  else {
    const entries = Object.entries(refs);
    if (entries.length > V2_LIMITS.referencesPerCollection) out.add(`${path}.references`, "reference_budget", `at most ${V2_LIMITS.referencesPerCollection} references per collection`);
    for (const [f, r] of entries) {
      const at = `${path}.references.${f}`;
      const p = prop(props, f);
      if (!p) { out.add(at, "undeclared_field", "only declared fields can be references"); continue; }
      if (p.type !== "string" || p.format !== "uuid" || !isNumber(p.maxLength) || p.maxLength < 36) {
        out.add(at, "invalid_reference_field", 'a reference field is {"type": "string", "format": "uuid", "maxLength": 36}');
      }
      if (!isPlainObject(r)) { out.add(at, "invalid_reference", 'a reference is {"collection": "...", "on_delete": "restrict"|"cascade"|"nullify"}'); continue; }
      for (const k of Object.keys(r)) if (k !== "collection" && k !== "on_delete") out.add(`${at}.${k}`, "unsupported_keyword", `unsupported reference keyword "${k}"`);
      if (typeof r.collection !== "string") out.add(`${at}.collection`, "invalid_reference", "collection must name a records collection");
      if (!(ON_DELETE as readonly unknown[]).includes(r.on_delete)) out.add(`${at}.on_delete`, "invalid_reference", `on_delete must be ${ON_DELETE.join(", ")}`);
      if (r.on_delete === "nullify" && required.includes(f)) out.add(`${at}.on_delete`, "nullify_required_field", '"nullify" needs an optional field (it removes the key)');
    }
  }
  const refFields = isPlainObject(refs) ? Object.keys(refs) : [];

  if (recipient) {
    const r = def.recipient;
    if (!isPlainObject(r) || Object.keys(r).length !== 1 || typeof r.reference !== "string") {
      out.add(`${path}.recipient`, "invalid_recipient", 'recipient is {"reference": "<required reference field>"}');
    } else if (!refFields.includes(r.reference) || !required.includes(r.reference)) {
      out.add(`${path}.recipient.reference`, "recipient_needs_required_reference", "recipient.reference must name a required field declared in references");
    }
  }

  const uniq = def.unique ?? [];
  if (!Array.isArray(uniq)) out.add(`${path}.unique`, "invalid_unique", 'unique is a list of {"fields": [...], "nulls": "distinct"|"not_distinct"}');
  else {
    if (uniq.length > V2_LIMITS.uniquePerCollection) out.add(`${path}.unique`, "unique_budget", `at most ${V2_LIMITS.uniquePerCollection} unique tuples per collection`);
    const seen = new Set<string>();
    uniq.forEach((u, i) => {
      const at = `${path}.unique[${i}]`;
      if (!isPlainObject(u)) return out.add(at, "invalid_unique", 'a unique tuple is {"fields": [...], "nulls": "distinct"|"not_distinct"}');
      for (const k of Object.keys(u)) if (k !== "fields" && k !== "nulls") out.add(`${at}.${k}`, "unsupported_keyword", `unsupported unique keyword "${k}"`);
      if (u.nulls !== "distinct" && u.nulls !== "not_distinct") out.add(`${at}.nulls`, "invalid_unique", 'nulls must be "distinct" or "not_distinct"');
      if (!Array.isArray(u.fields) || u.fields.length < 1 || u.fields.length > V2_LIMITS.uniqueFields) {
        return out.add(`${at}.fields`, "unique_budget", `a unique tuple has 1 to ${V2_LIMITS.uniqueFields} fields`);
      }
      if (new Set(u.fields).size !== u.fields.length) out.add(`${at}.fields`, "invalid_unique", "a field appears twice");
      u.fields.forEach((f, j) => {
        const p = typeof f === "string" ? prop(props, f) : null;
        if (!p) out.add(`${at}.fields[${j}]`, "undeclared_field", "unique fields must be declared fields");
        else if (!SCALAR_TYPES.has(String(p.type))) out.add(`${at}.fields[${j}]`, "invalid_unique", "unique fields must be scalars (no arrays)");
      });
      const key = canonicalJson(u.fields);
      if (seen.has(key)) out.add(at, "invalid_unique", "the same tuple is declared twice");
      seen.add(key);
    });
  }

  if (def.states !== undefined) checkStates(out, `${path}.states`, def.states, props, required, ctx, recipient);
}

function checkStates(out: Issues, at: string, st: unknown, props: Record<string, unknown>, required: string[], ctx: PCtx, recipient: boolean): void {
  if (!isPlainObject(st)) return out.add(at, "invalid_states", "states must be an object");
  for (const k of Object.keys(st)) if (!["field", "values", "initial", "read", "transitions"].includes(k)) out.add(`${at}.${k}`, "unsupported_keyword", `unsupported states keyword "${k}"`);
  const values = st.values;
  if (!Array.isArray(values) || values.length < 1 || values.length > V2_LIMITS.stateValues || !values.every((v) => typeof v === "string" && v.length > 0)) {
    return out.add(`${at}.values`, "state_budget", `values is 1 to ${V2_LIMITS.stateValues} non-empty strings`);
  }
  if (new Set(values).size !== values.length) out.add(`${at}.values`, "invalid_states", "a state appears twice");
  const field = typeof st.field === "string" ? st.field : "";
  const p = prop(props, field);
  if (!p) out.add(`${at}.field`, "undeclared_field", "the state field must be a declared field");
  else if (p.type !== "string" || !required.includes(field) || !Array.isArray(p.enum)
    || p.enum.length !== values.length || !values.every((v) => (p.enum as unknown[]).includes(v))) {
    out.add(`${at}.field`, "state_field_mismatch", "the state field must be a required string whose enum is exactly the state values");
  }
  if (typeof st.initial !== "string" || !values.includes(st.initial)) out.add(`${at}.initial`, "invalid_states", "initial must be one of the values");
  if (st.read !== undefined) {
    if (!isPlainObject(st.read)) out.add(`${at}.read`, "invalid_states", "read is {state: [principals]}");
    else {
      for (const k of Object.keys(st.read)) if (!values.includes(k)) out.add(`${at}.read.${k}`, "invalid_states", `"${k}" is not a state value`);
      for (const v of values) {
        if (!has(st.read, v)) out.add(`${at}.read`, "incomplete_state_read", `read must list every state; "${v}" is missing`);
        else checkPrincipals(out, `${at}.read.${v}`, st.read[v], ctx, { anyone: true, recipient });
      }
    }
  }
  const tr = st.transitions;
  if (!Array.isArray(tr) || tr.length > V2_LIMITS.stateTransitions) return out.add(`${at}.transitions`, "state_budget", `transitions is a list of at most ${V2_LIMITS.stateTransitions}`);
  const seen = new Set<string>();
  tr.forEach((t, i) => {
    const tat = `${at}.transitions[${i}]`;
    if (!isPlainObject(t)) return out.add(tat, "invalid_transition", 'a transition is {"from", "to", "principals"}');
    for (const k of Object.keys(t)) if (!["from", "to", "principals"].includes(k)) out.add(`${tat}.${k}`, "unsupported_keyword", `unsupported transition keyword "${k}"`);
    if (typeof t.from !== "string" || !values.includes(t.from) || typeof t.to !== "string" || !values.includes(t.to) || t.from === t.to) {
      out.add(tat, "invalid_transition", "from and to must be two different state values");
    }
    const key = `${String(t.from)}\u0000${String(t.to)}`;
    if (seen.has(key)) out.add(tat, "invalid_transition", "the same transition is declared twice");
    seen.add(key);
    checkPrincipals(out, `${tat}.principals`, t.principals, ctx, { anyone: false, recipient });
    if (Array.isArray(t.principals) && t.principals.length === 0) out.add(`${tat}.principals`, "invalid_principals", "a transition needs at least one principal");
  });
}

function checkRoles(out: Issues, roles: unknown): Set<string> {
  const set = new Set<string>();
  if (roles === undefined) return set;
  if (!Array.isArray(roles)) { out.add("roles", "invalid_roles", "roles must be a list of role names"); return set; }
  if (roles.length > V2_LIMITS.roles) out.add("roles", "role_budget", `at most ${V2_LIMITS.roles} custom roles`);
  roles.forEach((r, i) => {
    if (typeof r !== "string" || !ROLE_NAME_RE.test(r)) out.add(`roles[${i}]`, "invalid_role", "a role is lowercase letters, digits and _, starting with a letter (max 32)");
    else if (r === "admin" || r === "user") out.add(`roles[${i}]`, "reserved_role", `"${r}" is built in; do not declare it`);
    else if (set.has(r)) out.add(`roles[${i}]`, "invalid_role", `"${r}" is declared twice`);
    else set.add(r);
  });
  return set;
}

function checkCapabilities(out: Issues, caps: unknown): void {
  if (caps === undefined) return;
  if (!Array.isArray(caps)) return out.add("capabilities", "invalid_capabilities", "capabilities must be a list");
  const seen = new Set<unknown>();
  caps.forEach((c, i) => {
    if (!(DEDICATED_CAPABILITIES as readonly unknown[]).includes(c)) out.add(`capabilities[${i}]`, "unknown_capability", `capabilities are ${DEDICATED_CAPABILITIES.join(", ")}`);
    else if (seen.has(c)) out.add(`capabilities[${i}]`, "invalid_capabilities", "declared twice");
    seen.add(c);
  });
}

type RawCols = Record<string, Record<string, unknown>>;
const recordsCol = (cols: RawCols, n: unknown): Record<string, unknown> | null =>
  typeof n === "string" && has(cols, n) && isPlainObject(cols[n]) && (cols[n].kind ?? "records") === "records" ? cols[n] : null;
const propsOf = (c: Record<string, unknown>): Record<string, unknown> =>
  isPlainObject(c.schema) && isPlainObject(c.schema.properties) ? c.schema.properties : {};
const refsOf = (c: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  isPlainObject(c.references) ? (c.references as Record<string, Record<string, unknown>>) : {};
const statesOf = (c: Record<string, unknown>): Record<string, unknown> | null => (isPlainObject(c.states) ? c.states : null);

function checkReferenceGraph(out: Issues, cols: RawCols): void {
  const edges = new Map<string, string[]>();
  let total = 0;
  for (const [name, c] of Object.entries(cols)) {
    if (!isPlainObject(c)) continue;
    for (const [f, r] of Object.entries(refsOf(c))) {
      total++;
      if (!isPlainObject(r) || typeof r.collection !== "string") continue;
      if (!recordsCol(cols, r.collection)) {
        out.add(`collections.${name}.references.${f}.collection`, "unknown_collection", `"${r.collection}" is not a records collection`);
        continue;
      }
      edges.set(name, [...(edges.get(name) ?? []), r.collection]);
    }
  }
  if (total > V2_LIMITS.referencesPerSite) out.add("collections", "reference_budget", `at most ${V2_LIMITS.referencesPerSite} references per site`);
  const depth = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  let cyclic = false;
  const visit = (n: string): number => {
    if (state.get(n) === 2) return depth.get(n) as number;
    if (state.get(n) === 1) { cyclic = true; return 0; }
    state.set(n, 1);
    let d = 0;
    for (const t of edges.get(n) ?? []) d = Math.max(d, 1 + visit(t));
    state.set(n, 2);
    depth.set(n, d);
    return d;
  };
  for (const n of edges.keys()) visit(n);
  if (cyclic) out.add("collections", "reference_cycle", "references must not form a cycle (a collection may not reference itself, directly or through others)");
  else {
    for (const [n, d] of depth) {
      if (d > V2_LIMITS.referenceDepth) out.add(`collections.${n}.references`, "reference_depth", `a reference chain is at most ${V2_LIMITS.referenceDepth} deep`);
    }
  }
}

const isIntField = (props: Record<string, unknown>, f: unknown) =>
  typeof f === "string" && prop(props, f)?.type === "integer";
const isRecipientCol = (c: Record<string, unknown> | null) => !!c && c.recipient !== undefined;

function checkActions(out: Issues, actions: unknown, cols: RawCols, ctx: PCtx): void {
  if (actions === undefined) return;
  if (!isPlainObject(actions)) return out.add("actions", "invalid_actions", "actions must be an object of { name: action }");
  const names = new Set<string>();
  const callable = (n: unknown, at: string) => {
    if (typeof n !== "string" || !NAME_RE.test(n)) return out.add(at, "invalid_name", "action names are lowercase letters, digits and _");
    if (names.has(n)) out.add(at, "duplicate_action", `"${n}" is already an action name`);
    names.add(n);
  };
  const intIn = (v: unknown) => isInt(v);
  const delta = (at: string, v: unknown) => {
    if (!isInt(v) || v === 0 || Math.abs(v) > V2_LIMITS.maxDelta) out.add(at, "invalid_delta", `delta is a non-zero whole number with |delta| <= ${V2_LIMITS.maxDelta}`);
  };
  const counters = new Map<string, unknown>();
  for (const [name, a] of Object.entries(actions)) {
    const at = `actions.${name}`;
    callable(name, at);
    if (!isPlainObject(a)) { out.add(at, "invalid_action", "an action must be an object"); continue; }
    for (const k of Object.keys(a)) {
      if (!["target", "delta", "initial", "bounds", "creates", "principals", "idempotency", "inverse"].includes(k)) out.add(`${at}.${k}`, "unsupported_keyword", `unsupported action keyword "${k}"`);
    }
    if (a.idempotency !== "required") out.add(`${at}.idempotency`, "idempotency_required", 'idempotency must be "required"');
    delta(`${at}.delta`, a.delta);
    if (!intIn(a.initial)) out.add(`${at}.initial`, "invalid_action", "initial must be a whole number");

    const tgt = isPlainObject(a.target) ? a.target : null;
    const tcol = tgt ? recordsCol(cols, tgt.collection) : null;
    const tprops = tcol ? propsOf(tcol) : {};
    if (!tgt || !tcol) out.add(`${at}.target`, "invalid_action_target", '{"collection": "<records collection>", "counter": "<integer field>"}');
    else {
      if (!isIntField(tprops, tgt.counter)) out.add(`${at}.target.counter`, "invalid_counter", "counter must be an integer field of the target collection");
      const st = statesOf(tcol);
      if (st && st.field === tgt.counter) out.add(`${at}.target.counter`, "invalid_counter", "the state field cannot be a counter");
      if (has(refsOf(tcol), String(tgt.counter))) out.add(`${at}.target.counter`, "invalid_counter", "a reference field cannot be a counter");
      const key = `${String(tgt.collection)}.${String(tgt.counter)}`;
      if (counters.has(key) && counters.get(key) !== a.initial) out.add(`${at}.initial`, "invalid_counter", `another action initializes ${key} differently`);
      counters.set(key, a.initial);
    }

    const b = a.bounds;
    if (!isPlainObject(b)) out.add(`${at}.bounds`, "action_needs_bounds", 'every action needs bounds: {"min": n, "max": n} or {"min": n, "maxField": "<integer field>"}');
    else {
      const keys = Object.keys(b).sort().join(",");
      if (keys !== "max,min" && keys !== "maxField,min") out.add(`${at}.bounds`, "action_needs_bounds", 'bounds is {"min", "max"} or {"min", "maxField"}');
      if (!isInt(b.min)) out.add(`${at}.bounds.min`, "action_needs_bounds", "min must be a whole number");
      if (has(b, "max")) {
        if (!isInt(b.max)) out.add(`${at}.bounds.max`, "action_needs_bounds", "max must be a whole number");
        else if (isInt(b.min) && b.max < b.min) out.add(`${at}.bounds.max`, "invalid_bounds", "max is below min");
        else if (isInt(a.initial) && isInt(b.min) && (a.initial < b.min || a.initial > b.max)) out.add(`${at}.initial`, "invalid_bounds", "initial is outside the bounds");
      }
      if (has(b, "maxField")) {
        if (!isIntField(tprops, b.maxField) || (tgt && b.maxField === tgt.counter)) out.add(`${at}.bounds.maxField`, "invalid_bounds", "maxField must be another integer field of the target collection");
      }
      if (isInt(a.initial) && isInt(b.min) && a.initial < b.min) out.add(`${at}.initial`, "invalid_bounds", "initial is below min");
    }

    const cr = isPlainObject(a.creates) ? a.creates : null;
    const ccol = cr ? recordsCol(cols, cr.collection) : null;
    if (!cr || !ccol) out.add(`${at}.creates`, "invalid_action_creates", '{"collection": "<records collection>", "targetField": "<reference to the target>"}');
    else {
      const crules = isPlainObject(ccol.rules) ? ccol.rules : {};
      if (Array.isArray(crules.create) && crules.create.length > 0) {
        out.add(`collections.${String(cr.collection)}.rules.create`, "action_collection_creatable", "a collection an action creates into must have an empty create rule (records only come from the action)");
      }
      const ref = typeof cr.targetField === "string" ? refsOf(ccol)[cr.targetField] : undefined;
      if (!isPlainObject(ref) || !tgt || ref.collection !== tgt.collection) {
        out.add(`${at}.creates.targetField`, "invalid_action_creates", "targetField must be a reference (in references) to the target collection");
      }
    }
    checkPrincipals(out, `${at}.principals`, a.principals, ctx, { anyone: true, recipient: isRecipientCol(tcol) });
    if (Array.isArray(a.principals) && a.principals.length === 0) out.add(`${at}.principals`, "invalid_principals", "an action needs at least one principal");

    if (a.inverse !== undefined) {
      const iat = `${at}.inverse`;
      const inv = a.inverse;
      if (!isPlainObject(inv)) { out.add(iat, "invalid_action", "inverse must be an object"); continue; }
      for (const k of Object.keys(inv)) if (!["name", "delta", "transition", "principals", "idempotency"].includes(k)) out.add(`${iat}.${k}`, "unsupported_keyword", `unsupported inverse keyword "${k}"`);
      callable(inv.name, `${iat}.name`);
      delta(`${iat}.delta`, inv.delta);
      if (inv.idempotency !== "required") out.add(`${iat}.idempotency`, "idempotency_required", 'idempotency must be "required"');
      const st = ccol ? statesOf(ccol) : null;
      const vals = st && Array.isArray(st.values) ? (st.values as unknown[]) : [];
      const t = isPlainObject(inv.transition) ? inv.transition : null;
      if (!st) out.add(`${iat}.transition`, "inverse_needs_states", "an inverse needs states on the created collection");
      else if (!t || !vals.includes(t.from) || !vals.includes(t.to) || t.from === t.to) {
        out.add(`${iat}.transition`, "invalid_transition", "transition is {from, to}: two different states of the created collection");
      }
      checkPrincipals(out, `${iat}.principals`, inv.principals, ctx, { anyone: false, recipient: isRecipientCol(ccol) });
      if (Array.isArray(inv.principals) && inv.principals.length === 0) out.add(`${iat}.principals`, "invalid_principals", "an inverse needs at least one principal");
    }
  }
  const creators = new Map<string, string[]>();
  for (const [name, a] of Object.entries(actions)) {
    if (isPlainObject(a) && isPlainObject(a.creates) && typeof a.creates.collection === "string") {
      creators.set(a.creates.collection, [...(creators.get(a.creates.collection) ?? []), name]);
    }
  }
  for (const [col, list] of creators) {
    if (list.length > 1 && list.some((n) => isPlainObject(actions[n]) && (actions[n] as Record<string, unknown>).inverse !== undefined)) {
      out.add(`actions.${list[1]}.creates`, "shared_action_collection", `"${col}" is created by ${list.join(" and ")}; an action with an inverse needs a collection of its own`);
    }
  }
  if (names.size > V2_LIMITS.callableActions) out.add("actions", "action_budget", `at most ${V2_LIMITS.callableActions} callable action names (inverses count)`);
}

const covers = (list: unknown, principal: string): boolean =>
  Array.isArray(list) && (list.includes("anyone") || list.includes("signed_in") || list.includes(principal));

function checkAggregates(out: Issues, aggregates: unknown, cols: RawCols, ctx: PCtx): void {
  if (aggregates === undefined) return;
  if (!isPlainObject(aggregates)) return out.add("aggregates", "invalid_aggregates", "aggregates must be an object of { name: aggregate }");
  const entries = Object.entries(aggregates);
  if (entries.length > V2_LIMITS.aggregates) out.add("aggregates", "aggregate_budget", `at most ${V2_LIMITS.aggregates} aggregates`);
  for (const [name, g] of entries) {
    const at = `aggregates.${name}`;
    if (!NAME_RE.test(name)) out.add(at, "invalid_name", "aggregate names are lowercase letters, digits and _");
    if (!isPlainObject(g)) { out.add(at, "invalid_aggregate", "an aggregate must be an object"); continue; }
    for (const k of Object.keys(g)) if (!["collection", "fn", "field", "filters", "principals"].includes(k)) out.add(`${at}.${k}`, "unsupported_keyword", `unsupported aggregate keyword "${k}"`);
    const c = recordsCol(cols, g.collection);
    if (!c) { out.add(`${at}.collection`, "unknown_collection", "collection must be a records collection"); continue; }
    const indexes = isPlainObject(c.indexes) ? c.indexes : {};
    const masks = isPlainObject(c.fields) ? c.fields : {};
    const st = statesOf(c);
    if (!(AGGREGATE_FNS as readonly unknown[]).includes(g.fn)) out.add(`${at}.fn`, "invalid_aggregate", `fn is ${AGGREGATE_FNS.join(", ")}`);
    if (g.fn === "count" && g.field !== undefined) out.add(`${at}.field`, "invalid_aggregate", "count takes no field");
    if ((g.fn === "sum" || g.fn === "avg")) {
      const idx = typeof g.field === "string" && has(indexes, g.field) ? indexes[g.field] : null;
      if (!isPlainObject(idx) || idx.type !== "number") out.add(`${at}.field`, "invalid_aggregate", `${String(g.fn)} needs a field with a number index`);
    }
    const filters = g.filters ?? [];
    if (!Array.isArray(filters) || filters.length > V2_LIMITS.aggregateFilters || new Set(filters).size !== filters.length) {
      out.add(`${at}.filters`, "invalid_aggregate", `filters lists at most ${V2_LIMITS.aggregateFilters} distinct fields`);
    } else {
      filters.forEach((f, i) => {
        const ok = typeof f === "string" && ((has(indexes, f) && isPlainObject(indexes[f]) && Array.isArray(indexes[f].ops) && (indexes[f].ops as unknown[]).includes("eq")) || (st !== null && st.field === f));
        if (!ok) out.add(`${at}.filters[${i}]`, "invalid_aggregate", "a filter field needs an index with eq, or is the state field");
      });
    }
    checkPrincipals(out, `${at}.principals`, g.principals, ctx, { anyone: false, recipient: false, onlyAdminRoles: true });
    if (!Array.isArray(g.principals) || g.principals.length === 0) { out.add(`${at}.principals`, "invalid_principals", "an aggregate needs at least one principal"); continue; }
    const rules = isPlainObject(c.rules) ? c.rules : {};
    const touched = [...(typeof g.field === "string" ? [g.field] : []), ...(Array.isArray(filters) ? filters.filter((x): x is string => typeof x === "string") : [])];
    for (const p of g.principals) {
      if (typeof p !== "string") continue;
      if (!covers(rules.list, p)) out.add(`${at}.principals`, "aggregate_exceeds_list", `${p} cannot list ${String(g.collection)}, so it cannot aggregate it`);
      for (const f of touched) {
        const m = has(masks, f) && isPlainObject(masks[f]) ? masks[f] : null;
        if (m && m.read !== undefined && !covers(m.read, p)) out.add(`${at}.principals`, "aggregate_exceeds_field_read", `${p} cannot read ${f}, so it cannot aggregate over it`);
      }
    }
  }
}

export function canonicalPrincipals(p: readonly string[]): string[] {
  const set = [...new Set(p)];
  const rank = (x: string) => (PRINCIPAL_ORDER.includes(x) ? PRINCIPAL_ORDER.indexOf(x) : PRINCIPAL_ORDER.length);
  return set.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalStates(st: Record<string, unknown>): StatesDef {
  const values = [...(st.values as string[])];
  const out: StatesDef = {
    field: st.field as string,
    values,
    initial: st.initial as string,
    transitions: (st.transitions as StateTransition[])
      .map((t) => ({ from: t.from, to: t.to, principals: canonicalPrincipals(t.principals) }))
      .sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to)),
  };
  if (isPlainObject(st.read)) {
    const r = st.read as Record<string, string[]>;
    out.read = Object.fromEntries(values.map((v) => [v, canonicalPrincipals(r[v])]));
  }
  return out;
}

function canonicalCollection(def: Record<string, unknown>): Collection {
  const r = def.rules as Record<string, string[]>;
  const rules = Object.fromEntries(OPS.map((op) => [op, canonicalPrincipals(r[op] ?? [])])) as Rules;
  if ((def.kind ?? "records") === "files") return { kind: "files", rules, schema: {}, fields: {}, indexes: {} };
  const s = def.schema as Record<string, unknown>;
  const schema: CollectionSchema = {
    type: "object",
    properties: s.properties as Record<string, PropertySchema>,
    required: [...new Set((s.required as string[] | undefined) ?? [])].sort(),
  };
  const fields: Record<string, FieldMask> = {};
  for (const [k, m] of Object.entries((def.fields ?? {}) as Record<string, FieldMask>)) {
    fields[k] = {};
    if (m.read) fields[k].read = canonicalPrincipals(m.read);
    if (m.write) fields[k].write = canonicalPrincipals(m.write);
  }
  const indexes: Record<string, IndexDef> = {};
  for (const [k, d] of Object.entries((def.indexes ?? {}) as Record<string, { type: IndexType; ops: IndexOp[]; sort?: boolean }>)) {
    const order = INDEX_OPS[d.type];
    indexes[k] = { type: d.type, ops: [...d.ops].sort((a, b) => order.indexOf(a) - order.indexOf(b)), sort: d.sort === true };
  }
  const references: Record<string, ReferenceDef> = {};
  for (const [k, d] of Object.entries((def.references ?? {}) as Record<string, ReferenceDef>)) references[k] = { collection: d.collection, on_delete: d.on_delete };
  return {
    kind: "records", rules, schema, fields, indexes,
    recipient: isPlainObject(def.recipient) ? { reference: def.recipient.reference as string } : null,
    unique: ((def.unique ?? []) as UniqueDef[]).map((u) => ({ fields: [...u.fields], nulls: u.nulls })),
    states: isPlainObject(def.states) ? canonicalStates(def.states) : null,
    references,
  };
}

function canonicalAction(a: ActionDef): ActionDef {
  const b = a.bounds as Record<string, unknown>;
  const out: ActionDef = {
    target: { collection: a.target.collection, counter: a.target.counter },
    delta: a.delta,
    initial: a.initial,
    bounds: has(b, "maxField") ? { min: b.min as number, maxField: b.maxField as string } : { min: b.min as number, max: b.max as number },
    creates: { collection: a.creates.collection, targetField: a.creates.targetField },
    principals: canonicalPrincipals(a.principals),
    idempotency: "required",
  };
  if (a.inverse) {
    out.inverse = {
      name: a.inverse.name, delta: a.inverse.delta,
      transition: { from: a.inverse.transition.from, to: a.inverse.transition.to },
      principals: canonicalPrincipals(a.inverse.principals), idempotency: "required",
    };
  }
  return out;
}

function canonicalAggregate(g: AggregateDef): AggregateDef {
  const out: AggregateDef = { collection: g.collection, fn: g.fn, filters: [...(g.filters ?? [])].sort(byCodeUnit), principals: canonicalPrincipals(g.principals) };
  if (g.field !== undefined) out.field = g.field;
  return out;
}

const sortedEntries = <T>(o: Record<string, T>): Array<[string, T]> => Object.keys(o).sort(byCodeUnit).map((k) => [k, o[k]]);

export function manifestHash(m: Manifest): string {
  return sha256Hex(canonicalJson(m));
}

const V2_TOP_KEYS = ["roles", "capabilities", "actions", "aggregates"];

function declaredFunctionNames(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!isPlainObject(raw)) return out;
  for (const k of ["endpoints", "schedules"]) {
    const m = raw[k];
    if (isPlainObject(m)) for (const name of Object.keys(m)) if (FUNCTION_NAME_RE.test(name)) out.add(name);
  }
  return out;
}

export function validateManifest(input: unknown): ManifestResult {
  const out = new Issues();
  let doc: unknown = input;
  if (typeof input === "string") {
    try { doc = JSON.parse(input); } catch (e) {
      return { ok: false, issues: [{ path: "", code: "invalid_json", message: `not valid JSON: ${(e as Error).message}` }] };
    }
  }
  if (!isPlainObject(doc)) return { ok: false, issues: [{ path: "", code: "invalid_manifest", message: "zavi-site.json must be a JSON object" }] };
  const version = doc.schemaVersion;
  if (version !== 1 && version !== 2) out.add("schemaVersion", "unsupported_schema_version", "schemaVersion must be 1 or 2");
  const v2 = version === 2;
  for (const k of Object.keys(doc)) {
    if (k === "schemaVersion" || k === "collections" || k === "smoke" || k === "$schema" || k === "functions") continue;
    if (V2_TOP_KEYS.includes(k)) { if (!v2) out.add(k, "unknown_key", `"${k}" needs "schemaVersion": 2`); continue; }
    out.add(k, "unknown_key", `unknown top-level key "${k}" (use schemaVersion, collections, smoke, functions${v2 ? ", roles, capabilities, actions, aggregates" : ""})`);
  }
  const roles = v2 ? checkRoles(out, doc.roles) : new Set<string>();
  if (v2) checkCapabilities(out, doc.capabilities);
  const hasFunctions = doc.functions !== undefined;
  if (hasFunctions) for (const i of checkFunctions(doc.functions, roles)) out.add(i.path, i.code, i.message);
  const ctx: PCtx = { v2, roles, functions: declaredFunctionNames(doc.functions) };
  const cols = doc.collections ?? {};
  if (!isPlainObject(cols)) {
    out.add("collections", "invalid_collections", "collections must be an object of { name: definition }");
    return { ok: false, issues: out.list };
  }
  const names = Object.keys(cols);
  if (names.length > MAX_COLLECTIONS) out.add("collections", "too_many_collections", `at most ${MAX_COLLECTIONS} collections`);
  for (const name of names) {
    const def = cols[name];
    if (!isPlainObject(def)) out.add(`collections.${name}`, "invalid_collection", "a collection must be an object");
    else checkCollection(out, name, def, ctx);
  }
  if (v2) {
    const raw = cols as RawCols;
    checkReferenceGraph(out, raw);
    checkActions(out, doc.actions, raw, ctx);
    checkAggregates(out, doc.aggregates, raw, ctx);
  }
  if (doc.smoke !== undefined) {
    try { canonicalJson(doc.smoke); } catch { out.add("smoke", "invalid_smoke", "smoke must be plain JSON"); }
  }
  if (out.list.length) return { ok: false, issues: out.list };

  const collections: Record<string, Collection> = {};
  for (const name of [...names].sort()) collections[name] = canonicalCollection(cols[name] as Record<string, unknown>);
  const value: Manifest = {
    schemaVersion: v2 ? 2 : 1,
    roles: v2 ? [...((doc.roles as string[] | undefined) ?? [])].sort(byCodeUnit) : [],
    capabilities: v2 ? [...((doc.capabilities as DedicatedCapability[] | undefined) ?? [])].sort(byCodeUnit) : [],
    collections,
    actions: v2 ? Object.fromEntries(sortedEntries((doc.actions ?? {}) as Record<string, ActionDef>).map(([k, a]) => [k, canonicalAction(a)])) : {},
    aggregates: v2 ? Object.fromEntries(sortedEntries((doc.aggregates ?? {}) as Record<string, AggregateDef>).map(([k, g]) => [k, canonicalAggregate(g)])) : {},
  };
  if (hasFunctions) value.functions = canonicalFunctions(doc.functions as Record<string, unknown>);
  if (doc.smoke !== undefined) value.smoke = doc.smoke;
  return { ok: true, value, hash: manifestHash(value) };
}

export function callableActions(m: Manifest): Record<string, { action: string; inverse: boolean }> {
  const out: Record<string, { action: string; inverse: boolean }> = {};
  for (const [name, a] of Object.entries(m.actions)) {
    out[name] = { action: name, inverse: false };
    if (a.inverse) out[a.inverse.name] = { action: name, inverse: true };
  }
  return out;
}

export type ShardCollectionRow = {
  name: string;
  kind: "records" | "files";
  rules: Rules;
  schema: Record<string, unknown>;
  fields: Record<string, FieldMask>;
  indexes: Record<string, IndexDef>;
  recipient: RecipientDef | null;
  uniques: UniqueDef[];
  states: StatesDef | null;
  references: Record<string, ReferenceDef>;
};

export function shardCollectionRow(name: string, c: Collection): ShardCollectionRow {
  const v2 = c.kind === "records" ? c : { recipient: null, unique: [], states: null, references: {} };
  return {
    name, kind: c.kind, rules: c.rules, schema: c.schema, fields: c.fields, indexes: c.indexes,
    recipient: v2.recipient, uniques: v2.unique, states: v2.states, references: v2.references,
  };
}

export type SiteContractRow = {
  schema_version: 1 | 2;
  roles: string[];
  capabilities: DedicatedCapability[];
  actions: Record<string, ActionDef>;
  aggregates: Record<string, AggregateDef>;
};

export function siteContractRow(m: Manifest): SiteContractRow {
  return { schema_version: m.schemaVersion, roles: m.roles, capabilities: m.capabilities, actions: m.actions, aggregates: m.aggregates };
}

export function forbiddenSitePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const n = p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return n === "supabase" || n.startsWith("supabase/") || n.endsWith(".sql");
  });
}
