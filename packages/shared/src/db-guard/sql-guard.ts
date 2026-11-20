import type { Policy } from "./policy";
import type { Refusal } from "./types";
import { lexSql, type SqlDialect, type Token } from "./sql-lexer";
import { isAllowedFunction } from "./sql-functions";
import { columnUnhiddenEverywhere } from "./json-strip";
import { structuredClass } from "./pg-structured";
import { isSensitiveField } from "./sensitive";

export type SqlGuardOptions = {
  policy: Policy;
  dialect: SqlDialect;
  mysqlDatabase?: string | null;
};

export type SqlGuardOk = {
  ok: true;
  sql: string;
  tables: string[];
  hidden: string[];
  passthrough: string[];
  structured: StructuredOutput[];
};

export type StructuredOutput = { name: string; kind: "json" | "hstore" };

const CLAUSE_END = new Set([
  "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "FETCH", "FOR",
]);
const JOIN_WORDS = new Set(["JOIN", "STRAIGHT_JOIN"]);
const TYPE_WORDS = new Set(["with", "without", "time", "zone", "varying", "precision", "double", "character", "unsigned", "signed"]);

type Frame = {
  kind: "top" | "expr" | "func" | "typeargs" | "fromparen" | "aliascols" | "ctebody";
  fname?: string;
  aliasFor?: Relation | null;
  fromList: boolean;
  expect: "relation" | "alias" | "alias-after-as" | null;
  decided: boolean;
  ctes: Set<string>;
  pendingCte?: { name: string; scope: Frame };
};

type Relation = { table: string; start: number; end: number; qualified: boolean; hasAlias: boolean };

const PG_TYPES = new Set([
  "int", "int2", "int4", "int8", "integer", "smallint", "bigint", "numeric", "decimal", "real", "float", "float4", "float8",
  "double", "text", "varchar", "char", "character", "bpchar", "boolean", "bool", "date", "time", "timetz", "timestamp",
  "timestamptz", "interval", "json", "jsonb", "uuid", "bytea", "money", "name", "citext",
]);
const MYSQL_TYPES = new Set([
  "char", "nchar", "binary", "signed", "unsigned", "decimal", "date", "datetime", "time", "json", "double", "float", "real", "integer", "year",
]);
const PG_OPS = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "^", "||", "~", "~*", "!~", "!~*", "~~", "~~*", "!~~", "!~~*",
  "->", "->>", "#>", "#>>", "@>", "<@", "&", "|", "#", "<<", ">>",
]);
const MYSQL_OPS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "<=>", "+", "-", "*", "/", "%", "||", "&&", "!", "~", "&", "|", "^", "<<", ">>", "->", "->>"]);
const OP_CHARS = new Set(["+", "-", "*", "/", "<", ">", "=", "~", "!", "@", "#", "%", "^", "&", "|", "`", "?"]);

const refuse = (reason: string, rule?: "settings"): Refusal => ({ ok: false, reason, refused_by: "zavi", ...(rule ? { rule } : {}) });

