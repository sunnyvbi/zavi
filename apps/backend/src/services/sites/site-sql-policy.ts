
import { STARTER_SQL_PATH } from "./contract";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";

export type SqlPolicyResult = { ok: true } | { ok: false; reason: string };

export type Statement = { text: string; canon: string; bodies: string[]; literals: string[] };

const MAX_SQL_BYTES = 512 * 1024;
const MAX_STATEMENTS = 500;

function decodeEscapes(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    if (/^x/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[uU][0-9a-fA-F]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return e;
  });
}

export function splitSqlStatements(sql: string): Statement[] | { error: string } {
  const out: Statement[] = [];
  let text = "";
  let canon = "";
  let bodies: string[] = [];
  let literals: string[] = [];
  let i = 0;
  const n = sql.length;
  const add = (t: string, c: string = t) => {
    text += t;
    canon += c;
  };
  const push = () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) out.push({ text: t, canon: canon.replace(/\s+/g, " ").trim(), bodies, literals });
    text = "";
    canon = "";
    bodies = [];
    literals = [];
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      add(" ");
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { error: "an unterminated /* comment" };
      add(" ");
      continue;
    }
    if ((c === "'" || c === '"') && /u&$/i.test(text) && !/[A-Za-z0-9_$]u&$/i.test(text)) {
      return { error: "a U& escaped string or identifier (write it plainly)" };
    }
    if (c === "'") {
      const escaped = /[eE]$/.test(text) && !/[A-Za-z0-9_][eE]$/.test(text);
      i++;
      let closed = false;
      let content = "";
      while (i < n) {
        if (escaped && sql[i] === "\\") {
          content += sql.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            content += "'";
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        content += sql[i];
        i++;
      }
      if (!closed) return { error: "an unterminated string literal" };
      literals.push(escaped ? decodeEscapes(content) : content);
      add("'_'");
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let content = "";
      let closed = false;
      while (j < n) {
        const e = sql.indexOf('"', j);
        if (e < 0) break;
        content += sql.slice(j, e);
        if (sql[e + 1] === '"') {
          content += '"';
          j = e + 2;
          continue;
        }
        closed = true;
        j = e + 1;
        break;
      }
      if (!closed) return { error: "an unterminated quoted identifier" };
      add(`"${content.replace(/"/g, '""')}"`, content.toLowerCase());
      i = j;
      continue;
    }
    if (c === "$" && !/[A-Za-z0-9_]$/.test(text)) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) return { error: "an unterminated $$ body" };
        bodies.push(sql.slice(i + tag.length, end));
        add(` $body${bodies.length - 1}$ `);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    add(c, c.toLowerCase());
    i++;
  }
  push();
  return out;
}

export function scrubBody(sql: string): { canon: string; literals: string[] } | null {
  const parts = splitSqlStatements(sql);
  if ("error" in parts) return null;
  return {
    canon: parts.map((p) => p.canon.replace(/\$body\d+\$/g, "'_'")).join(" ; "),
    literals: parts.flatMap((p) => [...p.literals, ...p.bodies]),
  };
}

const ID = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const QNAME = String.raw`(?:${ID}\s*\.\s*)?${ID}`;
const GRANTEES_OK = new Set(["anon", "authenticated"]);
const PRIVS_OK = new Set([
  "select", "insert", "update", "delete", "references", "trigger", "usage", "execute", "all", "privileges",
]);
const EXTENSIONS_OK = new Set(["pgcrypto", "uuid-ossp", "citext", "pg_trgm"]);
const PLATFORM_SCHEMAS = String.raw`(?:auth|storage|extensions|vault|pg_catalog|pg_toast|pg_temp\w*|information_schema|realtime|graphql|graphql_public|net|cron|pgsodium|pgbouncer|supabase_\w+|zavi)`;
const PLATFORM_REF_RE = new RegExp(String.raw`\b(${PLATFORM_SCHEMAS})\s*\.\s*([a-z0-9_]+)(\s*\()?`, "g");
const LITERAL_PLATFORM_RE = new RegExp(
  String.raw`(?<![\w@/.:-])"?(?:auth|storage|extensions|vault|pg_catalog|pg_toast|information_schema|realtime|graphql|graphql_public|net|cron|pgsodium|pgbouncer|supabase_\w+)"?\s*\.\s*"?[a-z_]`,
);
const AUTH_FUNCTIONS_OK = new Set(["uid", "jwt", "role", "email"]);
const EXTENSION_FUNCTIONS_OK = new Set(["uuid_generate_v4", "gen_random_uuid", "gen_random_bytes", "crypt", "gen_salt", "digest", "hmac"]);

