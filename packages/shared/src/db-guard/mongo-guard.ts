
import type { Policy } from "./policy";
import { isSensitiveField } from "./sensitive";
import type { Refusal } from "./types";

export const MAX_PIPELINE_STAGES = 12;
export const MAX_QUERY_BYTES = 16 * 1024;
export const MAX_IN_ARRAY = 1000;
export const MAX_OR_BRANCHES = 50;
export const MAX_REGEX_LEN = 512;
export const MAX_VALIDATOR_DEPTH = 30;
export const MAX_ROWS_PER_READ = 5000;
export const MAX_SKIP = 1_000_000;

const BANNED_OPERATORS = new Set<string>([
  "$out",
  "$merge",
  "$function",
  "$accumulator",
  "$where",
  "$expr",
  "$graphLookup",
  "$unionWith",
  "$mapReduce",
]);

const ALLOWED_STAGES = new Set<string>([
  "$match",
  "$project",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$count",
  "$unwind",
  "$lookup",
  "$facet",
  "$addFields",
  "$set",
  "$replaceRoot",
  "$replaceWith",
  "$sortByCount",
  "$bucket",
  "$bucketAuto",
  "$sample",
  "$unset",
]);

const MAX_UNSET_FIELDS = 500;
const UNSET_PATH = /^[^$\u0000][^\u0000]{0,255}$/;

function isUnsetStage(stage: unknown): boolean {
  return stage !== null && typeof stage === "object" && !Array.isArray(stage) && Object.keys(stage).length === 1 && "$unset" in stage;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };
export type ValidationContext = {
  allowedCollections: ReadonlySet<string>;
};

function fail(error: string): ValidationResult {
  return { ok: false, error };
}
const OK: ValidationResult = { ok: true };

function byteSizeOk(value: unknown): ValidationResult {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return fail("mongo_read_unserializable: filter/pipeline is not JSON-serializable");
  }
  if (json.length > MAX_QUERY_BYTES) {
    return fail(
      `mongo_read_too_large: filter/pipeline exceeds ${MAX_QUERY_BYTES} bytes (got ${json.length})`,
    );
  }
  return OK;
}

function validateExpr(value: unknown, depth: number): ValidationResult {
  if (depth > MAX_VALIDATOR_DEPTH) {
    return fail("mongo_read_too_deep: filter/expression nesting exceeds the depth cap");
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      const r = validateExpr(el, depth + 1);
      if (!r.ok) return r;
    }
    return OK;
  }
  if (value === null || typeof value !== "object") return OK;

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return OK;

  for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$")) {
      if (BANNED_OPERATORS.has(key)) {
        return fail(
          `mongo_read_banned_operator: "${key}" is not permitted (server-side JS / write / v1-banned).`,
        );
      }
      if ((key === "$in" || key === "$nin") && Array.isArray(sub)) {
        if (sub.length > MAX_IN_ARRAY) {
          return fail(
            `mongo_read_in_too_large: ${key} array length ${sub.length} exceeds ${MAX_IN_ARRAY}`,
          );
        }
      }
      if ((key === "$or" || key === "$and" || key === "$nor") && Array.isArray(sub)) {
        if (sub.length > MAX_OR_BRANCHES) {
          return fail(
            `mongo_read_branches_too_many: ${key} has ${sub.length} branches (max ${MAX_OR_BRANCHES})`,
          );
        }
      }
      if (key === "$regex" && typeof sub === "string" && sub.length > MAX_REGEX_LEN) {
        return fail(
          `mongo_read_regex_too_long: $regex pattern length ${sub.length} exceeds ${MAX_REGEX_LEN}`,
        );
      }
    }
    const r = validateExpr(sub, depth + 1);
    if (!r.ok) return r;
  }
  return OK;
}

