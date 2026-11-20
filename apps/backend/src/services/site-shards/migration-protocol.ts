
export const FROZEN_FILE = "frozen.json";
export const FROZEN_VERSIONS: readonly string[] = [
  "0001_core", "0002_api", "0003_storage", "0004_membership_slots_perf", "0005_contracts_archive_reindex",
  "0006_contract_v2", "0007_relational_slots_rls", "0008_relational_api", "0009_recipient_cap_quota",
  "0010_release_on_delete", "1001_access_token_hook", "1002_broker", "1003_member_admin", "1004_signup_sessions",
  "1030_form_notifications",
];
export const MAX_LOCK_TIMEOUT_MS = 10_000;
export const MAX_STATEMENT_TIMEOUT_MS = 30 * 60_000;

export type Directives = { noTransaction: boolean; contractAfter: string | null };

export function parseDirectives(sql: string): Directives {
  const noTransaction = /^--\s*zavi:no-transaction\s*$/m.test(sql);
  const m = /^--\s*zavi:contract-after\s+([0-9]{4}_[a-z0-9_]{1,60})\s*$/m.exec(sql);
  return { noTransaction, contractAfter: m ? m[1] : null };
}

export function splitSteps(sql: string): string[] {
  return sql
    .split(/^--\s*zavi:step\s*$/m)
    .filter((chunk) => stripComments(chunk).trim().length > 0)
    .map((chunk) => chunk.trim());
}

export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = closeQuote(sql, i, c);
      out += sql.slice(i, end);
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function closeQuote(sql: string, start: number, q: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = closeQuote(sql, i, c);
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function durationMs(v: string): number | null {
  const m = /^'?\s*([0-9]+)\s*(ms|s|min|h)?\s*'?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "min" ? 60_000 : 3_600_000);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const ident = (s: string) => s.replace(/"/g, "").toLowerCase();

const CONCURRENT_RE = /^(create\s+(unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|reindex\s+(index|table)\s+concurrently)\b/i;

function createdTables(stmts: string[]): Set<string> {
  const t = new Set<string>();
  for (const s of stmts) {
    const m = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/i.exec(s);
    if (m) t.add(ident(m[1]));
  }
  return t;
}

export function sqlFragments(text: string, depth = 0): string[] {
  const inner: string[] = [];
  let masked = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = closeQuote(text, i, "'");
      const content = text.slice(i + 1, Math.max(i + 1, end - 1)).replace(/''/g, "'");
      if (/\bexecute\s*(?:format\s*\(\s*)?$/i.test(masked) || /^\s*(alter\s+table|create\s+(unique\s+)?index|drop\s+(table|index))\b/i.test(content)) inner.push(content);
      masked += "'s'";
      i = end;
      continue;
    }
    if (c === '"') {
      const end = closeQuote(text, i, '"');
      masked += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end < 0 ? text.length : end;
        inner.push(text.slice(i + tag.length, stop));
        masked += "$$";
        i = end < 0 ? text.length : end + tag.length;
        continue;
      }
    }
    masked += c;
    i++;
  }
  const out = [masked];
  if (depth < 4) for (const t of inner) if (/\b(alter|create)\b/i.test(t)) out.push(...sqlFragments(t, depth + 1));
  return out;
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const IDENT = `[a-z0-9_."]+`;

function indexTargets(fragment: string): Array<{ table: string; concurrently: boolean }> {
  const out: Array<{ table: string; concurrently: boolean }> = [];
  const re = new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(?:${IDENT}\\s+)?on\\s+(?:only\\s+)?(${IDENT})(?=[\\s(]|$)`, "gi");
  for (const m of fragment.matchAll(re)) out.push({ table: ident(m[2]), concurrently: !!m[1] });
  const all = fragment.match(/\bcreate\s+(?:unique\s+)?index\b/gi)?.length ?? 0;
  for (let i = out.length; i < all; i++) out.push({ table: "(unparsed)", concurrently: false });
  return out;
}

function alterTables(fragment: string): Array<{ table: string; actions: string[] }> {
  const out: Array<{ table: string; actions: string[] }> = [];
  const re = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${IDENT})(?=\\s)([^;]*)`, "gi");
  for (const m of fragment.matchAll(re)) out.push({ table: ident(m[1]), actions: splitTopLevel(norm(m[2]), ",") });
  const all = fragment.match(/\balter\s+table\b/gi)?.length ?? 0;
  for (let i = out.length; i < all; i++) out.push({ table: "(unparsed)", actions: [] });
  return out;
}

const CONSTANT_RE = /^\(?\s*(?:'s'|-?[0-9]+(?:\.[0-9]+)?|true|false|null)\s*\)?(?:\s*::\s*[a-z_][a-z0-9_]*(?:\s*\[\])?)?$/i;

function actionHazards(table: string, action: string): string[] {
  const v: string[] = [];
  if (/^alter\s+(column\s+)?\S+\s+set\s+not\s+null\b/.test(action)) {
    v.push(`${table}: SET NOT NULL scans the table under an exclusive lock; add a CHECK (... is not null) NOT VALID, VALIDATE it in a later file`);
  }
  const con = /^add\s+(?:constraint\s+\S+\s+)?(check|foreign\s+key|unique|primary\s+key|exclude)\b/.exec(action);
  if (con) {
    if (con[1] === "check" || con[1].startsWith("foreign")) {
      if (!/\bnot\s+valid\b/.test(action)) v.push(`${table}: a CHECK / FOREIGN KEY on an existing table must be added NOT VALID (VALIDATE CONSTRAINT separately)`);
    } else if (!/\busing\s+index\b/.test(action)) {
      v.push(`${table}: a UNIQUE / PRIMARY KEY / EXCLUDE constraint builds its index under a lock; build it CONCURRENTLY, then ADD CONSTRAINT ... USING INDEX`);
    }
    return v;
  }
  const col = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]*)$/.exec(action);
  if (col && /^add\b/.test(action)) {
    const def = col[1];
    if (/\bgenerated\b/.test(def)) v.push(`${table}: a GENERATED column rewrites the table`);
    if (/\b(unique|primary\s+key)\b/.test(def)) v.push(`${table}: an inline UNIQUE / PRIMARY KEY column builds an index under a lock; add the column, build the index CONCURRENTLY, then ADD CONSTRAINT ... USING INDEX`);
    if (/\breferences\b/.test(def)) v.push(`${table}: an inline REFERENCES column validates under a lock; add the column, then ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID`);
    if (/\bcheck\s*\(/.test(def)) v.push(`${table}: an inline CHECK on a new column scans the table; add it as a separate constraint NOT VALID`);
    const d = /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|check|constraint|references|unique|primary|collate|generated)\b|$)/.exec(def);
    if (d && !CONSTANT_RE.test(d[1].trim())) {
      v.push(`${table}: a new column's default must be a plain constant (got ${d[1].trim().slice(0, 40)}); anything else may rewrite the table. Add it without one, backfill in batches`);
    }
  }
  return v;
}

