import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

const CONNECTION_RPCS = [
  "set_slack_connection",
  "set_github_connection",
  "set_meta_ads_connection",
  "set_google_ads_connection",
  "set_stripe_connection",
  "set_email_connection",
  "set_operator_db_connection",
  "set_google_analytics_connection",
  "set_google_calendar_connection",
  "set_posthog_connection",
  "set_sentry_connection",
  "set_figma_connection",
  "set_supabase_connection",
  "set_google_sheets_connection",
  "set_discord_connection",
  "set_telegram_connection",
  "set_whatsapp_connection",
  "set_teams_connection",
  "set_social_connection",
  "set_higgsfield_connection",
  "set_pipedream_app_connection",
  "set_google_search_console_connection",
  "set_connector_connection",
  "set_composio_connection",
  "set_composio_app_connection",
  "refresh_connector_secrets",
  "set_apple_ads_connection",
  "set_managed_operator_db_connection",
  "set_sendgrid_connection",
] as const;

function migrationFilesSorted(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

function extractFunctionBody(sql: string, rpc: string): string | null {
  const startRe = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${rpc}(?![a-z0-9_])`,
    "i",
  );
  const startMatch = startRe.exec(sql);
  if (!startMatch) return null;
  const fromStart = sql.slice(startMatch.index);
  const endRe = /\$\$\s*;/;
  const endMatch = endRe.exec(fromStart);
  if (!endMatch) {
    return fromStart;
  }
  return fromStart.slice(0, endMatch.index + endMatch[0].length);
}

function resolveEffectiveBodies(): Record<string, { file: string; body: string }> {
  const files = migrationFilesSorted();
  const out: Record<string, { file: string; body: string }> = {};
  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    for (const rpc of CONNECTION_RPCS) {
      const body = extractFunctionBody(sql, rpc);
      if (body !== null) out[rpc] = { file, body };
    }
  }
  return out;
}

describe("connection-RPC rotate guard (fleet-wide static SQL) — reconnect-500 bug class", () => {
  const effective = resolveEffectiveBodies();

  it("resolves an effective definition for every known connection RPC", () => {
    for (const rpc of CONNECTION_RPCS) {
      expect(
        effective[rpc],
        `no create-or-replace definition found for ${rpc} in any migration — ` +
          `it was removed/renamed (update CONNECTION_RPCS) or never existed`,
      ).toBeDefined();
    }
  });

  it("NO live connection RPC hand-rolls vault.delete_secret (the dead call that 500'd reconnect)", () => {
    const offenders: string[] = [];
    for (const rpc of CONNECTION_RPCS) {
      const def = effective[rpc];
      if (!def) continue;
      if (/vault\.delete_secret/i.test(def.body)) {
        offenders.push(`${rpc} (effective def in ${def.file})`);
      }
    }
    expect(
      offenders,
      `These connection RPCs' EFFECTIVE definitions still call the dead ` +
        `vault.delete_secret — reconnect will 500 (ERROR 42883). Rotate via ` +
        `\`delete from vault.secrets where id = ...\` instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("rotating connection RPCs use the version-stable vault.secrets table delete", () => {
    const metaBody = effective.set_meta_ads_connection?.body ?? "";
    expect(metaBody).toMatch(/delete\s+from\s+vault\.secrets\s+where\s+id\s*=/i);
  });

  it("self-test: the extractor isolates one RPC body (set_composio_connection ≠ set_composio_app_connection)", () => {
    const fixture =
      "create or replace function set_composio_connection(p int) returns void " +
      "language sql as $$ select 1; $$;\n" +
      "create or replace function set_composio_app_connection(p int) returns void " +
      "language sql as $$ select 2; $$;";
    const a = extractFunctionBody(fixture, "set_composio_connection");
    const b = extractFunctionBody(fixture, "set_composio_app_connection");
    expect(a).toContain("select 1");
    expect(a).not.toContain("select 2");
    expect(b).toContain("select 2");
    expect(b).not.toContain("select 1");
  });

  it("self-test: a synthetic RPC body with vault.delete_secret IS caught", () => {
    const bad =
      "create or replace function set_evil_connection() returns void " +
      "language plpgsql as $$ begin perform vault.delete_secret(v_old); end $$;";
    const body = extractFunctionBody(bad, "set_evil_connection");
    expect(body).not.toBeNull();
    expect(/vault\.delete_secret/i.test(body!)).toBe(true);
  });
});

describe("rotate-guard allowlist completeness", () => {
  it("every set_*_connection function in migrations is registered in CONNECTION_RPCS", () => {
    const declared = new Set<string>();
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(set_[a-z0-9_]*_connection)\b/gi)) {
        declared.add(m[1].toLowerCase());
      }
    }
    const registered = new Set<string>(CONNECTION_RPCS as readonly string[]);
    const unregistered = [...declared].filter((d) => !registered.has(d)).sort();
    expect(
      unregistered,
      `These connection RPCs exist in migrations but are NOT in CONNECTION_RPCS, so the ` +
        `rotate guard never inspects them (a green run proves nothing for them):\n  ` +
        unregistered.join("\n  "),
    ).toEqual([]);
  });
});