function platformReference(canon: string): string | null {
  PLATFORM_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLATFORM_REF_RE.exec(canon))) {
    const [whole, schema, name, call] = m;
    const before = canon.slice(Math.max(0, m.index - 12), m.index);
    if (schema === "auth" && call && AUTH_FUNCTIONS_OK.has(name)) continue;
    if (schema === "extensions" && call && EXTENSION_FUNCTIONS_OK.has(name)) continue;
    if (schema === "auth" && name === "users" && /\breferences\s*$/.test(before)) continue;
    return whole.replace(/\s+/g, "").replace(/\($/, "");
  }
  return null;
}

const ADMIN_FUNCTIONS_RE =
  /\b(dblink\w*|lo_\w+|set_config|current_setting|pg_read_\w+|pg_stat_file|pg_ls_\w+|pg_file_\w+|pg_logdir_ls|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_sleep\w*|pg_advisory\w*|pg_switch_wal|pg_promote)\s*\(/;

const CANON_DENY: Array<[RegExp, string]> = [
  [ADMIN_FUNCTIONS_RE, "a server-admin function"],
  [
    /\b(query_to_xml\w*|query_to_xmlschema|table_to_xml\w*|table_to_xmlschema|cursor_to_xml\w*|cursor_to_xmlschema|schema_to_xml\w*|database_to_xml\w*|ts_stat|ts_rewrite|xpath_table|crosstab\w*|connectby)\s*\(/,
    "a function that executes SQL from a string",
  ],
  [/\b(to_reg\w+|reg(class|proc|procedure|oper|operator|type|namespace|role|config|dictionary|collation))\b/, "an object-id cast (regclass and friends)"],
  [/\bpg_[a-z0-9_]+/, "a system catalog or pg_ function"],
];

function canonDenied(canon: string, opts: { allowPgNames?: boolean } = {}): string | null {
  for (const [re, what] of CANON_DENY) {
    if (opts.allowPgNames && what.startsWith("a system catalog")) continue;
    const m = re.exec(canon);
    if (m) return `${what} (${m[0].replace(/\s*\($/, "")})`;
  }
  return null;
}

function literalDenied(literals: string[]): string | null {
  for (const lit of literals) {
    const m = LITERAL_PLATFORM_RE.exec(lit.toLowerCase());
    if (m) return `a string that names a Supabase system object (${m[0].trim()}...)`;
  }
  return null;
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").replace(/""/g, '"');

function bareName(qname: string): string {
  const parts = qname.trim().match(new RegExp(ID, "g")) ?? [qname];
  return unquote(parts[parts.length - 1]).toLowerCase();
}

function inPublic(qname: string): boolean {
  const m = new RegExp(String.raw`^(?:(${ID})\s*\.\s*)?${ID}$`).exec(qname.trim());
  if (!m) return false;
  return m[1] === undefined || unquote(m[1]).toLowerCase() === "public";
}

function topLevelCommaSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type StarterReserved = { tables: Set<string>; functions: Set<string>; triggers: Set<string> };

export function deriveStarterReserved(sql: string): StarterReserved {
  const split = splitSqlStatements(sql);
  if ("error" in split) throw new Error(`starter SQL is unreadable: ${split.error}`);
  const r: StarterReserved = { tables: new Set(), functions: new Set(), triggers: new Set() };
  for (const st of split) {
    const t = st.text.toLowerCase();
    let m = new RegExp(String.raw`^create (?:or replace )?table (?:if not exists )?(${QNAME})`).exec(t);
    if (m && inPublic(m[1])) r.tables.add(bareName(m[1]));
    m = new RegExp(String.raw`^create (?:or replace )?function (${QNAME})\s*\(`).exec(t);
    if (m && inPublic(m[1])) r.functions.add(bareName(m[1]));
    m = new RegExp(String.raw`^create (?:or replace )?(?:constraint )?trigger (${ID}) `).exec(t);
    if (m) r.triggers.add(bareName(m[1]));
  }
  if (r.tables.size === 0 || r.functions.size === 0) throw new Error("starter SQL defines no tables or functions");
  return r;
}

export function starterSql(): string {
  const sql = TEMPLATE_FILES[STARTER_SQL_PATH];
  if (!sql) throw new Error("the site starter has no starter.sql");
  return sql;
}

let reservedCache: StarterReserved | null = null;
export function starterReserved(): StarterReserved {
  reservedCache ??= deriveStarterReserved(starterSql());
  return reservedCache;
}

const RESERVED_WHY = "the starter's sign-in and admin objects belong to the platform and cannot be changed";

function reservedWrite(canon: string, r: StarterReserved): string | null {
  const names = [...r.tables].map((t) => t.replace(/[^a-z0-9_]/g, "")).join("|");
  const re = new RegExp(
    String.raw`\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?(?:public\s*\.\s*)?(${names})\b`,
  );
  const m = re.exec(canon);
  return m ? `a write to the starter's public.${m[2]} (${RESERVED_WHY})` : null;
}

function reservedRead(canon: string, r: StarterReserved): string | null {
  const names = [...r.tables].map((t) => t.replace(/[^a-z0-9_]/g, "")).join("|");
  const re = new RegExp(String.raw`(?<!\breferences\s*)(?<![\w.$])(?:public\s*\.\s*)?(${names})\b(?!\s*\.\s*[a-z_])`);
  const m = re.exec(canon);
  return m ? `a read of the starter's public.${m[1]} (it holds every user's e-mail and role; a migration would read past its row level security)` : null;
}

const BODY_FORBIDDEN: Array<[RegExp, string]> = [
  [/\b(create|drop|truncate|alter|reindex|cluster|vacuum|refresh\s+materialized)\b/, "changes or creates database objects"],
  [/\block\s+(table\b|[a-z_])/, "takes table locks"],
  [/\bload\s+'/, "loads a library"],
  [/\bimport\s+foreign\b/, "imports a foreign schema"],
  [/\b(grant|revoke)\b/, "changes grants"],
  [/\bexecute\b/, "runs dynamic SQL (EXECUTE)"],
  [/(^|;|\bbegin|\bthen|\belse|\bloop|\bdeclare)\s*(set|reset)\s+(local\s+|session\s+)?(role|session|session_authorization|search_path)\b/, "switches role or search_path"],
  [/\bcopy\b/, "uses COPY"],
  [new RegExp(String.raw`\b(insert\s+into|update|delete\s+from)\s+${PLATFORM_SCHEMAS}\s*\.`), "writes to a Supabase system schema"],
];

function checkFunction(t: string, bodies: string[], r: StarterReserved): string | null {
  const m = new RegExp(String.raw`^create (?:or replace )?function (${QNAME})\s*\(`).exec(t);
  if (!m) return "a function definition it could not read";
  if (!inPublic(m[1])) return "a function outside the public schema";
  if (r.functions.has(bareName(m[1]))) return `a function named public.${bareName(m[1])} (${RESERVED_WHY})`;
  const lang = /\blanguage\s+("?[a-z0-9_]+"?)/.exec(t)?.[1]?.replace(/"/g, "");
  if (lang !== "sql" && lang !== "plpgsql") return `a function in language ${lang ?? "(none)"} (only sql and plpgsql)`;
  if (/\bsecurity definer\b/.test(t)) return "a SECURITY DEFINER function (site functions run with the caller's rights)";
  const header = t.replace(/\$body\d+\$/g, " ");
  for (const s of header.matchAll(/\bset\s+([a-z_.]+)\s*(?:=|to)\s*([^ ]+(?:\s*,\s*[^ ]+)*)/g)) {
    const fine = s[1] === "search_path" && /^('_'|public|"public")$/.test(s[2].trim());
    if (!fine) return `a function that sets ${s[1]} (only SET search_path = '' or public)`;
  }
  if (bodies.length === 0) return "a function without a $$ body (write the body between $$ ... $$)";
  for (const body of bodies) {
    const scrubbed = scrubBody(body);
    if (!scrubbed) return "a function body it could not read";
    const clean = scrubbed.canon;
    const denied = canonDenied(clean);
    if (denied) return `a function that calls ${denied}`;
    const write = reservedWrite(clean, r);
    if (write) return `a function with ${write}`;
    const read = reservedRead(clean, r);
    if (read) return `a function with ${read}`;
    for (const [re, what] of BODY_FORBIDDEN) {
      if (re.test(clean)) return `a function that ${what}`;
    }
    const ref = platformReference(clean);
    if (ref) return `a function that uses ${ref} (the auth / storage / system schemas are off limits)`;
    const lit = literalDenied(scrubbed.literals);
    if (lit) return `a function with ${lit}`;
    for (const dml of clean.matchAll(/(?<!\b(?:for|do)\s+)\b(update|delete\s+from)\s+/g)) {
      const end = clean.indexOf(";", dml.index);
      const segment = clean.slice(dml.index, end < 0 ? undefined : end);
      const bad = checkWhere(segment, dml[1] === "update" ? "an UPDATE" : "a DELETE", { rowRefs: true });
      if (bad) return `a function with ${bad}`;
    }
  }
  return null;
}

const INSERT_CALLS_OK = new Set([
  "now", "gen_random_uuid", "uuid_generate_v4", "coalesce", "nullif", "greatest", "least", "lower", "upper", "trim", "btrim",
  "ltrim", "rtrim", "concat", "concat_ws", "length", "char_length", "substring", "substr", "replace", "left", "right", "md5",
  "round", "floor", "ceil", "ceiling", "abs", "date_trunc", "make_date", "make_interval", "to_char", "to_date", "to_timestamp",
  "jsonb_build_object", "jsonb_build_array", "json_build_object", "json_build_array", "to_jsonb", "array", "row", "cast",
  "extensions.gen_random_uuid", "extensions.uuid_generate_v4",
  "values", "conflict", "in", "exists", "any", "all", "not", "and", "or", "select", "from", "where", "on", "using", "as", "returning",
  "numeric", "decimal", "varchar", "char", "character", "timestamp", "timestamptz", "time", "interval", "float", "bit", "text",
]);

function insertCalls(t: string): string | null {
  const body = t.toLowerCase().replace(/^insert into\s+[^\s(]+\s*(\([^)]*\))?/, "");
  for (const m of body.matchAll(/([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)?)\s*\(/g)) {
    const name = m[1].replace(/\s+/g, "");
    if (!INSERT_CALLS_OK.has(name)) return `an INSERT that calls ${name}() (only plain builtins: a function could change rows that already exist)`;
  }
  return null;
}

export const EXISTING_ROWS_HINT = "of rows that already exist (a migration runs on the live database before the publish check: it may add rows, never change or remove existing ones)";
function existingRows(kind: string): string {
  return `${kind} ${EXISTING_ROWS_HINT}`;
}

function topLevelKeyword(t: string, kw: string): number {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      const e = t.indexOf('"', i + 1);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.startsWith(kw, i) && !/[a-z0-9_$]/.test(t[i - 1] ?? " ") && !/[a-z0-9_$]/.test(t[i + kw.length] ?? " ")) {
      return i;
    }
  }
  return -1;
}

const PRED_KEYWORDS = new Set([
  "and", "or", "not", "in", "is", "null", "true", "false", "now", "current_date", "current_timestamp", "interval",
  "like", "ilike", "similar", "between", "exists", "select", "any", "all", "some", "case", "when", "then", "else",
  "end", "distinct", "from", "returning", "where", "using",
]);
const COMPARE = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);

function tokenizePredicate(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    const m = /^('_'|"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*|\d+(?:\.\d+)?|::|<>|!=|<=|>=|[=<>(),.+-])/.exec(s.slice(i));
    if (!m) return null;
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

export function plainColumnPredicate(pred: string, opts: { rowRefs?: boolean } = {}): boolean {
  const tk = tokenizePredicate(pred);
  if (!tk || tk.length === 0) return false;
  let p = 0;
  const peek = () => tk[p];
  const isIdent = (x: string | undefined) => !!x && /^([a-z_][a-z0-9_$]*|"(?:[^"]|"")+")$/.test(x) && !PRED_KEYWORDS.has(x);
  const fail = (): never => {
    throw new Error("grammar");
  };
  const expect = (x: string) => {
    if (tk[p] !== x) fail();
    p++;
  };
  const colref = (): string => {
    if (!isIdent(peek())) fail();
    const parts = [unquote(tk[p++])];
    while (peek() === "." && isIdent(tk[p + 1])) {
      p++;
      parts.push(unquote(tk[p++]));
    }
    return parts.join(".");
  };
  const term = () => {
    const x = peek();
    if (x === "-" && /^\d/.test(tk[p + 1] ?? "")) p += 2;
    else if (x === "'_'" || /^\d/.test(x ?? "") || x === "true" || x === "false" || x === "current_date" || x === "current_timestamp") p++;
    else if (x === "now") {
      p++;
      expect("(");
      expect(")");
    } else if (x === "interval") {
      p++;
      expect("'_'");
    } else fail();
    if (peek() === "::") {
      p++;
      if (!isIdent(peek())) fail();
      p++;
    }
  };
  const value = () => {
    term();
    while (peek() === "+" || peek() === "-") {
      p++;
      term();
    }
  };
  let constAtoms = 0;
  const atom = () => {
    const lhs = colref();
    if (/^(new|old)\./.test(lhs)) fail();
    const op = peek();
    if (op && COMPARE.has(op)) {
      p++;
      if (isIdent(peek())) {
        const rhs = colref();
        if (rhs === lhs) fail();
        if (opts.rowRefs && /^(new|old)\./.test(rhs)) {
          constAtoms++;
          return;
        }
        if (op !== "=") fail();
        if (rhs === lhs) fail();
        return;
      }
      value();
      constAtoms++;
      return;
    }
    if (op === "in") {
      p++;
      expect("(");
      value();
      while (peek() === ",") {
        p++;
        value();
      }
      expect(")");
      constAtoms++;
      return;
    }
    if (op === "is") {
      p++;
      expect("null");
      constAtoms++;
      return;
    }
    fail();
  };
  try {
    atom();
    while (peek() === "and") {
      p++;
      atom();
    }
    return p === tk.length && constAtoms > 0;
  } catch {
    return false;
  }
}

function checkWhere(t: string, what: string, opts: { rowRefs?: boolean } = {}): string | null {
  const at = topLevelKeyword(t, "where");
  if (at < 0) return `${what} without a WHERE clause`;
  let pred = t.slice(at + "where".length);
  const ret = topLevelKeyword(pred, "returning");
  if (ret >= 0) pred = pred.slice(0, ret);
  return plainColumnPredicate(pred, opts)
    ? null
    : `${what} whose WHERE is not a plain column condition (write column = value, joined with AND; no OR, NOT, functions or subqueries)`;
}

const ALTER_TABLE_RE = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${QNAME}) (.+)$`);

function checkAlterTable(t: string, r: StarterReserved): string | null {
  const m = ALTER_TABLE_RE.exec(t);
  if (!m) return "an ALTER TABLE it could not read";
  if (!inPublic(m[1])) return "an ALTER TABLE outside the public schema";
  if (r.tables.has(bareName(m[1]))) return `an ALTER TABLE of public.${bareName(m[1])} (${RESERVED_WHY})`;
  for (const action of topLevelCommaSplit(m[2])) {
    const a = action.trim();
    if (/^add (column )?(if not exists )?(?!constraint\b)/.test(a) && !/^add (primary key|unique|check|foreign key|constraint)\b/.test(a)) continue;
    if (/^add (constraint\b|primary key\b|unique\b|check\b|foreign key\b)/.test(a)) continue;
    if (/^(enable|force) row level security$/.test(a)) continue;
    if (new RegExp(String.raw`^alter (column )?${ID} (set default .+|drop default|set not null)$`).test(a)) continue;
    if (/\b(disable|no force) row level security\b/.test(a)) return "turning row level security off";
    if (/^drop\b/.test(a)) return "an ALTER TABLE that drops a column or constraint (destructive)";
    if (/^rename\b/.test(a)) return "an ALTER TABLE that renames (breaking)";
    return `an ALTER TABLE action it does not allow ("${a.slice(0, 60)}")`;
  }
  return null;
}

function checkGrant(t: string, r: StarterReserved): string | null {
  const m = /^grant (.+?) on (.+?) to (.+?)( with grant option)?$/.exec(t);
  if (!m) return "a GRANT of a role (only object privileges to anon / authenticated)";
  const privs = m[1].replace(/\([^)]*\)/g, "").split(/[\s,]+/).filter(Boolean);
  if (privs.some((p) => !PRIVS_OK.has(p))) return `a GRANT of ${m[1]}`;
  if (m[4]) return "a GRANT ... WITH GRANT OPTION";
  const grantees = m[3].split(",").map((g) => unquote(g).toLowerCase());
  if (grantees.some((g) => !GRANTEES_OK.has(g))) return `a GRANT to ${m[3]} (only anon and authenticated)`;
  const wide = /^all (tables|sequences|functions|routines|procedures) in schema /.exec(m[2].trim());
  if (wide) {
    const fine =
      wide[1] === "sequences" ||
      (wide[1] === "tables" && privs.every((p) => p === "select") && grantees.every((g) => g === "authenticated"));
    if (!fine) return `a schema-wide GRANT of ${m[1]} on all ${wide[1]} (it would reach the starter's objects; grant on each object instead)`;
  }
  return checkPrivilegeTarget(m[2], r);
}

function checkPrivilegeTarget(target: string, r: StarterReserved): string | null {
  const t = target.trim();
  const schemaWide = /^all (tables|sequences|functions|routines|procedures) in schema (.+)$/.exec(t);
  if (schemaWide) return schemaWide[2].split(",").every((s) => unquote(s).toLowerCase() === "public") ? null : "a privilege on a schema other than public";
  const schema = /^schema (.+)$/.exec(t);
  if (schema) return schema[1].split(",").every((s) => unquote(s).toLowerCase() === "public") ? null : "a privilege on a schema other than public";
  const objects = t.replace(/^(table|sequence|function|routine|procedure) /, "");
  for (const o of topLevelCommaSplit(objects)) {
    const name = o.replace(/\s*\(.*\)\s*$/, "").trim();
    if (!new RegExp(String.raw`^${QNAME}$`).test(name) || !inPublic(name)) return "a privilege on an object outside the public schema";
    const bare = bareName(name);
    if (r.tables.has(bare) || r.functions.has(bare)) return `a privilege change on public.${bare} (${RESERVED_WHY})`;
  }
  return null;
}

type FileCtx = { created: Map<string, string>; rls: Set<string>; inserts?: boolean; mutators?: string[] };

function checkStatement(st: Statement, r: StarterReserved, ctx: FileCtx): string | null {
  const t = st.text.toLowerCase();
  const on = (re: RegExp) => re.test(t);
  const target = (re: RegExp, what: string): string | null => {
    const m = re.exec(t);
    if (!m) return `${what} it could not read`;
    if (!inPublic(m[1])) return `${what} outside the public schema`;
    if (r.tables.has(bareName(m[1]))) return `${what} on public.${bareName(m[1])} (${RESERVED_WHY})`;
    return null;
  };

  if (on(/^create (or replace )?((global|local) )?(temp|temporary) /)) return "a temporary table (create a real table in public)";
  if (on(/^create (or replace )?(unlogged )?table /)) {
    if (new RegExp(String.raw`^create (?:or replace )?(?:unlogged )?table (?:if not exists )?${QNAME}\s+as\b`).test(t)) {
      return "a CREATE TABLE AS (create the table, then insert rows)";
    }
    const re = new RegExp(String.raw`^create (?:or replace )?(?:unlogged )?table (?:if not exists )?(${QNAME})`);
    const why = target(re, "a table");
    if (why) return why;
    const name = bareName(re.exec(t)![1]);
    if (!ctx.created.has(name)) ctx.created.set(name, `public.${name}`);
    return null;
  }
  if (on(/^create (unique )?index /)) {
    if (on(/^create (unique )?index concurrently\b/)) return "CREATE INDEX CONCURRENTLY (it cannot run inside the migration's transaction)";
    return target(new RegExp(String.raw`^create (?:unique )?index (?:if not exists )?(?:${ID} )?on (?:only )?(${QNAME})`), "an index");
  }
  if (on(/^create (or replace )?materialized view /)) return "a materialized view (it bypasses row level security)";
  if (on(/^create (or replace )?(recursive )?view /)) {
    const why = target(new RegExp(String.raw`^create (?:or replace )?(?:recursive )?view (?:if not exists )?(${QNAME})`), "a view");
    if (why) return why;
    return /\bwith \(\s*security_invoker\s*(=\s*(true|on|1|'_')\s*)?\)/.test(t)
      ? null
      : "a view without WITH (security_invoker = true) (it would bypass row level security)";
  }
  if (on(/^create (or replace )?function /)) return checkFunction(t, st.bodies, r);
  if (on(/^create sequence /)) return target(new RegExp(String.raw`^create sequence (?:if not exists )?(${QNAME})`), "a sequence");
  if (on(/^create type /)) return target(new RegExp(String.raw`^create type (${QNAME}) as\b`), "a type");
  if (on(/^(create|alter) policy /)) return target(new RegExp(String.raw`^(?:create|alter) policy ${ID} on (${QNAME})`), "a policy");
  if (on(/^drop policy /)) return target(new RegExp(String.raw`^drop policy (?:if exists )?${ID} on (${QNAME})$`), "a DROP POLICY");
  if (on(/^create (or replace )?(constraint )?trigger /)) {
    if (/^create (or replace )?constraint trigger /.test(t) && /\binitially deferred\b/.test(t)) {
      return "a DEFERRABLE INITIALLY DEFERRED constraint trigger (it would run at commit, after the publish checks)";
    }
    const m = new RegExp(String.raw`^create (?:or replace )?(?:constraint )?trigger (${ID}) .*? on (${QNAME}) .*?execute (?:function|procedure) (${QNAME})\s*\(`).exec(t);
    if (!m) return "a trigger it could not read";
    if (!inPublic(m[2]) || !inPublic(m[3])) return "a trigger outside the public schema";
    if (r.triggers.has(bareName(m[1])) || r.tables.has(bareName(m[2])) || r.functions.has(bareName(m[3]))) {
      return `a trigger on or calling the starter's objects (${RESERVED_WHY})`;
    }
    return null;
  }
  if (on(/^drop trigger /)) {
    const m = new RegExp(String.raw`^drop trigger (?:if exists )?(${ID}) on (${QNAME})$`).exec(t);
    if (!m) return "a DROP TRIGGER it could not read";
    if (!inPublic(m[2])) return "a DROP TRIGGER outside the public schema";
    if (r.triggers.has(bareName(m[1])) || r.tables.has(bareName(m[2]))) return `a DROP TRIGGER of the starter's objects (${RESERVED_WHY})`;
    return null;
  }
  if (on(/^alter table /)) {
    const why = checkAlterTable(t, r);
    if (why) return why;
    const m = ALTER_TABLE_RE.exec(t)!;
    if (topLevelCommaSplit(m[2]).some((a) => a.trim() === "enable row level security")) ctx.rls.add(bareName(m[1]));
    return null;
  }
  if (on(/^grant /)) return checkGrant(t, r);
  if (on(/^revoke /)) {
    const m = /^revoke (?:grant option for )?(.+?) on (.+?) from (.+?)( cascade| restrict)?$/.exec(t);
    if (!m) return "a REVOKE of a role";
    return checkPrivilegeTarget(m[2], r);
  }
  if (on(/^insert into /)) {
    ctx.inserts = true;
    return (
      target(new RegExp(String.raw`^insert into (${QNAME})`), "an INSERT") ??
      (/\bon conflict\b[\s\S]*\bdo update\b/.test(t) ? existingRows("an INSERT ... ON CONFLICT DO UPDATE") : null) ??
      insertCalls(t)
    );
  }
  if (on(/^update /)) {
    return target(new RegExp(String.raw`^update (?:only )?(${QNAME})`), "an UPDATE") ?? existingRows("an UPDATE");
  }
  if (on(/^delete from /)) {
    return target(new RegExp(String.raw`^delete from (?:only )?(${QNAME})`), "a DELETE") ?? existingRows("a DELETE");
  }
  if (on(/^comment on /)) return null;
  if (on(/^create extension /)) {
    const m = new RegExp(String.raw`^create extension (?:if not exists )?(${ID})(?: (?:with )?schema (${ID}))?$`).exec(t);
    if (!m) return "a CREATE EXTENSION it could not read";
    if (!EXTENSIONS_OK.has(unquote(m[1]))) return `the extension ${unquote(m[1])}`;
    return null;
  }
  if (on(/^drop /)) return "a DROP (destructive; only DROP POLICY / DROP TRIGGER IF EXISTS on public tables)";
  if (on(/^truncate\b/)) return "a TRUNCATE (destructive)";
  if (on(/^do\b/)) return "a DO block (write plain statements with IF NOT EXISTS instead)";
  if (on(/^(begin|commit|rollback|start transaction|end|savepoint|release)\b/)) return "an explicit transaction statement (the migration already runs in one)";
  if (on(/^(create|alter|drop) (role|user|group)\b/)) return "a role change";
  if (on(/^(set|reset)\b/)) return "a SET (session settings and roles are not allowed)";
  if (on(/^alter default privileges\b/)) return "ALTER DEFAULT PRIVILEGES";
  if (on(/^copy\b/)) return "COPY";
  if (on(/^create schema\b/)) return "a new schema (use public)";
  if (on(/^alter (function|procedure|routine)\b/)) return "an ALTER FUNCTION (create or replace it instead)";
  if (on(/^(select|with|values|table)\b/)) return "a query (a migration only defines schema and seed rows)";
  return `a statement it does not allow ("${t.slice(0, 60)}")`;
}

export function checkSiteMigrationSql(sql: string): SqlPolicyResult {
  const src = String(sql ?? "");
  if (Buffer.byteLength(src, "utf8") > MAX_SQL_BYTES) return { ok: false, reason: "the migration is too large" };
  const split = splitSqlStatements(src);
  if ("error" in split) return { ok: false, reason: `the SQL has ${split.error}` };
  if (split.length > MAX_STATEMENTS) return { ok: false, reason: "the migration has too many statements" };
  const r = starterReserved();
  const ctx: FileCtx = { created: new Map(), rls: new Set(), mutators: [] };
  for (const st of split) {
    const snippet = st.text.slice(0, 120);
    const isFunction = /^create (or replace )?function /i.test(st.text);
    if (isFunction) {
      const code = st.bodies.join(" ").toLowerCase();
      if (/\bmerge\s+into\b/.test(code)) return { ok: false, reason: `it contains a function with a MERGE: ${st.text.slice(0, 120)}` };
      if (/(?<!\b(?:for|do)\s+)\b(update|delete\s+from)\s+/.test(code)) ctx.mutators!.push(st.text.slice(0, 80));
    }
    const canon = st.canon.replace(/\$body\d+\$/g, "'_'");
    const denied = canonDenied(canon, { allowPgNames: /^create extension /.test(canon) });
    if (denied) return { ok: false, reason: `it calls ${denied}: ${snippet}` };
    const write = reservedWrite(canon, r);
    if (write) return { ok: false, reason: `it contains ${write}: ${snippet}` };
    const why = checkStatement(st, r, ctx);
    const readsNoRows = /^create (unlogged |temp(orary)? )?(table|(unique )?index|type|sequence) /.test(canon) && !/ as select | as \(/.test(canon);
    if (!why && !isFunction && !readsNoRows) {
      const read = reservedRead(canon, r);
      if (read) return { ok: false, reason: `it contains ${read}: ${snippet}` };
    }
    if (why) return { ok: false, reason: `it contains ${why}: ${snippet}` };
    const ref = platformReference(canon);
    if (ref) {
      return {
        ok: false,
        reason: `it uses ${ref} (the auth / storage / system schemas are off limits; use auth.uid() and a foreign key to auth.users): ${snippet}`,
      };
    }
    const lit = literalDenied(isFunction ? st.literals : [...st.literals, ...st.bodies]);
    if (lit) return { ok: false, reason: `it contains ${lit}: ${snippet}` };
  }
  if (ctx.inserts && ctx.mutators!.length) {
    return {
      ok: false,
      reason: `it contains an INSERT in the same migration as a function that changes rows (${ctx.mutators![0]}): ${EXISTING_ROWS_HINT}; put the function in its own migration`,
    };
  }
  for (const [name, display] of ctx.created) {
    if (!ctx.rls.has(name)) {
      return {
        ok: false,
        reason: `it creates ${display} without row level security (add "alter table ${display} enable row level security;" to the same file, with its policies)`,
      };
    }
  }
  return { ok: true };
}
