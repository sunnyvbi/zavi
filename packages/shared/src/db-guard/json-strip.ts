import type { Policy } from "./policy";
import { isSensitiveField } from "./sensitive";
import { structuredClass } from "./pg-structured";

export type SqlStripContext = {
  policy: Policy;
  tables: string[];
  hidden: string[];
  passthrough?: string[];
  fieldNames?: string[];
  structured?: { name: string; kind: "json" | "hstore" }[];
};

const MAX_DEPTH = 12;
export const STRIP_MAX_CELL_CHARS = 1_000_000;
export const STRIP_MAX_CELL_NODES = 100_000;
export const STRIP_MAX_RESULT_CHARS = 20_000_000;
export const STRIP_MAX_RESULT_NODES = 2_000_000;
export const STRIP_MAX_KEY_CHARS = 256;
export const STRIP_MAX_HSTORE_PAIRS = 10_000;
export const UNCHECKED_MARKER = "[hidden: could not check]";

const lc = (s: string) => s.toLowerCase();

function segsOf(key: string): string[] {
  return lc(key)
    .split(".")
    .filter((s) => s.length > 0 && !/^\d+$/.test(s));
}

export type JsonKeyJudge = {
  blocked(path: string[]): boolean;
};

export function columnUnhiddenEverywhere(policy: Policy, tables: string[], column: string): boolean {
  const owners = tables.filter((t) => (policy.resolve(t, true)?.columns ?? []).some((c) => lc(c.name) === lc(column)));
  if (owners.length === 0) return false;
  return owners.every((t) => {
    const name = policy.resolve(t, true)!.columns.find((c) => lc(c.name) === lc(column))!.name;
    return policy.unhiddenFields(t).includes(name);
  });
}

export function jsonKeyJudge(policy: Policy, tables: string[], hidden: string[] = []): JsonKeyJudge {
  const hiddenNames = new Set<string>();
  for (const h of [...hidden, ...tables.flatMap((t) => policy.hiddenFields(t))]) {
    hiddenNames.add(lc(h));
    const segs = segsOf(h);
    if (segs.length > 0) hiddenNames.add(segs[segs.length - 1]!);
  }
  const sensitive = (seg: string) => tables.some((t) => isSensitiveField(t, seg));
  const segBlocked = (seg: string) => hiddenNames.has(seg) || sensitive(seg);
  return {
    blocked(path) {
      if (path.length < 2) return false;
      if (path.slice(1).some((k) => k.length > STRIP_MAX_KEY_CHARS)) return true;
      const segs = path.slice(1).flatMap(segsOf);
      return segs.length > 0 && segBlocked(segs[segs.length - 1]!);
    },
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function stringClose(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 ) j += 2;
    else if (c === 34 ) return j + 1;
    else j++;
  }
  return -1;
}

function stringEnd(s: string, i: number): number {
  const e = stringClose(s, i);
  return e === -1 ? s.length : e;
}

function valueEnd(s: string, i: number): number {
  const n = s.length;
  while (i < n && /\s/.test(s[i]!)) i++;
  if (i >= n) return n;
  const c = s[i]!;
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < n) {
      const ch = s[j]!;
      if (ch === '"') {
        j = stringEnd(s, j);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return n;
  }
  let j = i;
  while (j < n && s[j] !== "," && s[j] !== "}" && s[j] !== "]") j++;
  return j;
}