function validateStage(
  stage: unknown,
  depth: number,
  ctx: ValidationContext,
): ValidationResult {
  if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
    return fail("mongo_read_bad_stage: each pipeline stage must be an object");
  }
  const keys = Object.keys(stage as Record<string, unknown>);
  if (keys.length !== 1) {
    return fail(
      `mongo_read_bad_stage: each stage must have exactly one stage operator (got ${keys.length})`,
    );
  }
  const op = keys[0]!;
  const spec = (stage as Record<string, unknown>)[op];

  if (!op.startsWith("$")) {
    return fail(`mongo_read_bad_stage: stage key "${op}" is not a $-operator`);
  }
  if (BANNED_OPERATORS.has(op)) {
    return fail(
      `mongo_read_banned_stage: "${op}" is not permitted (server-side JS / write / v1-banned).`,
    );
  }
  if (!ALLOWED_STAGES.has(op)) {
    return fail(
      `mongo_read_unknown_stage: "${op}" is not in the read-only allowlist.`,
    );
  }

  if (op === "$limit") {
    if (typeof spec !== "number" || !Number.isFinite(spec)) {
      return fail("mongo_read_bad_limit: $limit must be a finite number");
    }
    if (spec < 0) {
      return fail("mongo_read_bad_limit: $limit must not be negative");
    }
    if (spec > MAX_ROWS_PER_READ) {
      return fail(
        `mongo_read_limit_too_large: $limit ${spec} exceeds the row cap ${MAX_ROWS_PER_READ}`,
      );
    }
    return OK;
  }
  if (op === "$skip") {
    if (typeof spec !== "number" || !Number.isFinite(spec)) {
      return fail("mongo_read_bad_skip: $skip must be a finite number");
    }
    if (spec < 0) {
      return fail("mongo_read_bad_skip: $skip must not be negative");
    }
    if (spec > MAX_SKIP) {
      return fail(`mongo_read_skip_too_large: $skip ${spec} exceeds ${MAX_SKIP}`);
    }
    return OK;
  }
  if (op === "$sample") {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      return fail("mongo_read_bad_sample: $sample spec must be an object { size }");
    }
    const size = (spec as Record<string, unknown>).size;
    if (typeof size !== "number" || !Number.isFinite(size)) {
      return fail("mongo_read_bad_sample: $sample.size must be a finite number");
    }
    if (size < 0) {
      return fail("mongo_read_bad_sample: $sample.size must not be negative");
    }
    if (size > MAX_ROWS_PER_READ) {
      return fail(
        `mongo_read_sample_too_large: $sample.size ${size} exceeds the row cap ${MAX_ROWS_PER_READ}`,
      );
    }
    return OK;
  }

  if (op === "$unset") {
    const paths = typeof spec === "string" ? [spec] : spec;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_UNSET_FIELDS) {
      return fail(`mongo_read_bad_unset: $unset takes a field path or a list of 1 to ${MAX_UNSET_FIELDS} field paths`);
    }
    if (!paths.every((x) => typeof x === "string" && UNSET_PATH.test(x))) {
      return fail("mongo_read_bad_unset: $unset entries must be field paths (not starting with $)");
    }
    return OK;
  }

  if (op === "$lookup") {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      return fail("mongo_read_bad_lookup: $lookup spec must be an object");
    }
    const ls = spec as Record<string, unknown>;
    const from = ls.from;
    if (typeof from !== "string" || from.length === 0) {
      return fail("mongo_read_bad_lookup: $lookup.from must be a collection name");
    }
    if (!ctx.allowedCollections.has(from.toLowerCase())) {
      return fail(
        `mongo_read_lookup_not_allowlisted: $lookup.from "${from}" is not in the tenant's discovered collections.`,
      );
    }
    if (Array.isArray(ls.pipeline)) {
      const r = validatePipelineStages(ls.pipeline, depth + 1, ctx);
      if (!r.ok) return r;
    }
    if (ls.let !== undefined) {
      const r = validateExpr(ls.let, depth + 1);
      if (!r.ok) return r;
    }
    return OK;
  }

  if (op === "$facet") {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      return fail("mongo_read_bad_facet: $facet spec must be an object of sub-pipelines");
    }
    for (const [, subPipe] of Object.entries(spec as Record<string, unknown>)) {
      if (!Array.isArray(subPipe)) {
        return fail("mongo_read_bad_facet: each $facet value must be a pipeline array");
      }
      const r = validatePipelineStages(subPipe, depth + 1, ctx);
      if (!r.ok) return r;
    }
    return OK;
  }

  return validateExpr(spec, depth + 1);
}