function checkSets(stmts: string[], local: boolean, where: string): string[] {
  const v: string[] = [];
  const kw = local ? "set\\s+local" : "set(?:\\s+local)?";
  const lock = new RegExp(`^${kw}\\s+lock_timeout\\s*(?:=|to)\\s*(.+)$`, "i");
  const stmt = new RegExp(`^${kw}\\s+statement_timeout\\s*(?:=|to)\\s*(.+)$`, "i");
  const head = stmts.slice(0, 2);
  const l = head.map((s) => lock.exec(s)).find(Boolean);
  const st = head.map((s) => stmt.exec(s)).find(Boolean);
  if (!l) v.push(`${where}: must open with \`${local ? "set local " : "set "}lock_timeout = '<=${MAX_LOCK_TIMEOUT_MS / 1000}s'\``);
  else {
    const ms = durationMs(l[1]);
    if (ms === null || ms <= 0 || ms > MAX_LOCK_TIMEOUT_MS) v.push(`${where}: lock_timeout must be 1ms..${MAX_LOCK_TIMEOUT_MS / 1000}s (got ${l[1].trim()})`);
  }
  if (!st) v.push(`${where}: must open with \`${local ? "set local " : "set "}statement_timeout = '<=${MAX_STATEMENT_TIMEOUT_MS / 60_000}min'\``);
  else {
    const ms = durationMs(st[1]);
    if (ms === null || ms <= 0 || ms > MAX_STATEMENT_TIMEOUT_MS) v.push(`${where}: statement_timeout must be 1ms..${MAX_STATEMENT_TIMEOUT_MS / 60_000}min, never 0 (got ${st[1].trim()})`);
  }
  return v;
}