function quoteIdent(name: string, dialect: SqlDialect): string {
  return dialect === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

function displayName(parts: Token[]): string {
  return parts.map((p) => p.value).join(".");
}

export function guardSql(sql: string, opts: SqlGuardOptions): SqlGuardOk | Refusal {
  const { policy, dialect } = opts;
  const lexed = lexSql(sql, dialect);
  if (lexed.unsafe) return refuse(lexed.unsafe);
  const t = lexed.tokens;

  const top: Frame = { kind: "top", fromList: false, expect: null, decided: true, ctes: new Set() };
  const stack: Frame[] = [top];
  const cur = () => stack[stack.length - 1]!;
  const relations: Relation[] = [];
  const names = new Set<string>();

  const qualifiedRefs: { parts: Token[] }[] = [];
  const idents: Token[] = [];

  const cteVisible = (name: string, quoted: boolean): boolean => {
    const key = quoted ? name : name.toLowerCase();
    for (let k = stack.length - 1; k >= 0; k--) {
      for (const c of stack[k]!.ctes) if ((quoted ? c : c.toLowerCase()) === key) return true;
    }
    return false;
  };

  const readName = (i: number): { parts: Token[]; next: number } => {
    const parts: Token[] = [t[i]!];
    let j = i + 1;
    while (t[j]?.value === "." && t[j + 1] && (t[j + 1]!.kind === "ident" || t[j + 1]!.kind === "keyword")) {
      parts.push(t[j + 1]!);
      j += 2;
    }
    return { parts, next: j };
  };

  const resolveRelation = (parts: Token[]): { table: string } | { cte: true } | { reason: string } => {
    const shown = displayName(parts);
    const notReadable = { reason: `${shown} is not a table Zavi may read. Use one of the tables listed by operator_db__catalog.`, rule: "settings" as const };
    if (parts.length === 1) {
      const p = parts[0]!;
      if (cteVisible(p.value, p.quoted)) return { cte: true };
      if (dialect === "mysql" && !p.quoted && p.value.toLowerCase() === "dual") return { cte: true };
      const r = policy.resolve(p.value, p.quoted);
      return r ? { table: r.name } : notReadable;
    }
    if (parts.length === 2 && dialect === "postgres") {
      const [s, leaf] = parts as [Token, Token];
      const schema = s.quoted ? s.value : s.value.toLowerCase();
      if (schema !== "public") return notReadable;
      const r = policy.resolve(leaf.value, leaf.quoted);
      return r ? { table: r.name } : notReadable;
    }
    if (parts.length === 2 && dialect === "mysql") {
      return { reason: `${shown} is not a table Zavi may read. Use the table name without a database prefix.` };
    }
    return notReadable;
  };

  const pushFrame = (kind: Frame["kind"], extra: Partial<Frame> = {}) =>
    stack.push({ kind, fromList: false, expect: null, decided: kind !== "fromparen", ctes: new Set(), ...extra });

  const parseWith = (i: number): number => {
    let j = i + 1;
    let recursive = false;
    if (t[j]?.value === "RECURSIVE") {
      recursive = true;
      j++;
    }
    const scope = cur();
    return startCte(j, scope, recursive) ?? i + 1;
  };

  let recursiveScopes = new WeakSet<Frame>();
  let aliasColumnList = false;
  const startCte = (j: number, scope: Frame, recursive: boolean): number | null => {
    const nameTok = t[j];
    if (!nameTok || nameTok.kind !== "ident") return null;
    let k = j + 1;
    if (t[k]?.value === "(") {
      aliasColumnList = true;
      let depth = 0;
      for (; k < t.length; k++) {
        if (t[k]!.value === "(") depth++;
        else if (t[k]!.value === ")" && --depth === 0) break;
        else if (t[k]!.kind === "ident") idents.push(t[k]!);
      }
      k++;
    }
    if (t[k]?.value !== "AS") return null;
    k++;
    while (t[k] && t[k]!.kind === "ident" && /^(not|materialized)$/i.test(t[k]!.value)) k++;
    if (t[k]?.value !== "(") return null;
    names.add(nameTok.value.toLowerCase());
    if (recursive) {
      scope.ctes.add(nameTok.quoted ? nameTok.value : nameTok.value.toLowerCase());
      recursiveScopes.add(scope);
    }
    pushFrame("ctebody", recursive ? {} : { pendingCte: { name: nameTok.quoted ? nameTok.value : nameTok.value.toLowerCase(), scope } });
    return k + 1;
  };

  const closeFrame = (i: number): number | Refusal => {
    const f = stack.pop()!;
    if (stack.length === 0) return refuse("Unbalanced parentheses.");
    if (f.kind === "fromparen") cur().expect = "alias";
    if (f.kind === "ctebody") {
      const scope = f.pendingCte?.scope ?? cur();
      if (f.pendingCte) scope.ctes.add(f.pendingCte.name);
      if (t[i + 1]?.value === ",") {
        const next = startCte(i + 2, scope, recursiveScopes.has(scope));
        if (next !== null) return next;
      }
    }
    return i + 1;
  };

  let prevSignificant: Token | undefined;
  let onlyStart: number | null = null;
  let i = 0;
  while (i < t.length) {
    const tok = t[i]!;
    const f = cur();
    const prev = prevSignificant;
    prevSignificant = tok;

    if (f.kind === "fromparen" && !f.decided) {
      f.decided = true;
      if (!(tok.kind === "keyword" && (tok.value === "SELECT" || tok.value === "WITH")) && !/^(values|table)$/i.test(tok.value)) {
        f.fromList = true;
        f.expect = "relation";
      }
    }

    if (f.expect === "relation") {
      if (tok.kind === "keyword" && tok.value === "ONLY") {
        onlyStart = tok.start;
        i++;
        continue;
      }
      if (tok.kind === "keyword" && tok.value === "LATERAL") {
        i++;
        continue;
      }
      if (tok.value === "(") {
        f.expect = null;
        pushFrame("fromparen");
        i++;
        continue;
      }
      if (tok.kind === "ident") {
        const { parts, next } = readName(i);
        if (t[next]?.value === "(") return refuse(`${displayName(parts)}() in FROM is not allowed. Read from a table instead.`);
        const r = resolveRelation(parts);
        if ("reason" in r) return refuse(r.reason, (r as { rule?: "settings" }).rule);
        const last = parts[parts.length - 1]!;
        names.add(last.value.toLowerCase());
        f.aliasFor = null;
        if ("table" in r) {
          const rel: Relation = { table: r.table, start: onlyStart ?? parts[0]!.start, end: last.end, qualified: parts.length > 1, hasAlias: false };
          relations.push(rel);
          f.aliasFor = rel;
          names.add(r.table.toLowerCase());
        } else if (onlyStart !== null) {
          return refuse("ONLY applies to tables, not to a named subquery.");
        }
        onlyStart = null;
        f.expect = "alias";
        i = next;
        continue;
      }
      return refuse(`Zavi could not read the FROM clause near "${tok.value}". Use plain table names, joins and subqueries.`);
    }
    if (f.expect === "alias" || f.expect === "alias-after-as") {
      if (tok.kind === "keyword" && tok.value === "AS" && f.expect === "alias") {
        f.expect = "alias-after-as";
        i++;
        continue;
      }
      f.expect = null;
      if (tok.kind === "ident") {
        if (f.aliasFor) f.aliasFor.hasAlias = true;
        f.aliasFor = null;
        names.add(tok.value.toLowerCase());
        if (t[i + 1]?.value === "(") {
          aliasColumnList = true;
          pushFrame("aliascols");
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      f.aliasFor = null;
    }

    if (tok.kind === "keyword") {
      const v = tok.value;
      if (v === "WITH") {
        i = parseWith(i);
        continue;
      }
      if ((v === "FROM" && f.kind !== "func") || v === "TABLE") {
        f.fromList = v === "FROM";
        f.expect = "relation";
        i++;
        continue;
      }
      if (JOIN_WORDS.has(v)) {
        f.expect = "relation";
        f.fromList = true;
        i++;
        continue;
      }
      if (CLAUSE_END.has(v)) f.fromList = false;
      if ((v === "LEFT" || v === "RIGHT") && tok.next === "(") {
        pushFrame("func", { fname: v.toLowerCase() });
        i += 2;
        continue;
      }
      if (tok.next === "(") {
        pushFrame("expr");
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (tok.kind === "punct") {
      if (tok.value === "(") {
        pushFrame("expr");
        i++;
        continue;
      }
      if (tok.value === ")") {
        const r = closeFrame(i);
        if (typeof r !== "number") return r;
        i = r;
        continue;
      }
      if (tok.value === "," && f.fromList && f.expect === null) {
        f.expect = "relation";
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (tok.kind === "ident") {
      const { parts, next } = readName(i);
      for (const p of parts) idents.push(p);
      const isType = prev?.value === "::" || prev?.value === "AS";
      const castTarget = prev?.value === "::" || (prev?.value === "AS" && f.kind === "func" && f.fname === "cast");
      if (castTarget) {
        if (parts.length > 1) return refuse(`Casting to ${displayName(parts)} is not allowed. Cast to a built-in type.`);
        const base = parts[0]!.value.toLowerCase();
        if (!(dialect === "postgres" ? PG_TYPES : MYSQL_TYPES).has(base)) {
          return refuse(`Casting to ${parts[0]!.value} is not allowed. Cast to a built-in type such as text, numeric, date or timestamp.`);
        }
      }
      if (t[next]?.value === "(") {
        if (isType || (parts.length === 1 && TYPE_WORDS.has(parts[0]!.value.toLowerCase()) && prev?.kind === "ident")) {
          pushFrame("typeargs");
          i = next + 1;
          continue;
        }
        if (parts.length > 1) return refuse(`${displayName(parts)}() is not allowed. Use built-in functions only.`);
        if (!isAllowedFunction(parts[0]!.value, dialect)) {
          return refuse(`${parts[0]!.value}() is not allowed. Use built-in aggregate, date and text functions only.`);
        }
        pushFrame("func", { fname: parts[0]!.value.toLowerCase() });
        i = next + 1;
        continue;
      }
      const starRef = t[next]?.value === "." && t[next + 1]?.value === "*";
      if ((parts.length > 1 || starRef) && !isType) qualifiedRefs.push({ parts });
      i = starRef ? next + 2 : next;
      continue;
    }
    i++;
  }
  if (stack.length !== 1) return refuse("Unbalanced parentheses.");

  for (const q of qualifiedRefs) {
    const head = q.parts[0]!;
    if (!names.has(head.value.toLowerCase())) {
      return refuse(`${displayName(q.parts)} refers to "${head.value}", which is not a table or alias in this query.`);
    }
  }

  const tables = [...new Set(relations.map((r) => r.table))];
  const hiddenAll = new Map<string, string>();
  for (const tb of tables) for (const h of policy.hiddenFields(tb)) hiddenAll.set(h.toLowerCase(), `${tb}.${h}`);
  const named = [...idents, ...t.filter((x) => x.kind === "keyword")];
  for (const id of named) {
    const hit = hiddenAll.get(id.value.toLowerCase());
    if (hit) return refuse(`${hit} is hidden in What Zavi can see. Rewrite the query without it.`, "settings");
  }

  const ops = dialect === "postgres" ? PG_OPS : MYSQL_OPS;
  for (let k = 0; k < t.length; k++) {
    if (t[k]!.kind !== "punct" || !OP_CHARS.has(t[k]!.value)) continue;
    let run = t[k]!.value;
    let j = k;
    while (t[j + 1] && t[j + 1]!.kind === "punct" && OP_CHARS.has(t[j + 1]!.value) && t[j + 1]!.start === t[j]!.end) {
      run += t[j + 1]!.value;
      j++;
    }
    k = j;
    const pieces: string[] = [];
    if (dialect === "postgres" && run.length > 1 && /[+-]$/.test(run) && !/[~!@#%^&|`?]/.test(run)) {
      let head = run;
      while (head.length > 1 && /[+-]$/.test(head)) {
        pieces.unshift(head.slice(-1));
        head = head.slice(0, -1);
      }
      pieces.unshift(head);
    } else if (dialect === "mysql") {
      let rest = run;
      while (rest.length > 0) {
        let n = Math.min(3, rest.length);
        while (n > 0 && !ops.has(rest.slice(0, n))) n--;
        if (n === 0) return refuse(`The operator ${run} is not allowed. Use standard comparison and arithmetic operators.`);
        pieces.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
    } else pieces.push(run);
    for (const op of pieces) {
      if (!ops.has(op)) return refuse(`The operator ${op} is not allowed. Use standard comparison and arithmetic operators.`);
    }
  }

  {
    const risky = sensitiveSampledSegments(policy, tables);
    if (risky.size > 0) {
      const hit = literalPathHit(sql, t, risky);
      if (hit) return refuse(hit.computed ? `Zavi reads keys of ${hit.column} only by literal name ('key', '{a,b}' or ARRAY['a','b']).` : `${hit.column} carries a sensitive key (${hit.key}) that Zavi doesn't read out. Read other keys, or hide the column.`);
    }
  }

  {
    const structured = visibleColumnsOfClass(policy, tables, "json");
    if (structured.size > 0) {
      let depth = 0;
      for (let k = 0; k < t.length; k++) {
        const x = t[k]!;
        if (x.kind === "punct" && x.value === "(") depth++;
        else if (x.kind === "punct" && x.value === ")") depth--;
        if (depth === 0 || (x.kind !== "ident" && x.kind !== "keyword") || !structured.has(x.value.toLowerCase())) continue;
        const n1 = t[k + 1];
        const n2 = t[k + 2];
        let alias: Token | undefined;
        if (n1?.kind === "keyword" && n1.value === "AS" && (n2?.kind === "ident" || n2?.kind === "keyword")) alias = n2;
        else if (n1?.kind === "ident" || (n1?.kind === "keyword" && !NOT_A_LABEL.has(n1.value))) alias = n1;
        if (alias && alias.value.toLowerCase() !== x.value.toLowerCase()) {
          return refuse(`Zavi doesn't follow the column ${x.value} renamed to ${alias.value} inside a subquery or CTE. Keep its name there, or rename it in the outer select list.`);
        }
      }
    }
  }

  {
    const strictNames = visibleColumnsOfClass(policy, tables, "json");
    if (strictNames.size > 0) {
      const participates = t.some((x) => ((x.kind === "ident" || x.kind === "keyword") && strictNames.has(x.value.toLowerCase())) || (x.kind === "punct" && x.value === "*" && isStarRef(t, x)));
      const setOp = t.some((x) => x.kind === "keyword" && (x.value === "UNION" || x.value === "INTERSECT" || x.value === "EXCEPT"));
      if (participates && aliasColumnList) {
        return refuse("Zavi can't follow a JSON column through a column-alias list. Name the columns in the select list instead (payload AS p).");
      }
      if (participates && setOp) {
        return refuse("Zavi can't follow a JSON column through UNION, INTERSECT or EXCEPT. Run the parts as separate queries.");
      }
    }
  }

  const sub = subscriptRefusal(t, dialect, jsonColumnsOf(policy, tables));
  if (sub) return sub;
  const dup = duplicateOutputRefusal(t, policy, tables);
  if (dup) return dup;

  const sources = new Map<string, string>();
  for (const tb of tables) {
    const src = sourceFor(tb, policy, dialect, opts.mysqlDatabase ?? null);
    if (typeof src !== "string") return src;
    sources.set(tb, src);
  }
  let out = sql;
  for (const r of [...relations].sort((a, b) => b.start - a.start)) {
    const cols = policy.visibleColumns(r.table).map((c) => quoteIdent(c, dialect));
    const select = cols.length > 0 ? cols.join(", ") : `1 AS ${quoteIdent("__no_visible_columns", dialect)}`;
    const derived = `(SELECT ${select} FROM ${sources.get(r.table)})${r.hasAlias ? "" : ` AS ${quoteIdent(r.table, dialect)}`}`;
    out = out.slice(0, r.start) + derived + out.slice(r.end);
  }
  const hidden = tables.flatMap((tb) => policy.hiddenFields(tb));
  return { ok: true, sql: out, tables, hidden, passthrough: passthroughColumns(t, policy, tables), structured: structuredOutputs(t, policy, tables) };
}

const NOT_A_LABEL = new Set([
  "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "AND", "OR", "IS", "IN", "NOT",
  "LIKE", "ILIKE", "BETWEEN", "THEN", "ELSE", "END", "WHEN", "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER",
  "CROSS", "NATURAL", "ASC", "DESC", "NULLS", "WINDOW", "FETCH", "FOR", "SIMILAR", "ESCAPE", "COLLATE", "OVER", "WITHIN",
  "FILTER", "BY", "ROWS", "RANGE", "PRECEDING", "FOLLOWING", "ANY", "SOME", "ALL", "STRAIGHT_JOIN",
]);

function visibleColumnsOfClass(policy: Policy, tables: string[], cls: "json"): Set<string> {
  const out = new Set<string>();
  for (const tb of tables) {
    const visible = new Set(policy.visibleColumns(tb).map((c) => c.toLowerCase()));
    for (const c of policy.resolve(tb, true)?.columns ?? []) {
      if (structuredClass(c.type) === cls && visible.has(c.name.toLowerCase())) out.add(c.name.toLowerCase());
    }
  }
  return out;
}

function sensitiveSampledSegments(policy: Policy, tables: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const tb of tables) {
    const visible = new Set(policy.visibleColumns(tb).map((c) => c.toLowerCase()));
    const hidden = new Set(policy.hiddenFields(tb).map((h) => (h.split(".").pop() ?? h).toLowerCase()));
    for (const c of policy.resolve(tb, true)?.columns ?? []) {
      const cls = structuredClass(c.type);
      if (cls !== "json" || !visible.has(c.name.toLowerCase())) continue;
      if (!out.has(c.name.toLowerCase())) out.set(c.name.toLowerCase(), new Set<string>());
      for (const k of c.json_keys ?? []) {
        for (const seg of k.split(".")) {
          if (seg.length === 0) continue;
          if (isSensitiveField(tb, seg) || hidden.has(seg.toLowerCase())) {
            const set = out.get(c.name.toLowerCase()) ?? new Set<string>();
            set.add(seg.toLowerCase());
            out.set(c.name.toLowerCase(), set);
          }
        }
      }
    }
  }
  return out;
}

function literalsIn(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i]!;
    if (c === "'") {
      const parts: string[] = [];
      let j = i + 1;
      let run = j;
      for (;;) {
        if (j >= n) {
          parts.push(raw.slice(run));
          break;
        }
        if (raw[j] === "'") {
          if (raw[j + 1] === "'") {
            parts.push(raw.slice(run, j + 1));
            j += 2;
            run = j;
            continue;
          }
          parts.push(raw.slice(run, j));
          j++;
          break;
        }
        j++;
      }
      out.push(parts.join(""));
      i = j;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(raw[j]!)) j++;
      if (raw[j] === "$" && !/[0-9]/.test(raw[i + 1] ?? "")) {
        const tag = raw.slice(i, j + 1);
        const end = raw.indexOf(tag, j + 1);
        out.push(end === -1 ? raw.slice(j + 1) : raw.slice(j + 1, end));
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    i++;
  }
  return out;
}

function pathSegments(lit: string): string[] {
  const s = lit.trim();
  if (s.startsWith("{") && s.endsWith("}")) return s.slice(1, -1).split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
  if (s.startsWith("$")) return s.slice(1).split(/[.[\]]+/).map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
  return [s];
}

const PATH_OPS = new Set(["->", "->>", "#>", "#>>"]);
const PATH_FUNCS = new Set(["jsonb_extract_path_text", "json_extract_path_text", "json_extract", "jsonb_extract_path", "json_extract_path"]);

function literalPathHit(sql: string, t: Token[], risky: Map<string, Set<string>>): { column: string; key: string; computed?: boolean } | null {
  const isRisky = (x: Token | undefined) => !!x && (x.kind === "ident" || x.kind === "keyword") && risky.has(x.value.toLowerCase());
  const opAt = (i: number): { start: number; end: number; op: string } | null => {
    if (t[i]?.kind !== "punct" || !OP_CHARS.has(t[i]!.value)) return null;
    let s0 = i;
    while (s0 > 0 && t[s0 - 1]!.kind === "punct" && OP_CHARS.has(t[s0 - 1]!.value) && t[s0 - 1]!.end === t[s0]!.start) s0--;
    return { start: s0, end: i, op: t.slice(s0, i + 1).map((x) => x.value).join("") };
  };
  const match = (i: number, dir: 1 | -1): number => {
    const open = t[i]!.value;
    const close = open === "(" ? ")" : open === ")" ? "(" : open === "[" ? "]" : "[";
    let depth = 0;
    for (let j = i; j >= 0 && j < t.length; j += dir) {
      if (t[j]!.kind !== "punct") continue;
      if (t[j]!.value === open) depth++;
      else if (t[j]!.value === close && --depth === 0) return j;
    }
    return -1;
  };
  const baseColumn = (i: number): string | null => {
    while (i >= 2 && t[i]?.kind === "ident" && t[i - 1]?.value === "::") i -= 2;
    while (i >= 3 && t[i]?.value === "]" && t[i - 1]?.value === "[" && t[i - 2]?.kind === "ident" && t[i - 3]?.value === "::") i -= 4;
    const tok = t[i];
    if (!tok) return null;
    if (tok.kind === "punct" && tok.value === ")") {
      const o = match(i, -1);
      if (o === -1) return null;
      for (let j = o; j <= i; j++) if (isRisky(t[j])) return t[j]!.value;
      return null;
    }
    return isRisky(tok) ? tok.value : null;
  };
  const check = (column: string, lits: string[]): { column: string; key: string } | null => {
    const keys = risky.get(column.toLowerCase())!;
    for (const lit of lits) for (const seg of pathSegments(lit)) if (keys.has(seg.toLowerCase())) return { column, key: seg };
    return null;
  };
  const nonLiteral = (column: string) => ({ column, key: "", computed: true });
  const rightLiterals = (end: number): string[] | null => {
    const next = t[end + 1];
    const between = literalsIn(sql.slice(t[end]!.end, next?.start ?? sql.length));
    if (between.length > 0) return between;
    if (!next) return null;
    if (next.kind === "number") return [];
    let open = end + 1;
    if (next.kind === "ident" && next.value.toLowerCase() === "array" && t[end + 2]?.value === "[") open = end + 2;
    else if (!(next.kind === "punct" && next.value === "(")) return null;
    const close = match(open, 1);
    if (close === -1) return null;
    for (let j = open + 1; j < close; j++) {
      const x = t[j]!;
      const ok = (x.kind === "punct" && (x.value === "," || x.value === "(" || x.value === ")" || x.value === "[" || x.value === "]")) || (x.kind === "ident" && x.value.toLowerCase() === "array") || x.kind === "number";
      if (!ok) return null;
    }
    const lits = literalsIn(sql.slice(t[open]!.end, t[close]!.start));
    return lits.length > 0 || t.slice(open + 1, close).some((x) => x.kind === "number") ? lits : null;
  };
  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind === "ident" && PATH_FUNCS.has(tok.value.toLowerCase()) && t[k + 1]?.value === "(") {
      const close = match(k + 1, 1);
      const last = close === -1 ? t.length : close;
      let column: string | null = null;
      for (let i = k + 2; i < last; i++) if (isRisky(t[i])) column = t[i]!.value;
      if (!column) continue;
      let depth = 0;
      let firstArgEnd = -1;
      for (let i = k + 2; i < last; i++) {
        const v = t[i]!.value;
        if (v === "(" || v === "[") depth++;
        else if (v === ")" || v === "]") depth--;
        else if (v === "," && depth === 0) {
          firstArgEnd = i;
          break;
        }
      }
      if (firstArgEnd === -1) continue;
      for (let i = firstArgEnd; i < last; i++) if (t[i]!.value !== ",") return nonLiteral(column);
      const hit = check(column, literalsIn(sql.slice(t[firstArgEnd]!.start, close === -1 ? sql.length : t[close]!.start)));
      if (hit) return hit;
      continue;
    }
    if (tok.kind !== "punct" || !OP_CHARS.has(tok.value)) continue;
    if (t[k + 1]?.kind === "punct" && OP_CHARS.has(t[k + 1]!.value) && t[k + 1]!.start === tok.end) continue;
    const run = opAt(k);
    if (!run || !PATH_OPS.has(run.op)) continue;
    const links: { end: number; op: string }[] = [{ end: k, op: run.op }];
    let i = run.start - 1;
    for (;;) {
      const prev = opAt(i);
      if (prev && PATH_OPS.has(prev.op)) {
        links.push({ end: prev.end, op: prev.op });
        i = prev.start - 1;
        continue;
      }
      break;
    }
    const column = baseColumn(i);
    if (!column) continue;
    const lits: string[] = [];
    for (const l of links) {
      const r = rightLiterals(l.end);
      if (r === null) return nonLiteral(column);
      lits.push(...r);
    }
    const hit = check(column, lits);
    if (hit) return hit;
  }
  return null;
}

function isStarRef(t: Token[], star: Token): boolean {
  const i = t.indexOf(star);
  const prev = t[i - 1];
  if (!prev) return false;
  if (prev.kind === "keyword" && (prev.value === "SELECT" || prev.value === "DISTINCT" || prev.value === "ALL")) return true;
  if (prev.kind === "punct" && (prev.value === "," || prev.value === ".")) return true;
  return false;
}

function jsonColumnsOf(policy: Policy, tables: string[]): Set<string> {
  const out = new Set<string>();
  for (const tb of tables) for (const c of policy.resolve(tb, true)?.columns ?? []) if (structuredClass(c.type) === "json") out.add(c.name.toLowerCase());
  return out;
}

function subscriptRefusal(t: Token[], dialect: SqlDialect, jsonColumns: Set<string>): Refusal | null {
  if (dialect !== "postgres") return null;
  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind !== "punct" || tok.value !== "[") continue;
    const close = t.findIndex((x, i) => i > k && x.kind === "punct" && x.value === "]");
    if (close === -1) return refuse("Unbalanced brackets.");
    const prev = t[k - 1];
    if (prev?.kind === "ident" && !prev.quoted && prev.value.toLowerCase() === "array" && prev.end === tok.start) continue;
    const inner = t.slice(k + 1, close);
    const typeAt = (i: number) => t[i]?.kind === "ident" && PG_TYPES.has(t[i]!.value.toLowerCase()) && (t[i - 1]?.value === "::" || t[i - 1]?.value === "AS");
    if (inner.length === 0 && (typeAt(k - 1) || (t[k - 1]?.kind === "punct" && t[k - 1]?.value === "]"))) continue;
    const numberOnly = inner.length === 1 && inner[0]!.kind === "number" && t[close]!.start === inner[0]!.end && inner[0]!.start === tok.end;
    const onArrayColumn = prev?.kind === "ident" && !jsonColumns.has(prev.value.toLowerCase());
    if (numberOnly && onArrayColumn) continue;
    return refuse("A [ ] subscript is allowed only as a number index on an array column. Read JSON with -> or ->>.");
  }
  return null;
}

type SelectItem = { col: Token | null; name: string | null; aliased?: boolean; star?: boolean };

function selectItems(t: Token[]): SelectItem[] | null {
  if (t[0]?.kind !== "keyword" || t[0].value !== "SELECT") return null;
  let depth = 0;
  for (const x of t) {
    if (x.kind === "punct" && x.value === "(") depth++;
    else if (x.kind === "punct" && x.value === ")") depth--;
    else if (depth === 0 && x.kind === "keyword" && (x.value === "UNION" || x.value === "INTERSECT" || x.value === "EXCEPT" || x.value === "WITH")) return null;
  }
  const raw: Token[][] = [];
  let cur: Token[] = [];
  depth = 0;
  for (let i = 1; i < t.length; i++) {
    const x = t[i]!;
    if (x.kind === "punct" && x.value === "(") depth++;
    else if (x.kind === "punct" && x.value === ")") depth--;
    if (depth === 0 && x.kind === "keyword" && x.value === "FROM") break;
    if (depth === 0 && x.kind === "punct" && x.value === ",") {
      raw.push(cur);
      cur = [];
      continue;
    }
    cur.push(x);
  }
  raw.push(cur);
  return raw.map((item0) => {
    let item = item0;
    if (item[0]?.kind === "keyword" && (item[0].value === "DISTINCT" || item[0].value === "ALL")) item = item.slice(1);
    if (item.length === 1 && item[0]!.kind === "ident") return { col: item[0]!, name: item[0]!.value };
    if (item.length === 3 && item[0]!.kind === "ident" && item[1]!.value === "." && item[2]!.kind === "ident") return { col: item[2]!, name: item[2]!.value };
    if ((item.length === 1 && item[0]!.value === "*") || (item.length === 3 && item[0]!.kind === "ident" && item[1]!.value === "." && item[2]!.value === "*")) {
      return { col: null, name: null, star: true };
    }
    if (item.length === 3 && item[0]!.kind === "ident" && item[1]!.kind === "keyword" && item[1]!.value === "AS" && item[2]!.kind === "ident") {
      return { col: item[0]!, name: item[2]!.value, aliased: true };
    }
    if (item.length === 5 && item[0]!.kind === "ident" && item[1]!.value === "." && item[2]!.kind === "ident" && item[3]!.kind === "keyword" && item[3]!.value === "AS" && item[4]!.kind === "ident") {
      return { col: item[2]!, name: item[4]!.value, aliased: true };
    }
    const last = item[item.length - 1];
    const before = item[item.length - 2];
    if (last?.kind === "ident" && before?.kind === "keyword" && before.value === "AS" && item.length >= 3) return { col: null, name: last.value };
    return { col: null, name: null };
  });
}

function passthroughColumns(t: Token[], policy: Policy, tables: string[]): string[] {
  if (t.filter((x) => x.kind === "keyword" && x.value === "SELECT").length !== 1) return [];
  const items = selectItems(t);
  if (!items || items.some((i) => i.name === null)) return [];
  return items.filter((i) => i.col && !i.aliased && columnUnhiddenEverywhere(policy, tables, i.col.value)).map((i) => i.name!);
}

function strictKind(type: string | undefined): "json" | "hstore" | null {
  const c = structuredClass(type);
  return c === "json" || c === "hstore" ? c : null;
}

function structuredOutputs(t: Token[], policy: Policy, tables: string[]): StructuredOutput[] {
  const kinds = new Map<string, Set<"json" | "hstore">>();
  const own = new Map<string, string>();
  for (const tb of tables) {
    for (const c of policy.resolve(tb, true)?.columns ?? []) {
      const k = strictKind(c.type);
      if (!k) continue;
      const key = c.name.toLowerCase();
      kinds.set(key, (kinds.get(key) ?? new Set()).add(k));
      own.set(key, c.name);
    }
  }
  if (kinds.size === 0) return [];
  const out: StructuredOutput[] = [];
  const seen = new Set<string>();
  const add = (name: string, col: string) => {
    for (const k of kinds.get(col.toLowerCase()) ?? []) {
      const key = `${name.toLowerCase()}\u0000${k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind: k });
    }
  };
  for (const i of selectItems(t) ?? []) {
    if (i.star) for (const [key, name] of own) add(name, key);
    else if (i.col && i.name) add(i.name, i.col.value);
  }
  for (let k = 0; k < t.length; k++) {
    const c = t[k]!;
    if ((c.kind !== "ident" && c.kind !== "keyword") || !kinds.has(c.value.toLowerCase())) continue;
    const n1 = t[k + 1];
    const n2 = t[k + 2];
    const label = (x: Token) => (x.kind === "keyword" ? x.value.toLowerCase() : x.value);
    if (n1?.kind === "keyword" && n1.value === "AS" && (n2?.kind === "ident" || n2?.kind === "keyword")) add(label(n2), c.value);
    else if (n1?.kind === "ident" || (n1?.kind === "keyword" && n1.value !== "AS")) add(label(n1), c.value);
  }
  return out;
}

function duplicateOutputRefusal(t: Token[], policy: Policy, tables: string[]): Refusal | null {
  const unhiddenJson = tables.some((tb) =>
    (policy.resolve(tb, true)?.columns ?? []).some((c) => structuredClass(c.type) !== null && policy.unhiddenFields(tb).includes(c.name)),
  );
  if (!unhiddenJson) return null;
  const items = selectItems(t);
  if (!items) return null;
  const seen = new Set<string>();
  for (const i of items) {
    if (i.name === null) continue;
    const k = i.name.toLowerCase();
    if (seen.has(k)) return refuse(`Two result columns are both named ${i.name}. Give each column its own name.`);
    seen.add(k);
  }
  return null;
}

export function sourceFor(table: string, policy: Policy, dialect: SqlDialect, mysqlDatabase: string | null): string | Refusal {
  if (dialect === "mysql") {
    return mysqlDatabase ? `${quoteIdent(mysqlDatabase, dialect)}.${quoteIdent(table, dialect)}` : quoteIdent(table, dialect);
  }
  const entry = policy.resolve(table, true);
  const qualified = `${quoteIdent("public", dialect)}.${quoteIdent(table, dialect)}`;
  if (!entry?.partitioned) return `ONLY ${qualified}`;
  const parentHidden = new Set(policy.hiddenFields(table).map((h) => h.toLowerCase()));
  for (const part of entry.partitions ?? []) {
    const pe = policy.resolve(part, true);
    if (!pe) return refuse(`${table} is partitioned and one of its partitions is not readable, so Zavi can't read ${table} as a whole.`, "settings");
    const stricter = policy.hiddenFields(pe.name).some((h) => !parentHidden.has(h.toLowerCase()));
    if (stricter) return refuse(`${table} is partitioned and one of its partitions hides more fields, so Zavi can't read ${table} as a whole.`, "settings");
  }
  return qualified;
}

export function stripHiddenColumns<R extends Record<string, unknown>>(rows: R[], hiddenNames: string[]): R[] {
  if (hiddenNames.length === 0) return rows;
  const h = new Set(hiddenNames.map((n) => n.toLowerCase()));
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (!h.has(k.toLowerCase())) o[k] = v;
    return o as R;
  });
}
