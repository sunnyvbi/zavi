import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260922120000_channel_mention_alerts.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const fns = code.split(/create or replace function /).slice(1);
const claim = fns.find((f) => f.startsWith("claim_mention_alert_send"));
const mark = fns.find((f) => f.startsWith("mark_mention_alert_sent"));

describe("20260922120000_channel_mention_alerts.sql", () => {
  it("defines both functions the send path calls", () => {
    expect(claim).toBeDefined();
    expect(mark).toBeDefined();
  });

  it("alerts one mention at most once, keyed tenant-first", () => {
    expect(code).toMatch(/primary key \(tenant_id, channel, mention_key\)/i);
    expect(code).not.toMatch(/primary key \(mention_key\)/i);
    expect(code).not.toMatch(/primary key \(channel, mention_key\)/i);
  });

  it("serializes a tenant's claim against itself, transaction-scoped", () => {
    expect(claim).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('mention_alert:' \|\| p_tenant_id::text, 0\)\)/i,
    );
    expect(code).not.toMatch(/pg_advisory_lock\(/i);
  });

  it("holds the 20-hour cap against a delivery that is claimed or sent", () => {
    expect(claim).toMatch(/status in \('claimed', 'sent'\)/i);
    expect(claim).toMatch(/coalesce\(sent_at, claimed_at\) > now\(\) - interval '20 hours'/i);
    expect(claim).toMatch(/raise exception 'cooldown'/i);
  });

  it("lets the evening run retry a morning send that failed, which the cap must not count", () => {
    expect(claim).toMatch(/where channel_mention_alert_deliveries\.status = 'failed'/i);
    expect(claim).not.toMatch(/where channel_mention_alert_deliveries\.status = 'claimed'\s*$/im);
    expect(claim).toMatch(/status\s*=\s*'claimed'/i);
    expect(claim!.match(/status in \('claimed', 'sent'\)/gi)).toHaveLength(1);
    expect(claim).not.toMatch(/status in \('claimed', 'sent', 'failed'\)/i);
  });

  it("never lets a second claim ride the first one's row", () => {
    expect(claim).toMatch(/attempt_id = gen_random_uuid\(\)/i);
    expect(claim).toMatch(/raise exception 'already_finalized'/i);
  });

  it("scopes every write by the injected tenant, not by id alone", () => {
    expect(mark).toMatch(/where id = p_id and tenant_id = p_tenant_id/i);
    expect(mark).toMatch(/insert into channel_mention_alerts_sent \(tenant_id, channel, mention_key\)/i);
    expect(mark).toMatch(/select p_tenant_id, m\.channel, m\.mention_key/i);
  });

  it("only ever records a mention as alerted on a send that actually went out", () => {
    expect(mark).toMatch(/p_status not in \('sent', 'failed'\)/i);
    expect(mark).toMatch(/if p_status = 'sent' and jsonb_typeof\(p_mentions\) = 'array' then/i);
    expect(mark).toMatch(/on conflict \(tenant_id, channel, mention_key\) do nothing/i);
  });

  it("pins the search path on both security definers", () => {
    for (const body of [claim!, mark!]) {
      expect(body).toMatch(/security definer set search_path = public, pg_temp/i);
    }
  });

  it("is reachable by the worker's role and by nobody else", () => {
    for (const sig of [
      "claim_mention_alert_send\\(uuid, date\\)",
      "mark_mention_alert_sent\\(uuid, uuid, text, jsonb\\)",
    ]) {
      const revoke = new RegExp(`revoke all on function ${sig} from ([^;]+);`, "i");
      const roles = revoke.exec(code)?.[1] ?? "";
      expect(roles, `${sig} must be revoked from anon and authenticated, not only public`).toMatch(
        /\banon\b/i,
      );
      expect(roles).toMatch(/\bauthenticated\b/i);
      expect(roles).toMatch(/\bpublic\b/i);
    }
    expect(code.match(/grant execute on function/gi)).toHaveLength(2);
    expect(code).not.toMatch(/grant execute on function[^;]*to (anon|authenticated)/i);
  });

  it("leaves both tables service-role-only, with row security on and no policy", () => {
    expect(code).toMatch(/alter table channel_mention_alerts_sent enable row level security/i);
    expect(code).toMatch(/alter table channel_mention_alert_deliveries enable row level security/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("cascades a deleted tenant's alert history rather than orphaning it", () => {
    expect(code.match(/references tenants\(id\) on delete cascade/gi)).toHaveLength(2);
  });
});
