import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261009100400_displace_channel_actions_card_lock.sql";
const PRIOR = "20260921100000_channel_action_displacement.sql";
const WRITERS = "20261009100200_channel_card_layered_dedupe.sql";

const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
const read = (f: string) => strip(readFileSync(join(DIR, f), "utf8"));
const fnBody = (s: string) => {
  const start = s.indexOf("create or replace function displace_channel_actions");
  return s.slice(start, s.indexOf("end $$;", start) + "end $$;".length);
};

const code = read(FILE);
const body = fnBody(code);
const prior = fnBody(read(PRIOR));
const SIG = "displace_channel_actions\\(uuid, text, uuid, uuid\\[\\], text\\)";
const LOCK = "pg_advisory_xact_lock(hashtextextended('channel_card:' || ";

describe(FILE, () => {
  it("is the definition of displace_channel_actions right before 20261020160000", () => {
    const defining = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /create or replace function (public\.)?displace_channel_actions\b/.test(readFileSync(join(DIR, f), "utf8")))
      .sort();
    expect(defining[defining.length - 1]).toBe("20261020160000_uncertain_failed_twin_stays_open.sql");
    expect(defining[defining.length - 2]).toBe(FILE);
    expect(defining[defining.length - 3]).toBe(PRIOR);
  });

  it("takes the writers' exact lock key, before any row lock", () => {
    expect(body).toContain(`${LOCK}p_tenant_id || ':' || p_channel_slug, 0))`);
    expect(read(WRITERS)).toContain(`${LOCK}v_tenant || ':' || v_channel, 0))`);
    expect(body.indexOf(LOCK)).toBeGreaterThan(0);
    expect(body.indexOf(LOCK)).toBeLessThan(body.indexOf("for update"));
    expect(body.match(/pg_advisory_xact_lock/g)).toHaveLength(1);
  });

  it("row-locks only a row of this tenant and channel", () => {
    expect(body).toMatch(
      /select \* into v_row from channel_actions\s+where id = v_id and tenant_id = p_tenant_id and channel_slug = p_channel_slug\s+for update;/,
    );
  });

  it("keeps every refusal, the idempotency key, the note and the return shape of the prior body", () => {
    for (const line of [
      "or v_row.tenant_id is distinct from p_tenant_id",
      "or v_row.channel_slug is distinct from p_channel_slug",
      "or v_row.status not in ('pending', 'snoozed')",
      "or coalesce(v_row.exec_status, '') in ('queued', 'dispatching')",
      "v_key := 'displaced:' || p_run_id || ':' || v_id;",
      "where action_id = v_id and event_key = v_key) then",
      "set status = 'displaced', status_at = now(), note = coalesce(note, v_note)",
      "(p_tenant_id, v_id, 'displaced', 'channel_run', p_run_id, v_note, v_key);",
      "return jsonb_build_object('ok', true, 'displaced', v_displaced, 'skipped', v_skipped);",
      "return jsonb_build_object('ok', true, 'displaced', 0, 'skipped', 0);",
      "highest new: ",
    ]) {
      expect(prior, line).toContain(line);
      expect(body, line).toContain(line);
    }
    expect(body).not.toMatch(/delete from channel_actions/i);
  });

  it("decides nothing by age", () => {
    expect(body).not.toMatch(/interval/i);
    expect(body).not.toMatch(/order by/i);
    expect(body.match(/now\(\)/g) ?? []).toHaveLength(1);
  });

  it("keeps security definer, the pinned search_path and service-role-only grants", () => {
    expect(body).toMatch(/language plpgsql security definer set search_path = public, pg_temp/);
    expect(code).toMatch(new RegExp(`revoke all on function ${SIG}\\s+from public, anon, authenticated`));
    expect(code).toMatch(new RegExp(`grant execute on function ${SIG}\\s+to service_role`));
    expect(code).toMatch(/^begin;/m);
    expect(code).toMatch(/^commit;/m);
  });
});
