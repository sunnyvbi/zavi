
import { BLESSED_TEMPLATE_FILES, readBlessedTemplate } from "@/services/agents/codegen-templates";
import type { PushedFile } from "./app-db-on-demand";

export type RoleGrantRule =
  | "sql_role_write"
  | "orm_role_write"
  | "role_literal_grant"
  | "first_user_grant"
  | "email_or_env_grant";

export type RoleGrantHit = { file: string; line: number; rule: RoleGrantRule };

export const ROLE_GRANT_RULE_TEXT: Record<RoleGrantRule, string> = {
  sql_role_write: "SQL write sets a role/admin/owner column",
  orm_role_write: "ORM write sets a role/admin/owner field",
  role_literal_grant: "assigns the admin/owner role in code",
  first_user_grant: "grants a role by signup order / first user / row count",
  email_or_env_grant: "grants a role by email or env var",
};

const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const ROLE_COL = String.raw`(?:role|user_role|admin|owner)`;
const FLAG_COL = String.raw`(?:is_admin|is_owner|is_superuser|superuser)`;
const ROLE_KEY = String.raw`(?:role|user_role|userRole)`;
const FLAG_KEY = String.raw`(?:is_admin|isAdmin|is_owner|isOwner|is_superuser|isSuperuser)`;
const PRIV_KEY = String.raw`(?:${ROLE_KEY}|${FLAG_KEY})`;
const USERS_TABLE = String.raw`(?:"?public"?\.)?"?(?:users|invites)"?`;
const UPDATE_ALIAS = String.raw`(?:\s+(?:AS\s+)?(?!SET\b)[A-Za-z_]\w*)?`;
const GRANT_TABLE = String.raw`(?:public\.)?"?(?:admins|owners|admin_users|user_roles|roles|superusers)"?`;
const SET_SPAN = String.raw`(?:(?!\b(?:WHERE|RETURNING|FROM)\b)[^;"\x60]){0,400}?`;
const SET_COL = (cols: string) => String.raw`"?\b${cols}"?\s*=(?!=)`;

export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += n;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      else if (c === "\n" && quote !== "`") quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