function validatePipelineStages(
  pipeline: unknown,
  depth: number,
  ctx: ValidationContext,
): ValidationResult {
  if (depth > MAX_VALIDATOR_DEPTH) {
    return fail("mongo_read_too_deep: pipeline nesting exceeds the depth cap");
  }
  if (!Array.isArray(pipeline)) {
    return fail("mongo_read_bad_pipeline: aggregate pipeline must be an array");
  }
  const counted = pipeline.filter((st) => !isUnsetStage(st)).length;
  if (counted > MAX_PIPELINE_STAGES) {
    return fail(
      `mongo_read_too_many_stages: pipeline has ${counted} stages (max ${MAX_PIPELINE_STAGES})`,
    );
  }
  for (const stage of pipeline) {
    const r = validateStage(stage, depth, ctx);
    if (!r.ok) return r;
  }
  return OK;
}

export function validateFind(filter: unknown): ValidationResult {
  const f = filter ?? {};
  if (typeof f !== "object" || Array.isArray(f)) {
    return fail("mongo_read_bad_filter: find filter must be an object");
  }
  const size = byteSizeOk(f);
  if (!size.ok) return size;
  return validateExpr(f, 0);
}

export function validateAggregate(
  pipeline: unknown,
  ctx: ValidationContext,
): ValidationResult {
  const size = byteSizeOk(pipeline);
  if (!size.ok) return size;
  return validatePipelineStages(pipeline, 0, ctx);
}

export function pipelineHasLimit(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      !Array.isArray(s) &&
      Object.prototype.hasOwnProperty.call(s, "$limit"),
  );
}

export type MongoGuardOptions = { policy: Policy };
export const MAX_STRIP_DEPTH = 12;

const refuseMongo = (reason: string, rule?: "settings"): Refusal => ({ ok: false, reason, refused_by: "zavi", ...(rule ? { rule } : {}) });

export function normalizePath(path: string): string[] {
  return path
    .toLowerCase()
    .split(".")
    .filter((seg) => seg.length > 0 && !/^\d+$/.test(seg) && !seg.startsWith("$"));
}
const rawSegs = (path: string) => path.toLowerCase().split(".").filter((s) => s.length > 0);

type HiddenSet = { names: string[]; raw: string[][]; norm: string[][]; known: Set<string>; unhidden: Set<string>; tables: string[] };
function hiddenSetOf(policy: Policy, collections: string[]): HiddenSet {
  const names = [...new Set(collections.flatMap((c) => policy.hiddenFields(c)))];
  const known = new Set<string>();
  const unhidden = new Set<string>();
  for (const c of collections) {
    const t = policy.resolve(c, true);
    for (const col of t?.columns ?? []) known.add(normalizePath(col.name).join("."));
    for (const u of policy.unhiddenFields(c)) unhidden.add(normalizePath(u).join("."));
  }
  return { names, raw: names.map(rawSegs), norm: names.map(normalizePath), known, unhidden, tables: collections };
}

function unprotectableHidden(hidden: HiddenSet): string | null {
  return hidden.names.find((n) => n.split(".").some((seg) => seg.startsWith("$"))) ?? null;
}

function unknownSensitive(path: string, hidden: HiddenSet): string | null {
  const segs = normalizePath(path);
  for (let i = 1; i <= segs.length; i++) {
    const prefix = segs.slice(0, i).join(".");
    const seg = segs[i - 1]!;
    if (!hidden.tables.some((t) => isSensitiveField(t, seg))) continue;
    if (hidden.known.has(prefix) || hidden.unhidden.has(prefix)) continue;
    return prefix;
  }
  return null;
}

