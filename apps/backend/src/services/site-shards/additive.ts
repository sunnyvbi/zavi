
import { canonical, defValue } from "./collections-plan";
import type { CollectionDef, SiteContractDef } from "./contract";

export const NOT_ADDITIVE = "not_additive";

type Prop = Record<string, unknown>;
type PrincipalMap = Record<string, unknown>;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const lacks = (want: string[], have: string[]): string[] => want.filter((p) => !have.includes(p));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function propertyNarrowed(from: Prop, to: Prop): string | null {
  if (from.type !== to.type) return `changes type from ${String(from.type)} to ${String(to.type)}`;
  if (from.format !== to.format && to.format !== undefined) return `changes format to ${String(to.format)}`;
  const fMax = num(from.maxLength), tMax = num(to.maxLength);
  if (tMax !== null && (fMax === null || tMax < fMax)) return `lowers maxLength to ${tMax}`;
  const fMin = num(from.minLength), tMin = num(to.minLength);
  if (tMin !== null && tMin > (fMin ?? 0)) return `raises minLength to ${tMin}`;
  if (Array.isArray(to.enum)) {
    if (!Array.isArray(from.enum)) return "restricts the field to a list of values";
    const gone = lacks(list(from.enum), list(to.enum));
    if (gone.length) return `drops the value(s) ${gone.slice(0, 5).join(", ")}`;
  }
  const fLo = num(from.minimum), tLo = num(to.minimum);
  if (tLo !== null && (fLo === null || tLo > fLo)) return `raises minimum to ${tLo}`;
  const fHi = num(from.maximum), tHi = num(to.maximum);
  if (tHi !== null && (fHi === null || tHi < fHi)) return `lowers maximum to ${tHi}`;
  const fItems = num(from.maxItems), tItems = num(to.maxItems);
  if (tItems !== null && (fItems === null || tItems < fItems)) return `lowers maxItems to ${tItems}`;
  if (from.type === "array") {
    const inner = propertyNarrowed(obj(from.items), obj(to.items));
    if (inner) return `items ${inner}`;
  }
  return null;
}

function principalsLost(from: PrincipalMap, to: PrincipalMap): string[] {
  const out: string[] = [];
  for (const [op, who] of Object.entries(from)) {
    if (!(op in to)) out.push(`${op} (removed)`);
    else {
      const gone = lacks(list(who), list(to[op]));
      if (gone.length) out.push(`${op} for ${gone.join(", ")}`);
    }
  }
  return out;
}