function lineCounts(content: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of content.split(/\r?\n/)) {
    const t = l.trim();
    if (t) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

let _blessed: Map<string, Map<string, number>> | null = null;
function blessedLines(): Map<string, Map<string, number>> {
  if (_blessed) return _blessed;
  const m = new Map<string, Map<string, number>>();
  for (const { target, source } of BLESSED_TEMPLATE_FILES) m.set(target, lineCounts(readBlessedTemplate(source)));
  _blessed = m;
  return m;
}

function blessedFor(path: string): Map<string, number> | null {
  const p = path.replace(/^\.?\//, "");
  return blessedLines().get(p) ?? null;
}

const MULTILINE_RULES: Array<{ rule: RoleGrantRule; re: RegExp; usersNear?: boolean }> = [
  { rule: "sql_role_write", re: new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${USERS_TABLE}${UPDATE_ALIAS}\s+SET\b${SET_SPAN}${SET_COL(`(?:${ROLE_COL}|${FLAG_COL})`)}`, "gi") },
  { rule: "sql_role_write", re: new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?[\w."]+${UPDATE_ALIAS}\s+SET\b${SET_SPAN}${SET_COL(FLAG_COL)}`, "gi") },
  { rule: "sql_role_write", re: new RegExp(String.raw`\bINSERT\s+INTO\s+${USERS_TABLE}\s*\([^)]*\b(?:${ROLE_COL}|${FLAG_COL})\b[^)]*\)`, "gi") },
  { rule: "sql_role_write", re: new RegExp(String.raw`\bINSERT\s+INTO\s+[\w."]+\s*\([^)]*\b${FLAG_COL}\b[^)]*\)`, "gi") },
  { rule: "sql_role_write", re: new RegExp(String.raw`\bINSERT\s+INTO\s+${GRANT_TABLE}[\s(]`, "gi") },
  { rule: "sql_role_write", re: new RegExp(String.raw`\bDO\s+UPDATE\s+SET\b${SET_SPAN}${SET_COL(`(?:${ROLE_COL}|${FLAG_COL})`)}`, "gi") },
  { rule: "orm_role_write", re: new RegExp(String.raw`\.(?:set|values|insert|create|update|upsert|updateMany|createMany)\(\s*\{[^{}]*\b${FLAG_KEY}\b\s*[:,}]`, "g") },
  { rule: "orm_role_write", re: new RegExp(String.raw`\.(?:set|values|insert|create|update|upsert|updateMany|createMany)\(\s*\{[^{}]*\b${ROLE_KEY}\b\s*[:,}]`, "g"), usersNear: true },
  { rule: "orm_role_write", re: new RegExp(String.raw`\b(?:data|create|update)\s*:\s*\{[^{}]*\b${FLAG_KEY}\b\s*[:,}]`, "g") },
  { rule: "orm_role_write", re: new RegExp(String.raw`\b(?:data|create|update)\s*:\s*\{[^{}]*\b${ROLE_KEY}\b\s*[:,}]`, "g"), usersNear: true },
];
const USERS_NEAR = /\busers\b|\bUsers\b|\.user\s*\./;
const USERS_NEAR_CHARS = 160;

const ROLE_LITERAL = new RegExp(
  String.raw`\b${PRIV_KEY}\s*(?::|=(?!=))\s*(?:(["'\x60])(?:admin|owner|superadmin|super_admin|superuser)\1(?!\s*\|)|true\b)`,
  "gi",
);
const SQL_FILTER_BEFORE = /\b(?:WHERE|AND|OR|ON|WHEN|HAVING|NOT)\s+(?:\w+\.)?"?$/i;

const READ_BRACE_BEFORE =
  /(?:\b(?:where|having|AND|OR|NOT|some|every|none|is|isNot)\s*:\s*|\.(?:where|andWhere|orWhere|whereNot|find(?!\w*(?:Create|Update|Replace|Upsert|Modify|Delete|Remove))\w*|count\w*|aggregate|groupBy|exists|filter|some|every)\s*\(\s*)$/;
const WRITE_BRACE_BEFORE =
  /(?:\b(?:data|create|update|set|values|defaults|\$set|\$setOnInsert)\s*:\s*|\.(?:set|values|insert|create\w*|update\w*|upsert|save|find\w*(?:Create|Update|Replace|Upsert|Modify)\w*|replace\w*|bulkCreate|bulkWrite|insertMany|insertOne)\s*\(\s*)$/;
const READ_SCAN_CHARS = 2000;

function inReadFilter(code: string, idx: number): boolean {
  let depth = 0;
  for (let j = idx - 1; j >= 0 && j >= idx - READ_SCAN_CHARS; j--) {
    const c = code[j];
    if (c === "}" || c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") depth = Math.max(0, depth - 1);
    else if (c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = code.slice(Math.max(0, j - 80), j);
      if (WRITE_BRACE_BEFORE.test(before)) return false;
      if (READ_BRACE_BEFORE.test(before)) return true;
    }
  }
  return false;
}

const FIRST_USER = new RegExp(
  [
    String.raw`\bcount\s*\(\s*\*?\s*\)`,
    String.raw`\b\w*(?:count|Count|total|Total)\s*(?:===|==|<=|<)\s*[01]\b`,
    String.raw`\brows\s*\.\s*length\s*(?:===|==)\s*0\b`,
    String.raw`\bfirst_?user\b|\bisFirst\w*`,
    String.raw`\b(?:\w+\.)?id\s*===?\s*1\b`,
  ].join("|"),
  "i",
);
const GRANT_NEAR = new RegExp(
  [
    String.raw`\?\s*(["'\x60])(?:admin|owner)\1`,
    String.raw`\b${PRIV_KEY}\s*(?::|=(?!=))\s*(?:(["'\x60])(?:admin|owner)\2|true\b)`,
    String.raw`\bSET\s+(?:${ROLE_COL}|${FLAG_COL})\s*=`,
  ].join("|"),
  "i",
);
const FIRST_USER_WINDOW = 6;

const ENV_PRIV = /\bprocess\.env(?:\.|\[\s*["'\x60])\w*(?:ADMIN|OWNER|SUPERUSER)\w*/i;
const EMAIL_CMP = [
  /\bemail\b[^\n;]*?(?:===|!==|==|!=)\s*(?:["'\x60][^"'\x60\s]*@|\w*(?:admin|owner)\w*)/i,
  /(?:["'\x60][^"'\x60\s]+@[^"'\x60\s]+["'\x60]|\b\w*(?:admin|owner)\w*)\s*(?:===|==)\s*[\w.?]*email\b/i,
  /\b\w*(?:admin|owner)\w*\s*\.\s*(?:includes|has|indexOf|some)\s*\([^)]*email/i,
];

function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function detectUnsafeRoleGrant(files: ReadonlyArray<PushedFile>): RoleGrantHit[] {
  const hits: RoleGrantHit[] = [];
  for (const f of files) {
    if (f.action === "delete" || f.encoding === "base64" || !f.content) continue;
    if (!CODE_EXT.test(f.path) || TEST_FILE.test(f.path)) continue;
    const rawLines = f.content.split(/\r?\n/);
    const code = blankComments(f.content.replace(/\r\n/g, "\n"));
    const lines = code.split("\n");
    const blessed = blessedFor(f.path);
    const own = blessed ? lineCounts(f.content) : null;
    const seen = new Map<number, RoleGrantRule>();
    const add = (line: number, rule: RoleGrantRule) => {
      if (seen.has(line)) return;
      if (blessed && own) {
        const t = (rawLines[line - 1] ?? "").trim();
        const allowed = blessed.get(t) ?? 0;
        if (allowed > 0 && (own.get(t) ?? 0) <= allowed) return;
      }
      seen.set(line, rule);
    };

    for (const { rule, re, usersNear } of MULTILINE_RULES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        if (usersNear && !USERS_NEAR.test(code.slice(Math.max(0, m.index - USERS_NEAR_CHARS), m.index))) continue;
        add(lineOf(code, m.index), rule);
      }
    }

    const lineStart: number[] = [];
    for (let i = 0, off = 0; i < lines.length; off += lines[i].length + 1, i++) lineStart.push(off);
    const isFilter = (j: number, at: number) =>
      SQL_FILTER_BEFORE.test(lines[j].slice(0, at)) || inReadFilter(code, lineStart[j] + at);

    lines.forEach((l, i) => {
      const ln = i + 1;
      ROLE_LITERAL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ROLE_LITERAL.exec(l)) !== null) {
        if (!isFilter(i, m.index)) add(ln, "role_literal_grant");
      }
      if (ENV_PRIV.test(l) || EMAIL_CMP.some((re) => re.test(l))) add(ln, "email_or_env_grant");
      if (FIRST_USER.test(l)) {
        const lo = Math.max(0, i - FIRST_USER_WINDOW);
        const hi = Math.min(lines.length - 1, i + FIRST_USER_WINDOW);
        for (let j = lo; j <= hi; j++) {
          const g = GRANT_NEAR.exec(lines[j]);
          if (g && !isFilter(j, g.index)) {
            add(ln, "first_user_grant");
            break;
          }
        }
      }
    });

    for (const [line, rule] of seen) hits.push({ file: f.path, line, rule });
  }
  return hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

export const ROLE_GRANT_ERROR_PREFIX = "unsafe_role_grant:";

export function formatRoleGrantError(hits: ReadonlyArray<RoleGrantHit>): string {
  const shown = hits.slice(0, 5).map((h) => `${h.file}:${h.line} ${ROLE_GRANT_RULE_TEXT[h.rule]}`);
  const more = hits.length > 5 ? ` (+${hits.length - 5} more)` : "";
  return (
    `${ROLE_GRANT_ERROR_PREFIX} ${shown.join("; ")}${more}. ` +
    "Fix: gate admin pages/routes/actions with requireAdminPage/requireAdminRoute/requireAdminAction and grant roles only via invite links (blessed redeemInvite); never by signup order, first user, row count, email or env."
  );
}

export function assertNoUnsafeRoleGrant(files: ReadonlyArray<PushedFile>): void {
  const hits = detectUnsafeRoleGrant(files);
  if (hits.length > 0) throw new Error(formatRoleGrantError(hits));
}