function segMatch(p: string[], hs: string[]): boolean {
  if (p.length === 0 || hs.length === 0) return false;
  for (let i = 0; i + hs.length <= p.length; i++) if (hs.every((s, k) => p[i + k] === s)) return true;
  return p.length < hs.length && p.every((s, k) => hs[k] === s);
}

function touchesHidden(path: string, hidden: HiddenSet): string | null {
  const raw = rawSegs(path);
  const norm = normalizePath(path);
  for (let h = 0; h < hidden.names.length; h++) {
    if (segMatch(raw, hidden.raw[h]!) || segMatch(norm, hidden.norm[h]!)) return hidden.names[h]!;
  }
  return unknownSensitive(path, hidden);
}

function stringFieldPath(v: string): string | null {
  if (!v.startsWith("$")) return null;
  if (v.startsWith("$$")) {
    const dot = v.indexOf(".");
    return dot === -1 ? null : v.slice(dot + 1);
  }
  return v.slice(1);
}

const ALWAYS_REFUSED = new Set(["$objectToArray", "$jsonSchema", "$text", "$where", "$function", "$accumulator", "$expr"]);
const HIDDEN_REFUSED = new Set(["$setField", "$unsetField"]);

function scanRefs(value: unknown, hidden: HiddenSet, prefix: string, depth: number): string | null {
  const anyHidden = hidden.names.length > 0;
  if (depth > MAX_VALIDATOR_DEPTH) return "the query is nested too deeply";
  if (typeof value === "string") {
    if (anyHidden && /^\$\$(root|current)(\.|$)/i.test(value)) return "whole-document references ($$ROOT, $$CURRENT) are not allowed while fields are hidden";
    const fp = stringFieldPath(value);
    return fp ? touchesHidden(fp, hidden) : null;
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      const r = scanRefs(el, hidden, prefix, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
    if (ALWAYS_REFUSED.has(key)) return `${key} is not allowed by Zavi's database guard`;
    if (anyHidden && HIDDEN_REFUSED.has(key)) return `${key} is not allowed while fields are hidden`;
    if (key === "$getField") {
      const field = typeof sub === "string" ? sub : (sub as Record<string, unknown> | null)?.field;
      if (typeof field !== "string") return "$getField needs a literal field name";
      if (field.startsWith("$")) return "$getField with a computed field name is not allowed";
      const r = touchesHidden(field, hidden);
      if (r) return r;
    }
    let nextPrefix = prefix;
    if (!key.startsWith("$")) {
      const r = touchesHidden(key, hidden) ?? (prefix ? touchesHidden(`${prefix}.${key}`, hidden) : null);
      if (r) return r;
      nextPrefix = prefix ? `${prefix}.${key}` : key;
    }
    const r = scanRefs(sub, hidden, nextPrefix, depth + 1);
    if (r) return r;
  }
  return null;
}

function withoutExclusions(spec: unknown): unknown {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) if (v !== 0 && v !== false) out[k] = v;
  return out;
}

function hiddenRefusal(coll: string, hit: string): Refusal {
  if (hit.includes(" ")) return refuseMongo(`Zavi could not check this query: ${hit}.`, /while fields are hidden/.test(hit) ? "settings" : undefined);
  return refuseMongo(`${coll}.${hit} is hidden in What Zavi can see (or looks personal and is not in the discovered schema). Rewrite the query without it.`, "settings");
}

function resolveCollection(coll: unknown, policy: Policy): { name: string } | Refusal {
  if (typeof coll !== "string" || coll.length === 0) return refuseMongo("A collection name is required.");
  const t = policy.resolve(coll, true);
  if (!t) return refuseMongo(`${coll} is not a collection Zavi may read. Use one of the collections listed by operator_db__catalog.`, "settings");
  return { name: t.name };
}

export type MongoFindGuardOk = {
  ok: true;
  collection: string;
  filter: Record<string, unknown>;
  options: Record<string, unknown>;
  hidden: string[];
  touched: string[];
};

