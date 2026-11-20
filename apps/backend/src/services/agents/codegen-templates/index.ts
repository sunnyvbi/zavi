import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES_ROOT = join(
  process.cwd(),
  "src",
  "services",
  "agents",
  "codegen-templates",
);

export const BLESSED_TEMPLATE_FILES: ReadonlyArray<{
  target: string;
  source: string;
  role: string;
}> = [
  {
    target: "lib/db.ts",
    source: "lib-db.ts.template",
    role: "server-only Postgres client (DATABASE_URL, int8→number type-parser, TLS via connection string, withTransaction)",
  },
  {
    target: "lib/session.ts",
    source: "lib-session.ts.template",
    role: "fail-closed SESSION_SECRET accessor + HMAC sign/verify + exp (NO hardcoded default)",
  },
  {
    target: "scripts/migrate.mjs",
    source: "migrate.mjs.template",
    role: "deploy-time append-only data-preserving migration (ledger, transaction, FK order, bounded connect retry; users.role app_role + invites + _zavi_audit)",
  },
  {
    target: "lib/auth.ts",
    source: "auth-lib.ts.template",
    role: "auth helpers: signed httpOnly cookie, RELATIVE-Location redirects, throttle, ?error codes, currentUser() with role, requireAdminPage/Route/Action, redeemInvite",
  },
  {
    target: "app/api/signup/route.ts",
    source: "auth-signup-route.ts.template",
    role: "POST signup: bcrypt hash, INSERT (role = DB default user), 23505 -> generic message, optional invite",
  },
  {
    target: "app/api/login/route.ts",
    source: "auth-login-route.ts.template",
    role: "POST login: throttled, one generic failure message, constant-cost bcrypt compare, optional invite",
  },
  {
    target: "app/api/auth/magic/route.ts",
    source: "auth-magic-route.ts.template",
    role: "owner login link: GET only renders a confirm button (link scanners never consume the token); POST redeems the single-use, expiring, email-bound invite token, finds or creates that user, applies the invite role, signs in, redirects to /admin",
  },
  {
    target: "app/api/logout/route.ts",
    source: "auth-logout-route.ts.template",
    role: "POST logout: clear the session cookie",
  },
];

export function readBlessedTemplate(source: string): string {
  return readFileSync(join(TEMPLATES_ROOT, source), "utf8");
}

let _cached: string | null = null;
export function buildBlessedTemplatesBaseline(): string {
  if (_cached !== null) return _cached;
  let sections: string;
  try {
    sections = BLESSED_TEMPLATE_FILES.map(({ target, source, role }) => {
      const lang = source.endsWith(".mjs.template") ? "js" : "ts";
      const content = readBlessedTemplate(source);
      return `#### \`${target}\` — ${role}\nCopy this verbatim and configure ONLY the parts the comments mark as yours; do NOT re-derive the plumbing.\n\`\`\`${lang}\n${content}\n\`\`\``;
    }).join("\n\n");
  } catch {
    _cached = "";
    return _cached;
  }

  _cached = `### BLESSED TEMPLATES BASELINE (CONFIGURE these reviewed files — do NOT reinvent DB/auth/session/migration plumbing)
The platform ships CORRECT, reviewed reference files for the app plumbing that has historically been the #1 source of dead generated apps (ILIKE-on-int, uid string-vs-number, lazy per-request migrations, hardcoded session secrets). For each file below, COPY it into the generated app at the stated path and change ONLY the parts its comments mark as yours (queries, append-only MIGRATIONS entries, MAX_AGE). Do NOT rewrite the connection/type-parser/migration-ledger/fail-closed plumbing — that is the part that keeps the build alive and preserves customer data. These files satisfy the DB SCHEMA, SESSION SECRET, REDIRECT, and AUTH baselines above by construction; treat the baselines as the WHY and these files as the WHAT.

${sections}`;
  return _cached;
}
