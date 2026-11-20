import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

function strip(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

const code = strip(readFileSync(join(MIGRATIONS_DIR, "20260920050000_channel_settings.sql"), "utf8"));

const allMigrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, code: strip(readFileSync(join(MIGRATIONS_DIR, f), "utf8")) }));

describe("20260920050000_channel_settings.sql", () => {
  it("control 1: REVOKE ALL from anon and authenticated, and never re-grants SELECT", () => {
    expect(code).toMatch(/revoke all on table channel_settings from anon, authenticated/i);
    expect(code).not.toMatch(/grant\s+(select|all)[^;]*on\s+table\s+channel_settings[^;]*authenticated/i);
    expect(code).not.toMatch(/create policy[^;]*on channel_settings/i);
    expect(code).toMatch(/alter table channel_settings enable row level security/i);
  });

  it("NO later migration grants channel_settings to authenticated/anon or adds a policy", () => {
    const offenders: string[] = [];
    for (const m of allMigrations) {
      if (/grant[^;]*\bon\s+table\s+channel_settings\b[^;]*\b(authenticated|anon)\b/i.test(m.code)) {
        offenders.push(`${m.file}: grants channel_settings to authenticated/anon`);
      }
      if (/create\s+policy[^;]*\bon\s+channel_settings\b/i.test(m.code)) {
        offenders.push(
          `${m.file}: adds an RLS policy to channel_settings. There is no channel claim in the JWT, ` +
            `so a tenant-only policy is a same-tenant cross-CHANNEL leak. Reads go through ` +
            `get_channel_settings, where p_channel_slug is required.`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("control 2: p_channel_slug is a REQUIRED argument on both RPCs (no DEFAULT)", () => {
    for (const fn of ["get_channel_settings", "set_channel_settings"]) {
      const m = code.match(new RegExp(`create or replace function ${fn}\\s*\\(([^)]*)\\)`, "i"));
      expect(m, `${fn} must be declared`).not.toBeNull();
      const args = (m as RegExpMatchArray)[1];
      expect(args, `${fn} must take p_channel_slug`).toMatch(/p_channel_slug\s+text/i);
      expect(args).not.toMatch(/p_channel_slug\s+text\s+default/i);
    }
  });

  it("control 2: both RPCs filter on channel_slug, not tenant alone", () => {
    expect(code).toMatch(/s\.channel_slug = p_channel_slug/i);
    expect(code).toMatch(/channel_slug = p_channel_slug/i);
  });

  it("control 3: composite FK to tenant_channels", () => {
    expect(code).toMatch(
      /foreign key \(tenant_id, channel_slug\)\s*references tenant_channels \(tenant_id, channel_slug\)/i,
    );
  });

  it("is security definer with a pinned search_path INCLUDING pg_temp", () => {
    const defs = code.match(/security definer set search_path = [^\n]*/gi) ?? [];
    expect(defs.length).toBe(2);
    for (const d of defs) expect(d).toMatch(/search_path = public, pg_temp/i);
    expect(code).not.toMatch(/security definer set search_path = public\s*(?!,)\s*as/i);
  });

  it("revokes execute from public/anon/authenticated and grants only service_role", () => {
    expect(code).toMatch(
      /revoke all on function get_channel_settings\(uuid, text\)\s+from public, anon, authenticated/i,
    );
    expect(code).toMatch(
      /grant execute on function get_channel_settings\(uuid, text\) to service_role/i,
    );
    expect(code).toMatch(
      /revoke all on function set_channel_settings\(uuid, text, text, jsonb, uuid\)\s+from public, anon, authenticated/i,
    );
    expect(code).toMatch(
      /grant execute on function set_channel_settings\(uuid, text, text, jsonb, uuid\) to service_role/i,
    );
    expect(code).not.toMatch(/grant execute on function (get|set)_channel_settings[^;]*authenticated/i);
  });

  it("keeps a row per item with its own id, and the id-preserving unique key", () => {
    expect(code).toMatch(/id\s+uuid primary key default gen_random_uuid\(\)/i);
    expect(code).toMatch(/unique \(tenant_id, channel_slug, field_id, item\)/i);
  });

  it("refuses an out-of-vocabulary status/origin instead of nulling it", () => {
    expect(code).toMatch(
      /v_status not in \([^)]*\) then\s*return jsonb_build_object\(\s*'ok', false, 'code', 'invalid_status'/i,
    );
    expect(code).toMatch(
      /v_origin not in \([^)]*\) then\s*return jsonb_build_object\(\s*'ok', false, 'code', 'invalid_origin'/i,
    );
    expect(code).not.toMatch(/v_status not in \([^)]*\) then\s*v_status := null/i);
    expect(code).not.toMatch(/v_origin not in \([^)]*\) then\s*v_origin := null/i);
  });

  it("validates the whole payload BEFORE the first write, so a refusal is atomic", () => {
    const firstRefusal = code.search(/'code', 'invalid_status'/i);
    const firstInsert = code.search(/insert into channel_settings/i);
    expect(firstRefusal).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(-1);
    expect(firstRefusal).toBeLessThan(firstInsert);
  });

  it("carries `note` for reddit's `why`, capped to match its 300-char source", () => {
    expect(code).toMatch(/note\s+text null check \(note is null or char_length\(btrim\(note\)\) <= 300\)/i);
    expect(code).toMatch(/note\s*=\s*excluded\.note/i);
    expect(code).toMatch(/'note', s\.note/i);
  });

  it("carries `detail` for reddit_competitors.domain, named generically", () => {
    expect(code).toMatch(/detail\s+text null check \(detail is null or char_length\(btrim\(detail\)\) between 1 and 200\)/i);
    expect(code).toMatch(/detail\s*=\s*excluded\.detail/i);
    expect(code).toMatch(/'detail', s\.detail/i);
    expect(code).not.toMatch(/^\s*domain\s+text/im);
  });

  it("carries `origin` — who put the item here, which status cannot say", () => {
    const two = /'suggested',\s*'custom'/i;
    expect(code).toMatch(
      new RegExp(`origin\\s+text null check \\(origin is null or origin in \\(${two.source}\\)\\)`, "i"),
    );
    expect(code).toMatch(new RegExp(`v_origin not in \\(${two.source}\\)`, "i"));
    expect(code.match(new RegExp(two.source, "gi")) ?? []).toHaveLength(2);
    expect(code).toMatch(/origin\s*=\s*excluded\.origin/i);
    expect(code).toMatch(/'origin', s\.origin/i);
  });

  it("every nullable column is written on the id-preserving UPDATE too", () => {
    for (const col of ["item_type", "status", "position", "note", "origin", "detail"]) {
      expect(code, `${col} missing from the do-update set-list`).toMatch(
        new RegExp(`${col}\\s*=\\s*excluded\\.${col}`, "i"),
      );
    }
  });

  it("status is reddit's OWN four values, in the CHECK and the validator alike", () => {
    const four = /'suggested',\s*'tracking',\s*'paused',\s*'dismissed'/i;
    expect(code).toMatch(new RegExp(`status\\s+text null\\s*check \\(status is null or status in \\(${four.source}\\)\\)`, "i"));
    expect(code).toMatch(new RegExp(`v_status not in \\(${four.source}\\)`, "i"));
    expect(code.match(new RegExp(four.source, "gi")) ?? []).toHaveLength(2);
    expect(code).not.toMatch(/status in \([^)]*'on'[^)]*\)/i);
    expect(code).not.toMatch(/v_status not in \([^)]*'on'[^)]*\)/i);
  });

  it("the write UPSERTS on the unique key so an unchanged item keeps its id", () => {
    expect(code).toMatch(
      /on conflict \(tenant_id, channel_slug, field_id, item\) do update/i,
    );
    expect(code).toMatch(/not \(s\.item = any \(v_keep\)\)/i);
  });

  it("verifies the injected tenant against a server-owned row rather than trusting it", () => {
    expect(code).toMatch(/from tenant_channels tc\s+where tc\.tenant_id = p_tenant_id/i);
    expect(code).toMatch(/from tenant_users tu\s+where tu\.tenant_id = p_tenant_id/i);
  });

  it("returns { fields: {} } for a channel with no rows", () => {
    expect(code).toMatch(/coalesce\(jsonb_object_agg\([^)]*\), '\{\}'::jsonb\)/i);
    expect(code).toMatch(/jsonb_build_object\('fields', v_out\)/i);
  });
});