export function guardMongoFind(
  coll: string,
  filter: unknown,
  options: Record<string, unknown> | undefined,
  { policy }: MongoGuardOptions,
): MongoFindGuardOk | Refusal {
  const c = resolveCollection(coll, policy);
  if ("ok" in c) return c;
  const v = validateFind(filter);
  if (!v.ok) return refuseMongo(v.error);
  const hidden = hiddenSetOf(policy, [c.name]);
  const bad = unprotectableHidden(hidden);
  if (bad) return refuseMongo(`${c.name}.${bad} starts with $, so Zavi cannot remove it reliably. Rename the field or switch the collection off.`);
  const f = (filter ?? {}) as Record<string, unknown>;
  const opts = { ...(options ?? {}) };
  for (const part of [f, withoutExclusions(opts.projection), opts.sort, opts.hint]) {
    const hit = scanRefs(part, hidden, "", 0);
    if (hit) return hiddenRefusal(c.name, hit);
  }
  if (hidden.names.length > 0) {
    const proj = opts.projection as Record<string, unknown> | undefined;
    const isInclusion =
      proj !== undefined &&
      Object.entries(proj).some(([k, val]) => k !== "_id" && val !== 0 && val !== false);
    if (!isInclusion) {
      const excl: Record<string, unknown> = { ...(proj ?? {}) };
      for (const h of hidden.names) excl[h] = 0;
      opts.projection = excl;
    }
  }
  return { ok: true, collection: c.name, filter: f, options: opts, hidden: hidden.names, touched: [c.name] };
}

export function guardMongoCount(coll: string, filter: unknown, { policy }: MongoGuardOptions):
  | { ok: true; collection: string; filter: Record<string, unknown> }
  | Refusal {
  const c = resolveCollection(coll, policy);
  if ("ok" in c) return c;
  const v = validateFind(filter);
  if (!v.ok) return refuseMongo(v.error);
  const hidden = hiddenSetOf(policy, [c.name]);
  const hit = scanRefs(filter ?? {}, hidden, "", 0);
  if (hit) return hiddenRefusal(c.name, hit);
  return { ok: true, collection: c.name, filter: (filter ?? {}) as Record<string, unknown> };
}

export type MongoAggregateGuardOk = { ok: true; collection: string; pipeline: Record<string, unknown>[]; hidden: string[]; touched: string[] };

function lookupTargets(pipeline: unknown[], out: string[], depth: number): void {
  if (depth > MAX_VALIDATOR_DEPTH) return;
  for (const st of pipeline) {
    if (!st || typeof st !== "object") continue;
    const [op, spec] = Object.entries(st as Record<string, unknown>)[0] ?? [];
    if (op === "$lookup" && spec && typeof spec === "object") {
      const ls = spec as Record<string, unknown>;
      if (typeof ls.from === "string") out.push(ls.from);
      if (Array.isArray(ls.pipeline)) lookupTargets(ls.pipeline, out, depth + 1);
    } else if (op === "$facet" && spec && typeof spec === "object") {
      for (const sub of Object.values(spec as Record<string, unknown>)) if (Array.isArray(sub)) lookupTargets(sub, out, depth + 1);
    }
  }
}