function collectionProblems(c: CollectionDef, d: CollectionDef): string[] {
  const out: string[] = [];
  const n = `collection "${d.name}"`;
  if (c.kind !== d.kind) out.push(`${n} changes from ${c.kind} to ${d.kind}`);

  const lost = principalsLost(obj(defValue(c, "rules")), obj(defValue(d, "rules")));
  if (lost.length) out.push(`${n} tightens its rules: ${lost.join("; ")}`);

  const cs = obj(defValue(c, "schema"));
  const ds = obj(defValue(d, "schema"));
  const cp = obj(cs.properties);
  const dp = obj(ds.properties);
  const creq = list(cs.required);
  const dreq = list(ds.required);
  for (const [f, p] of Object.entries(cp)) {
    if (!(f in dp)) {
      out.push(`${n} removes the field "${f}"`);
      continue;
    }
    const why = propertyNarrowed(obj(p), obj(dp[f]));
    if (why) out.push(`${n} field "${f}" ${why}`);
  }
  for (const f of dreq) {
    if (creq.includes(f)) continue;
    out.push(f in cp ? `${n} makes the existing field "${f}" required` : `${n} adds "${f}" as a required field`);
  }

  const isNewField = (f: string) => !(f in cp);
  const cm = obj(defValue(c, "fields"));
  const dm = obj(defValue(d, "fields"));
  for (const f of Object.keys(dm)) {
    const before = obj(cm[f]);
    const after = obj(dm[f]);
    for (const k of Object.keys(after)) {
      if (!(k in before) && !isNewField(f)) out.push(`${n} adds a ${k} mask to the field "${f}"`);
    }
    const lostMask = Object.keys(before).filter((k) => k in after).flatMap((k) => lacks(list(before[k]), list(after[k])).map((p) => `${k} for ${p}`));
    if (lostMask.length) out.push(`${n} tightens the mask of "${f}": ${lostMask.join("; ")}`);
  }

  const st0 = defValue(c, "states") as CollectionDef["states"];
  const st1 = defValue(d, "states") as CollectionDef["states"];
  if (st0 && !st1) out.push(`${n} removes its state machine`);
  else if (!st0 && st1) {
    if (!isNewField(st1.field)) out.push(`${n} turns the existing field "${st1.field}" into a state machine`);
  } else if (st0 && st1) {
    if (st0.field !== st1.field) out.push(`${n} moves its state machine to another field`);
    const gone = lacks(st0.values, st1.values);
    if (gone.length) out.push(`${n} drops the state(s) ${gone.join(", ")}`);
    if (st0.initial !== st1.initial) out.push(`${n} changes its initial state`);
    for (const t of st0.transitions) {
      const now = st1.transitions.find((x) => x.from === t.from && x.to === t.to);
      if (!now) out.push(`${n} removes the transition ${t.from} -> ${t.to}`);
      else if (lacks(t.principals, now.principals).length) out.push(`${n} narrows who may move ${t.from} -> ${t.to}`);
    }
    if (!st0.read && st1.read) out.push(`${n} restricts who may read its states`);
    const lostRead = principalsLost(obj(st0.read), obj(st1.read));
    if (lostRead.length) out.push(`${n} narrows who may read states: ${lostRead.join("; ")}`);
  }

  const r0 = obj(defValue(c, "references"));
  const r1 = obj(defValue(d, "references"));
  for (const [f, ref] of Object.entries(r0)) {
    if (!(f in r1)) out.push(`${n} removes the reference "${f}"`);
    else if (canonical(ref) !== canonical(r1[f])) out.push(`${n} changes the reference "${f}"`);
  }
  for (const f of Object.keys(r1)) {
    if (!(f in r0) && !isNewField(f)) out.push(`${n} turns the existing field "${f}" into a reference`);
  }

  const rc0 = defValue(c, "recipient");
  const rc1 = defValue(d, "recipient");
  if (rc0 && canonical(rc0) !== canonical(rc1)) out.push(`${n} changes its recipient`);
  else if (!rc0 && rc1) {
    const ref = (rc1 as { reference?: unknown }).reference;
    if (typeof ref !== "string" || !isNewField(ref)) out.push(`${n} derives a recipient from the existing field "${String(ref)}"`);
  }

  const u0 = (defValue(c, "unique") as NonNullable<CollectionDef["unique"]>) ?? [];
  const u1 = (defValue(d, "unique") as NonNullable<CollectionDef["unique"]>) ?? [];
  for (const u of u1) {
    const was = u0.find((x) => canonical(x.fields) === canonical(u.fields));
    if (!was) out.push(`${n} adds a unique rule on ${u.fields.join(", ")}`);
    else if (was.nulls === "distinct" && u.nulls === "not_distinct") out.push(`${n} makes the unique rule on ${u.fields.join(", ")} stricter`);
  }
  return out;
}

function contractProblems(a: SiteContractDef, b: SiteContractDef): string[] {
  const out: string[] = [];
  const roles = lacks(a.roles, b.roles);
  if (roles.length) out.push(`removes the role(s) ${roles.join(", ")}`);
  const caps = lacks(a.capabilities, b.capabilities);
  if (caps.length) out.push(`removes the capability ${caps.join(", ")}`);
  for (const [name, act] of Object.entries(a.actions)) {
    if (!(name in b.actions)) out.push(`removes the action "${name}"`);
    else if (canonical(act) !== canonical(b.actions[name])) out.push(`changes the action "${name}"`);
  }
  for (const [name, agg] of Object.entries(a.aggregates)) {
    if (!(name in b.aggregates)) out.push(`removes the aggregate "${name}"`);
    else if (canonical(agg) !== canonical(b.aggregates[name])) out.push(`changes the aggregate "${name}"`);
  }
  return out;
}

export function nonAdditiveChanges(
  current: readonly CollectionDef[],
  desired: readonly CollectionDef[],
  currentContract: SiteContractDef,
  desiredContract: SiteContractDef,
): string[] {
  const out: string[] = [];
  const want = new Map(desired.map((d) => [d.name, d]));
  for (const c of current) {
    const d = want.get(c.name);
    if (c.archived === true) {
      if (d) out.push(...collectionProblems(c, d).map((m) => `${m} (reviving an archived collection)`));
      continue;
    }
    if (!d) {
      out.push(`removes the collection "${c.name}"`);
      continue;
    }
    out.push(...collectionProblems(c, d));
  }
  out.push(...contractProblems(currentContract, desiredContract));
  return out;
}

export function notAdditiveReason(problems: readonly string[]): string {
  const shown = problems.slice(0, 8).join("; ");
  const more = problems.length > 8 ? ` (and ${problems.length - 8} more)` : "";
  return (
    `This change to zavi-site.json is not additive: it ${shown}${more}. A live site's data model can only grow for now: ` +
    `add new collections and new optional fields, widen limits, or grant more access. Keep every existing collection, ` +
    `field, rule and value as it is (add a new field or collection instead of changing one). Nothing was changed.`
  );
}