function decodeKey(raw: string): string {
  if (raw.indexOf("\\") === -1) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function blockedValueRanges(s: string, from: number, column: string, judge: JsonKeyJudge, out: [number, number][]): void {
  const n = s.length;
  let i = s.indexOf('"', from);
  while (i !== -1 && i < n) {
    const end = stringClose(s, i);
    if (end === -1) return;
    let k = end;
    while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r")) k++;
    if (s[k] === ":") {
      const raw = s.slice(i + 1, end - 1);
      if (judge.blocked([column, raw.length > STRIP_MAX_KEY_CHARS * 6 ? raw : decodeKey(raw)])) {
        const vEnd = valueEnd(s, k + 1);
        out.push([k + 1, vEnd]);
        i = s.indexOf('"', Math.max(vEnd, k + 1));
        continue;
      }
    }
    i = s.indexOf('"', end);
  }
}

function scrubKeyText(s: string, column: string, judge: JsonKeyJudge): string {
  if (s.indexOf('"') === -1 || s.indexOf(":") === -1) return s;
  const ranges: [number, number][] = [];
  const first = s.indexOf('"');
  blockedValueRanges(s, first, column, judge, ranges);
  const second = s.indexOf('"', first + 1);
  if (second !== -1) blockedValueRanges(s, second, column, judge, ranges);
  if (ranges.length === 0) return s;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;
  for (const [a, b] of ranges) {
    if (b <= last) continue;
    const start = Math.max(a, last);
    out += s.slice(last, start) + (start === a ? "null" : "");
    last = b;
  }
  return out + s.slice(last);
}

export const HSTORE_UNCHECKED = UNCHECKED_MARKER;

type HstorePair = { key: string; value: string | null };

export function parseHstoreText(s: string): HstorePair[] | null {
  const pairs: HstorePair[] = [];
  let i = 0;
  const n = s.length;
  const quoted = (): string | null => {
    if (s[i] !== '"') return null;
    i++;
    const parts: string[] = [];
    let runStart = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 92 ) {
        const e = s[i + 1];
        if (e !== '"' && e !== "\\") return null;
        parts.push(s.slice(runStart, i), e);
        i += 2;
        runStart = i;
        continue;
      }
      if (c === 34 ) {
        parts.push(s.slice(runStart, i));
        i++;
        return parts.join("");
      }
      i++;
    }
    return null;
  };
  if (n === 0) return pairs;
  for (;;) {
    if (pairs.length >= STRIP_MAX_HSTORE_PAIRS) return null;
    const key = quoted();
    if (key === null) return null;
    if (s.slice(i, i + 2) !== "=>") return null;
    i += 2;
    let value: string | null;
    if (s.slice(i, i + 4) === "NULL") {
      value = null;
      i += 4;
    } else {
      value = quoted();
      if (value === null) return null;
    }
    pairs.push({ key, value });
    if (i === n) break;
    if (s.slice(i, i + 2) !== ", ") return null;
    i += 2;
  }
  return serializeHstore(pairs) === s ? pairs : null;
}

const hq = (x: string) => {
  const parts: string[] = ['"'];
  let runStart = 0;
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c === 34 || c === 92) {
      parts.push(x.slice(runStart, i), "\\", x[i]!);
      runStart = i + 1;
    }
  }
  parts.push(x.slice(runStart), '"');
  return parts.join("");
};

export function serializeHstore(pairs: HstorePair[]): string {
  return pairs.map((p) => `${hq(p.key)}=>${p.value === null ? "NULL" : hq(p.value)}`).join(", ");
}

type Budget = { cellNodes: number; resultNodes: number; chars: number };

class OverBudget extends Error {}

function spend(b: Budget, nodes: number, chars: number): void {
  b.cellNodes += nodes;
  b.resultNodes += nodes;
  b.chars += chars;
  if (b.cellNodes > STRIP_MAX_CELL_NODES || b.resultNodes > STRIP_MAX_RESULT_NODES || b.chars > STRIP_MAX_RESULT_CHARS) throw new OverBudget();
}

function spendString(b: Budget, len: number): void {
  if (len > STRIP_MAX_CELL_CHARS) throw new OverBudget();
  spend(b, 1, len);
}