export function guardMongoAggregate(coll: string, pipeline: unknown, { policy }: MongoGuardOptions): MongoAggregateGuardOk | Refusal {
  const c = resolveCollection(coll, policy);
  if ("ok" in c) return c;
  if (!Array.isArray(pipeline)) return refuseMongo("mongo_read_bad_pipeline: aggregate pipeline must be an array");
  const allowedLower = new Set([...policy.allowed.keys()].map((k) => k.toLowerCase()));
  const v = validateAggregate(pipeline, { allowedCollections: allowedLower });
  if (!v.ok) {
    if (/\$graphLookup|\$unionWith/.test(v.error)) return refuseMongo("$graphLookup and $unionWith are not supported by Zavi's database guard.");
    return refuseMongo(v.error);
  }
  const targets: string[] = [];
  lookupTargets(pipeline, targets, 0);
  const touched = [c.name];
  for (const tg of targets) {
    const r = resolveCollection(tg, policy);
    if ("ok" in r) return r;
    touched.push(r.name);
  }
  const hidden = hiddenSetOf(policy, touched);
  const bad = unprotectableHidden(hidden);
  if (bad) return refuseMongo(`${bad} starts with $, so Zavi cannot remove it reliably. Rename the field or switch the collection off.`);

  const transform = (stages: unknown[], bound: string, depth: number): Record<string, unknown>[] | Refusal => {
    const out: Record<string, unknown>[] = [];
    const own = policy.hiddenFields(bound);
    if (own.length > 0) out.push({ $unset: [...own] });
    for (const st of stages) {
      const [op, spec] = Object.entries(st as Record<string, unknown>)[0]!;
      if (op === "$lookup") {
        const ls = { ...(spec as Record<string, unknown>) };
        const from = policy.resolve(ls.from as string, true)!.name;
        if (typeof ls.localField === "string") {
          const hit = touchesHidden(ls.localField, hidden);
          if (hit) return hiddenRefusal(bound, hit);
        }
        if (typeof ls.foreignField === "string") {
          const hit = touchesHidden(ls.foreignField, hidden);
          if (hit) return hiddenRefusal(from, hit);
        }
        if (ls.let !== undefined) {
          const hit = scanRefs(ls.let, hidden, "", depth + 1);
          if (hit) return hiddenRefusal(bound, hit);
        }
        const asHit = typeof ls.as === "string" ? touchesHidden(ls.as, hidden) : null;
        if (asHit) return hiddenRefusal(bound, asHit);
        const sub = Array.isArray(ls.pipeline) ? ls.pipeline : [];
        const t = transform(sub, from, depth + 1);
        if (!Array.isArray(t)) return t;
        if (Array.isArray(ls.pipeline) || t.length > 0) ls.pipeline = t;
        out.push({ $lookup: ls });
        continue;
      }
      if (op === "$facet") {
        const branches: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(spec as Record<string, unknown>)) {
          const t = transform(sub as unknown[], bound, depth + 1);
          if (!Array.isArray(t)) return t;
          branches[name] = t;
        }
        out.push({ $facet: branches });
        continue;
      }
      const scanned = op === "$unset" ? null : op === "$project" ? withoutExclusions(spec) : spec;
      const hit = scanned === null ? null : scanRefs(scanned, hidden, "", depth + 1);
      if (hit) return hiddenRefusal(bound, hit);
      out.push(st as Record<string, unknown>);
    }
    return out;
  };
  const t = transform(pipeline, c.name, 0);
  if (!Array.isArray(t)) return t;
  return { ok: true, collection: c.name, pipeline: t, hidden: hidden.names, touched };
}

export function stripHiddenDeep<T>(doc: T, names: string[]): T {
  if (names.length === 0) return doc;
  const keys = new Set<string>();
  for (const n of names) {
    keys.add(n.toLowerCase());
    const segs = n.split(".");
    keys.add(segs[segs.length - 1]!.toLowerCase());
    const norm = normalizePath(n);
    if (norm.length > 0) {
      keys.add(norm.join("."));
      keys.add(norm[norm.length - 1]!);
    }
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_STRIP_DEPTH) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (keys.has(k.toLowerCase())) continue;
      o[k] = walk(x, depth + 1);
    }
    return o;
  };
  return walk(doc, 0) as T;
}

export function mongoResultStripper(policy: Policy, collections: string[]): <T>(doc: T) => T {
  const hidden = hiddenSetOf(policy, collections);
  return <T>(doc: T): T => {
    const base = stripHiddenDeep(doc, hidden.names);
    const walk = (v: unknown, path: string, depth: number): unknown => {
      if (v === null || typeof v !== "object") return v;
      if (depth >= MAX_STRIP_DEPTH) return null;
      if (Array.isArray(v)) return v.map((x) => walk(x, path, depth + 1));
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        const u = unknownSensitive(p, hidden);
        if (u !== null && u === normalizePath(p).join(".")) continue;
        o[k] = walk(x, p, depth + 1);
      }
      return o;
    };
    return walk(base, "", 0) as T;
  };
}
