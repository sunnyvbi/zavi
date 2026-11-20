import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

const file = readdirSync(MIGRATIONS_DIR).find((f) =>
  /^\d{14}_team_roster_discovery\.sql$/.test(f),
);
if (!file) {
  throw new Error(
    "team_roster_discovery migration not found — expected 14-digit timestamp prefix file",
  );
}
const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

describe("team_roster_discovery migration", () => {
  describe("team_members table", () => {
    it("declares the expected columns", () => {
      expect(sql).toMatch(/create table team_members/i);
      expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
      expect(sql).toMatch(/display_name\s+text not null/i);
      expect(sql).toMatch(/primary_email\s+text/i);
      expect(sql).toMatch(/merged_into_id\s+uuid references team_members\(id\)/i);
    });

    it("kind constrained to human|bot|service_account", () => {
      expect(sql).toMatch(/kind in \('human','bot','service_account'\)/);
    });

    it("status constrained to active|deactivated|merged_into", () => {
      expect(sql).toMatch(/status in \('active','deactivated','merged_into'\)/);
    });

    it("unique email index uses lower(primary_email) for case-insensitive dedupe (codex C15)", () => {
      expect(sql).toMatch(/lower\(primary_email\)/);
      expect(sql).toMatch(/team_members_tenant_email_lower_uniq/);
      expect(sql).toMatch(/where primary_email is not null and status = 'active'/);
    });

    it("RLS enabled + only member-select policy (writes via security-definer RPCs)", () => {
      expect(sql).toMatch(/alter table team_members enable row level security/i);
      expect(sql).toMatch(/create policy team_members_member_select/i);
      expect(sql).not.toMatch(/create policy [^;]+ for (insert|update|delete) on team_members/i);
    });
  });

  describe("team_member_identities table", () => {
    it("declares the 1:N child table tied to team_members", () => {
      expect(sql).toMatch(/create table team_member_identities/i);
      expect(sql).toMatch(/member_id\s+uuid not null references team_members\(id\) on delete cascade/i);
      expect(sql).toMatch(/provider\s+text not null check \(provider in \('github','jira','slack'\)\)/i);
    });

    it("unique (tenant_id, provider, external_id)", () => {
      expect(sql).toMatch(/unique \(tenant_id, provider, external_id\)/);
    });

    it("confidence numeric 0-1 with default 1.00", () => {
      expect(sql).toMatch(/confidence\s+numeric\(3,2\) not null default 1\.00/i);
    });

    it("source constrained to auto|admin|oauth_self", () => {
      expect(sql).toMatch(/source in \('auto','admin','oauth_self'\)/);
    });

    it("RLS enabled + only member-select policy", () => {
      expect(sql).toMatch(/alter table team_member_identities enable row level security/i);
      expect(sql).toMatch(/create policy team_member_identities_member_select/i);
      expect(sql).not.toMatch(/create policy [^;]+ for (insert|update|delete) on team_member_identities/i);
    });
  });

  describe("team_discover_jobs table", () => {
    it("declares the discovery job log", () => {
      expect(sql).toMatch(/create table team_discover_jobs/i);
      expect(sql).toMatch(/status\s+text not null default 'queued'/i);
      expect(sql).toMatch(/status in \('queued','running','done','error'\)/);
      expect(sql).toMatch(/providers\s+text\[\] not null/i);
      expect(sql).toMatch(/results\s+jsonb/i);
    });

    it("RLS enabled + only member-select policy", () => {
      expect(sql).toMatch(/alter table team_discover_jobs enable row level security/i);
      expect(sql).toMatch(/create policy team_discover_jobs_member_select/i);
    });
  });

  describe("RPCs", () => {
    const rpcs = [
      "list_team_members",
      "get_team_member_detail",
      "trigger_team_discover",
      "update_team_member",
      "merge_team_members",
    ];

    for (const rpc of rpcs) {
      it(`${rpc} is security-definer with pinned search_path`, () => {
        const re = new RegExp(
          `create or replace function ${rpc}[\\s\\S]{0,600}security definer set search_path = public`,
        );
        expect(sql, `${rpc} declaration shape`).toMatch(re);
      });

      it(`${rpc} enforces tenant_users membership`, () => {
        const fnBody = sql
          .split(new RegExp(`create or replace function ${rpc}`, "i"))[1]
          ?.split(/create or replace function/i)[0] ?? "";
        expect(fnBody).toMatch(/select 1 from tenant_users/i);
        expect(fnBody).toMatch(/user_id = auth\.uid\(\)/);
      });
    }

    it("trigger_team_discover validates providers whitelist + non-empty (codex C1)", () => {
      const fnBody = sql
        .split(/create or replace function trigger_team_discover/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/providers must be non-empty/);
      expect(fnBody).toMatch(/invalid provider in array/);
      expect(fnBody).toMatch(/<@ array\['github','slack','jira'\]/);
    });

    it("trigger_team_discover returns {job_id, created} so route can skip Inngest re-emit (codex C2)", () => {
      const fnBody = sql
        .split(/create or replace function trigger_team_discover/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/returns table \(job_id uuid, created boolean\)/i);
      expect(fnBody).toMatch(/return query select v_existing_id, false/);
      expect(fnBody).toMatch(/return query select v_new_id, true/);
    });

    it("list_team_members omits external_email from identity rows (codex C7)", () => {
      const fnBodyRaw = sql
        .split(/create or replace function list_team_members/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      const fnBody = fnBodyRaw
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      expect(fnBody).not.toMatch(/'external_email'/);
      expect(fnBody).not.toMatch(/i\.external_email/);
    });

    it("get_team_member_detail includes external_email (admin edit modal — codex C7)", () => {
      const fnBody = sql
        .split(/create or replace function get_team_member_detail/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/'external_email', i\.external_email/);
    });

    it("update_team_member normalizes email to lower+trim (codex C15)", () => {
      const fnBody = sql
        .split(/create or replace function update_team_member/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/lower\(trim\(p_primary_email\)\)/);
      expect(fnBody).toMatch(/nullif\(/);
    });

    it("update_team_member is update-only (renamed from upsert per codex C17)", () => {
      const fnBody = sql
        .split(/create or replace function update_team_member/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).not.toMatch(/insert into team_members/i);
      expect(fnBody).toMatch(/update team_members/i);
    });

    it("merge_team_members locks both rows + null-checks before mutation (codex C5)", () => {
      const fnBody = sql
        .split(/create or replace function merge_team_members/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      const lockCount = (fnBody.match(/for update/g) ?? []).length;
      expect(lockCount).toBeGreaterThanOrEqual(2);
      expect(fnBody).toMatch(/keep member not found or not active/);
      expect(fnBody).toMatch(/drop member not found or not active/);
    });

    it("merge_team_members rejects self-merge", () => {
      const fnBody = sql
        .split(/create or replace function merge_team_members/i)[1]
        ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/cannot merge member with itself/);
    });
  });

  describe("grants (matches existing tenant_commands / notification_settings pattern)", () => {
    const rpcSigs = [
      "list_team_members\\(\\)",
      "get_team_member_detail\\(uuid\\)",
      "trigger_team_discover\\(text\\[\\]\\)",
      "update_team_member\\(uuid, text, text, text\\)",
      "merge_team_members\\(uuid, uuid\\)",
    ];
    for (const sig of rpcSigs) {
      it(`revoke + grant pair present for ${sig.replace(/\\\\/g, "")}`, () => {
        expect(sql).toMatch(new RegExp(`revoke all on function ${sig} from public`));
        expect(sql).toMatch(new RegExp(`grant execute on function ${sig} to authenticated`));
      });
    }
  });
});