export function lintShardMigration(file: { version: string; sql: string }, versions: string[], prior: string[] = []): string[] {
  const v: string[] = [];
  const dir = parseDirectives(file.sql);
  const body = stripComments(file.sql);
  const stmts = splitStatements(body);
  const before = new Set<string>();
  for (const p of prior) for (const t of createdTables(splitStatements(stripComments(p)))) before.add(t);
  const created = new Set([...createdTables(stmts)].filter((t) => !before.has(t)));
  const lower = norm(body);
  const fragments = sqlFragments(body);

  if (dir.noTransaction) {
    const steps = splitSteps(file.sql);
    if (!steps.length) v.push("no-transaction file has no steps");
    steps.forEach((step, i) => {
      const ss = splitStatements(stripComments(step));
      if (ss.some((s) => /\bconcurrently\b/i.test(s))) {
        if (ss.length !== 1 || !CONCURRENT_RE.test(ss[0])) {
          v.push(`step ${i + 1}: a CONCURRENTLY statement must be the ONLY statement of its step (it cannot run in a multi-statement query)`);
        }
        return;
      }
      const inTx = /^begin$/i.test(ss[0] ?? "");
      if (inTx && !/^commit$/i.test(ss[ss.length - 1] ?? "")) v.push(`step ${i + 1}: begin without a final commit`);
      v.push(...checkSets(inTx ? ss.slice(1) : ss, inTx, `step ${i + 1}`));
      for (const f of sqlFragments(ss.join(";\n"))) {
        for (const t of indexTargets(f)) {
          if (!t.concurrently && !created.has(t.table)) v.push(`step ${i + 1}: CREATE INDEX on an existing table (${t.table}) must be CONCURRENTLY, alone in its step`);
        }
      }
    });
    for (const step of steps) {
      const ss = splitStatements(stripComments(step));
      if (ss.length === 1 && /^create\s+(unique\s+)?index\s+concurrently\b/i.test(ss[0]) && !concurrentIndexOf(step)) {
        v.push("a concurrent index must be named and its table schema-qualified (create index concurrently [if not exists] <name> on <schema>.<table>)");
      }
    }
  } else {
    if (!/^begin$/i.test(stmts[0] ?? "") || !/^commit$/i.test(stmts[stmts.length - 1] ?? "")) {
      v.push("a transactional file must start with `begin;` and end with `commit;` (or declare `-- zavi:no-transaction`)");
    }
    v.push(...checkSets(stmts.slice(1), true, "file"));
    if (/\bconcurrently\b/.test(lower)) v.push("CONCURRENTLY cannot run in a transaction: put it in a `-- zavi:no-transaction` file, one statement per `-- zavi:step`");
    for (const f of fragments) {
      for (const t of indexTargets(f)) {
        if (!created.has(t.table)) v.push(`inline index build on an existing table (${t.table}): use CREATE INDEX CONCURRENTLY in a no-transaction file`);
      }
    }
  }

  const destructive: Array<[RegExp, string]> = [
    [/\bdrop\s+column\b/, "DROP COLUMN"],
    [/\bdrop\s+table\b/, "DROP TABLE"],
    [/\bdrop\s+schema\b/, "DROP SCHEMA"],
    [/\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/, "a column type change"],
    [/\brename\s+column\b/, "RENAME COLUMN"],
    [/\balter\s+table\s+(if\s+exists\s+)?\S+\s+rename\s+(?!constraint\b)\S+\s+to\b/, "RENAME COLUMN"],
    [/\balter\s+table\s+(if\s+exists\s+)?\S+\s+rename\s+to\b/, "RENAME TABLE"],
  ];
  const hits = destructive.filter(([re]) => re.test(lower)).map(([, what]) => what);
  if (hits.length && !dir.contractAfter) {
    v.push(`${[...new Set(hits)].join(", ")} only in a contract file (\`-- zavi:contract-after <expand version>\`), shipped in a LATER release than the code that stops using it`);
  }
  if (dir.contractAfter) {
    if (!versions.includes(dir.contractAfter)) v.push(`contract-after ${dir.contractAfter}: no such shard migration`);
    else if (dir.contractAfter >= file.version) v.push(`contract-after ${dir.contractAfter}: the expand file must come BEFORE ${file.version}`);
  }

  for (const f of fragments) {
    for (const { table, actions } of alterTables(f)) {
      if (table === "(unparsed)") {
        v.push("an ALTER TABLE this lint cannot read (dynamic SQL / format()): write it with a literal schema-qualified table");
        continue;
      }
      if (created.has(table)) continue;
      for (const a of actions) v.push(...actionHazards(table, a));
    }
  }
  if (/\bvacuum\s+full\b/.test(lower) || /(^|;|\s)cluster\s+[a-z]/.test(lower) || /\block\s+table\b/.test(lower)) {
    v.push("VACUUM FULL / CLUSTER / LOCK TABLE lock every site on the shard");
  }
  return v;
}

export function runnerSteps(file: { sql: string }): string[] {
  return parseDirectives(file.sql).noTransaction ? splitSteps(file.sql) : [file.sql];
}

export function concurrentIndexOf(step: string): { name: string; schema: string } | null {
  const ss = splitStatements(stripComments(step));
  if (ss.length !== 1) return null;
  const m = /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?([a-z][a-z0-9_]{0,62})\s+on\s+(?:only\s+)?([a-z][a-z0-9_]{0,62})\.[a-z_][a-z0-9_]{0,62}\b/i.exec(ss[0]);
  return m ? { name: m[1].toLowerCase(), schema: m[2].toLowerCase() } : null;
}