function stripValue(v: unknown, path: string[], judge: JsonKeyJudge, depth: number, b: Budget, strict = false): unknown {
  if (typeof v === "string") {
    spendString(b, v.length);
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        parsed = undefined;
      }
      if (parsed !== null && typeof parsed === "object") {
        const stripped = stripValue(parsed, path, judge, depth, b, strict);
        return stripped === parsed ? v : JSON.stringify(stripped);
      }
    }
    return scrubKeyText(v, path[0] ?? "", judge);
  }
  if (v === null || typeof v !== "object") {
    spend(b, 1, 0);
    return v;
  }
  if (depth >= MAX_DEPTH) {
    if (strict) throw new OverBudget();
    return null;
  }
  if (Array.isArray(v)) {
    spend(b, 1, 0);
    let changed = false;
    const out = v.map((x) => {
      const y = stripValue(x, path, judge, depth + 1, b, strict);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (!isPlainObject(v)) return v;
  const entries = Object.entries(v);
  spend(b, 1, 0);
  let changed = false;
  const o: Record<string, unknown> = {};
  for (const [k, x] of entries) {
    spend(b, 0, k.length);
    const p = [...path, k];
    if (judge.blocked(p)) {
      changed = true;
      continue;
    }
    const y = stripValue(x, p, judge, depth + 1, b, strict);
    if (y !== x) changed = true;
    o[k] = y;
  }
  return changed ? o : v;
}

function stripStrict(v: unknown, column: string, kinds: Set<"json" | "hstore">, judge: JsonKeyJudge, b: Budget): unknown {
  if (typeof v === "string") {
    spendString(b, v.length);
    if (kinds.has("hstore")) {
      const pairs = parseHstoreText(v);
      if (pairs !== null) {
        spend(b, pairs.length, 0);
        const kept = pairs.filter((p) => !judge.blocked([column, p.key]));
        return kept.length === pairs.length ? v : serializeHstore(kept);
      }
      if (!kinds.has("json")) return UNCHECKED_MARKER;
    }
    const t = v.trimStart();
    if (!t.startsWith("{") && !t.startsWith("[")) return v;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      return UNCHECKED_MARKER;
    }
    if (parsed === null || typeof parsed !== "object") return UNCHECKED_MARKER;
    const stripped = stripValue(parsed, [column], judge, 0, b, true);
    return stripped === parsed ? v : JSON.stringify(stripped);
  }
  if (kinds.has("json") && v !== null && typeof v === "object" && (Array.isArray(v) || isPlainObject(v))) {
    return stripValue(v, [column], judge, 0, b, true);
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) return kinds.has("json") ? v : UNCHECKED_MARKER;
  return UNCHECKED_MARKER;
}

export function stripJsonInRows<R extends Record<string, unknown>>(rows: R[], ctx: SqlStripContext): R[] {
  if (rows.length === 0) return rows;
  const judge = jsonKeyJudge(ctx.policy, ctx.tables, ctx.hidden);
  const names = (ctx.fieldNames ?? []).map(lc);
  const duplicated = new Set(names).size !== names.length;
  const pass = new Set(duplicated ? [] : (ctx.passthrough ?? []));
  const strict = new Map<string, Set<"json" | "hstore">>();
  const mark = (name: string, kind: "json" | "hstore") => strict.set(lc(name), (strict.get(lc(name)) ?? new Set()).add(kind));
  for (const sOut of ctx.structured ?? []) mark(sOut.name, sOut.kind);
  for (const tb of ctx.tables) {
    for (const c of ctx.policy.resolve(tb, true)?.columns ?? []) {
      const cls = structuredClass(c.type);
      if (cls === "json" || cls === "hstore") mark(c.name, cls);
    }
  }
  const b: Budget = { cellNodes: 0, resultNodes: 0, chars: 0 };
  let exhausted = false;
  return rows.map((r) => {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(r)) {
      if (pass.has(k)) continue;
      const kinds = strict.get(lc(k));
      if (!kinds && (v === null || (typeof v !== "object" && typeof v !== "string"))) continue;
      if (kinds && v === null) continue;
      b.cellNodes = 0;
      let y: unknown;
      if (exhausted) y = UNCHECKED_MARKER;
      else {
        try {
          y = kinds ? stripStrict(v, k, kinds, judge, b) : stripValue(v, [k], judge, 0, b);
        } catch {
          y = UNCHECKED_MARKER;
          if (b.resultNodes > STRIP_MAX_RESULT_NODES || b.chars > STRIP_MAX_RESULT_CHARS) exhausted = true;
        }
      }
      if (y !== v) {
        out ??= { ...r };
        out[k] = y;
      }
    }
    return (out ?? r) as R;
  });
}
