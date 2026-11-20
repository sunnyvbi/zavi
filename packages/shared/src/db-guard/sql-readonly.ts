import { lexSql, type SqlDialect } from "./sql-lexer";

export const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "MERGE",
  "REPLACE",
  "UPSERT",
  "COPY",
  "CALL",
  "DO",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "REFRESH",
  "COMMENT",
  "LOCK",
  "SET",
  "RESET",
  "DISCARD",
  "PREPARE",
  "DEALLOCATE",
  "LISTEN",
  "NOTIFY",
  "INTO",
] as const;

export const FORBIDDEN_PROC_KEYWORDS = ["EXECUTE", "EXEC"] as const;

const LEADING_ONLY_KEYWORDS = new Set<string>([
  "COMMENT",
  "SET",
  "RESET",
  "DISCARD",
  "LOCK",
  "LISTEN",
  "NOTIFY",
  "REFRESH",
  "COPY",
  "MERGE",
  "REPLACE",
  "ANALYZE",
  "VACUUM",
  "REINDEX",
  "DO",
]);

export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-" && (i + 2 >= n || /[\x00-\x20\x7f]/.test(sql[i + 2]!))) {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*" && sql[i + 2] !== "!" && sql[i + 2] !== "+") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          i = n;
        } else {
          i = end + tag.length;
        }
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export type ReadOnlyCode =
  | "codeact_sql_empty"
  | "codeact_sql_multi_statement"
  | "codeact_sql_not_read"
  | "codeact_sql_write_rejected";

export type ReadOnlyCheck = { ok: true } | { ok: false; code: ReadOnlyCode; reason: string };

export function checkReadOnly(rawSql: string, dialect?: SqlDialect): ReadOnlyCheck {
  if (typeof rawSql !== "string" || rawSql.trim().length === 0) {
    return { ok: false, code: "codeact_sql_empty", reason: "Each entry in sql_reads must be a non-empty SELECT/CTE read query." };
  }
  if (!dialect) {
    const pg = checkReadOnly(rawSql, "postgres");
    return pg.ok ? checkReadOnly(rawSql, "mysql") : pg;
  }
  const { tokens, unsafe } = lexSql(rawSql, dialect);
  if (unsafe) {
    return { ok: false, code: "codeact_sql_not_read", reason: `sql_reads entries must be plain read queries. ${unsafe}` };
  }
  if (tokens.length === 0) {
    return { ok: false, code: "codeact_sql_empty", reason: "Each entry in sql_reads must be a non-empty SELECT/CTE read query." };
  }

  const semis = tokens.map((t, i) => (t.kind === "punct" && t.value === ";" ? i : -1)).filter((i) => i >= 0);
  if (semis.length > 1 || (semis.length === 1 && semis[0] !== tokens.length - 1)) {
    return {
      ok: false,
      code: "codeact_sql_multi_statement",
      reason: "Only ONE statement per sql_reads entry. Split multiple queries into separate array entries.",
    };
  }

  const first = tokens.find((t) => !(t.kind === "punct" && t.value === "("));
  const firstWord = first && (first.kind === "keyword" || first.kind === "ident") && !first.quoted ? first.value.toUpperCase() : "";
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return {
      ok: false,
      code: "codeact_sql_not_read",
      reason: `sql_reads entries must be SELECT or WITH (CTE) reads. Got a statement starting with "${firstWord || first?.value || "?"}".`,
    };
  }

  const forbidden = new Set<string>([...FORBIDDEN_KEYWORDS, ...FORBIDDEN_PROC_KEYWORDS]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ((t.kind !== "keyword" && t.kind !== "ident") || t.quoted) continue;
    const kw = t.value.toUpperCase();
    if (!forbidden.has(kw)) continue;
    if (LEADING_ONLY_KEYWORDS.has(kw) && i !== 0) continue;
    return {
      ok: false,
      code: "codeact_sql_write_rejected",
      reason: `sql_reads must be read-only. Found a forbidden keyword "${kw}". CodeAct never runs writes/DDL.`,
    };
  }
  return { ok: true };
}

export function mysqlPlaceholderProblem(sql: string, paramCount: number): string | null {
  const { tokens, unsafe } = lexSql(sql, "mysql");
  if (unsafe) return unsafe;
  const ps = tokens.filter((t) => t.kind === "param");
  for (let i = 0; i + 1 < ps.length; i++) {
    if (ps[i + 1]!.start === ps[i]!.end) return 'The placeholder "??" is not allowed. Use one ? per value.';
  }
  if (ps.length !== paramCount) return `The statement has ${ps.length} ? placeholder${ps.length === 1 ? "" : "s"} but ${paramCount} value${paramCount === 1 ? " was" : "s were"} sent.`;
  return null;
}

const MAX_BIGINT = BigInt("9223372036854775807");

function limitLiteral(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "bigint") return v >= BigInt(0) && v <= MAX_BIGINT ? v.toString() : null;
  if (typeof v === "string" && /^\d{1,19}$/.test(v.trim())) {
    const b = BigInt(v.trim());
    return b <= MAX_BIGINT ? b.toString() : null;
  }
  return null;
}

export function inlineMysqlLimitParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const { tokens, unsafe } = lexSql(sql, "mysql");
  if (unsafe) return { sql, params };
  const ps = tokens.filter((t) => t.kind === "param");
  if (ps.length !== params.length) return { sql, params };
  const isKw = (t: (typeof tokens)[number] | undefined, w: string) => t?.kind === "keyword" && t.value === w;
  const edits: { start: number; end: number; text: string; param: number }[] = [];
  let p = 0;
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind !== "param") continue;
    const at = p++;
    const prev = tokens[j - 1];
    const afterLimitOrOffset = isKw(prev, "LIMIT") || isKw(prev, "OFFSET");
    const secondOfPair =
      prev?.kind === "punct" && prev.value === "," && (tokens[j - 2]?.kind === "param" || tokens[j - 2]?.kind === "number") && isKw(tokens[j - 3], "LIMIT");
    if (!afterLimitOrOffset && !secondOfPair) continue;
    const lit = limitLiteral(params[at]);
    if (lit !== null) edits.push({ start: t.start, end: t.end, text: lit, param: at });
  }
  if (edits.length === 0) return { sql, params };
  let out = sql;
  for (const e of [...edits].reverse()) out = `${out.slice(0, e.start)}${e.text}${out.slice(e.end)}`;
  const drop = new Set(edits.map((e) => e.param));
  return { sql: out, params: params.filter((_, i) => !drop.has(i)) };
}

export function clampStatementTimeoutMs(ms: unknown, min = 100, max = 120_000): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms) : 5_000;
  return Math.max(min, Math.min(max, n));
}
