import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

const MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "20260518000001_tenant_members.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf-8");

function fnBodyOf(name: string): string {
  const re = new RegExp(`create or replace function ${name}\\b`, "i");
  const parts = sql.split(re);
  if (parts.length < 2) return "";
  return parts[1].split(/create or replace function/i)[0] ?? "";
}

describe(
  "20260518000001_tenant_members.sql — static SQL guardrails",
  () => {
    describe("tenant_users role + owner invariant", () => {
      it("backfills any non-owner rows to 'owner' before adding the check", () => {
        expect(sql).toMatch(
          /update tenant_users\s+set role = 'owner'\s+where role is null or role not in \('owner','admin','member'\)/i,
        );
      });

      it("adds role check constraint covering owner|admin|member", () => {
        expect(sql).toMatch(/tenant_users_role_check/i);
        expect(sql).toMatch(/role in \('owner','admin','member'\)/i);
      });

      it("adds tenant_users_one_owner_per_tenant partial unique index (C5)", () => {
        expect(sql).toMatch(/tenant_users_one_owner_per_tenant/i);
        expect(sql).toMatch(
          /on tenant_users \(tenant_id\)\s*where role = 'owner'/i,
        );
      });

      it("patches activate_tenant to reject existing slug for non-members (C5)", () => {
        expect(sql).toMatch(/create or replace function activate_tenant\b/i);
        const body = fnBodyOf("activate_tenant");
        expect(body).toMatch(/tenant_slug_already_taken|42501/i);
      });
    });

    describe("tenant_member_invites table", () => {
      it("declares the expected columns + role-check (admin|member, owner blocked)", () => {
        expect(sql).toMatch(/create table if not exists tenant_member_invites/i);
        expect(sql).toMatch(
          /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(/email\s+text not null/i);
        expect(sql).toMatch(/role\s+text not null check \(role in \('admin','member'\)\)/i);
        expect(sql).toMatch(/invited_by\s+uuid not null references auth\.users\(id\)/i);
        expect(sql).toMatch(/accepted_at\s+timestamptz/i);
        expect(sql).toMatch(/accepted_user_id\s+uuid references auth\.users\(id\)/i);
        expect(sql).toMatch(/revoked_at\s+timestamptz/i);
        expect(sql).toMatch(/agent_slugs\s+text\[\] not null default/i);
      });

      it("has partial unique index on (tenant_id, lower(email)) WHERE open (F2 + C8)", () => {
        expect(sql).toMatch(/tenant_member_invites_open_email_unique/i);
        expect(sql).toMatch(/lower\(email\)/i);
        expect(sql).toMatch(
          /where accepted_at is null and revoked_at is null/i,
        );
      });

      it("RLS enabled + only owner/admin-select policy (writes via RPC only)", () => {
        expect(sql).toMatch(
          /alter table tenant_member_invites enable row level security/i,
        );
        expect(sql).toMatch(/create policy invites_select on tenant_member_invites/i);
        expect(sql).not.toMatch(
          /create policy [^;]+ for (insert|update|delete) on tenant_member_invites/i,
        );
      });
    });

    describe("tenant_member_agents table", () => {
      it("declares the composite-PK access list", () => {
        expect(sql).toMatch(/create table if not exists tenant_member_agents/i);
        expect(sql).toMatch(
          /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(
          /user_id\s+uuid not null references auth\.users\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(/agent_slug\s+text not null/i);
        expect(sql).toMatch(/primary key \(tenant_id, user_id, agent_slug\)/i);
      });

      it("RLS enabled + only member_agents_select policy", () => {
        expect(sql).toMatch(
          /alter table tenant_member_agents\s+enable row level security/i,
        );
        expect(sql).toMatch(
          /create policy member_agents_select on tenant_member_agents/i,
        );
        expect(sql).not.toMatch(
          /create policy [^;]+ for (insert|update|delete) on tenant_member_agents/i,
        );
      });
    });

    describe("tenant_seat_limits + tenants.tier", () => {
      it("creates tenant_seat_limits table with the seeded tiers", () => {
        expect(sql).toMatch(/create table if not exists tenant_seat_limits/i);
        expect(sql).toMatch(/tier\s+text primary key/i);
        expect(sql).toMatch(/max_seats\s+int not null/i);
        expect(sql).toMatch(/insert into tenant_seat_limits/i);
        expect(sql).toMatch(/'pilot'[^;]*3/i);
        expect(sql).toMatch(/'operator'[^;]*10/i);
        expect(sql).toMatch(/'scale'[^;]*-1/i);
      });

      it("adds tenants.tier column with default 'pilot' + check constraint", () => {
        expect(sql).toMatch(/alter table tenants/i);
        expect(sql).toMatch(/add column tier text not null default 'pilot'/i);
        expect(sql).toMatch(
          /check \(tier in \('pilot','operator','scale'\)\)/i,
        );
      });
    });

    describe("agent_runs / agent_run_events / decisions RLS rewrite (F1 + C6 + C10)", () => {
      it("drops the OLD agent_runs_member_select by its real name (C6)", () => {
        expect(sql).toMatch(
          /drop policy if exists agent_runs_member_select on agent_runs/i,
        );
      });

      it("new agent_runs SELECT uses enqueued_by NULL-or-self branch (F1)", () => {
        expect(sql).toMatch(
          /create policy agent_runs_member_select on agent_runs for select/i,
        );
        expect(sql).toMatch(
          /agent_runs\.enqueued_by is null\s*or\s*agent_runs\.enqueued_by = auth\.uid\(\)/i,
        );
      });

      it("new agent_runs SELECT joins tenant_member_agents for member allowlist", () => {
        expect(sql).toMatch(/tenant_member_agents/i);
        expect(sql).toMatch(/tu\.role in \('owner','admin'\)/i);
      });

      it("drops + recreates agent_run_events_member_select", () => {
        expect(sql).toMatch(
          /drop policy if exists agent_run_events_member_select on agent_run_events/i,
        );
        expect(sql).toMatch(
          /create policy agent_run_events_member_select on agent_run_events for select/i,
        );
      });

      it("drops + recreates decisions_member_select using agent_runs join (C10)", () => {
        expect(sql).toMatch(
          /drop policy if exists decisions_member_select on decisions/i,
        );
        expect(sql).toMatch(
          /create policy decisions_member_select on decisions for select/i,
        );
        expect(sql).toMatch(/decisions\.agent_run_id/i);
      });
    });

    describe("tenant_users SELECT policy (members list visibility)", () => {
      it("adds tenant_users_select_members SELECT policy", () => {
        expect(sql).toMatch(
          /create policy tenant_users_select_members on tenant_users for select/i,
        );
      });
    });

    describe("_assert_tenant_admin helper (F4) + memory-write RPC swaps", () => {
      it("defines _assert_tenant_admin(p_tenant_id uuid)", () => {
        expect(sql).toMatch(
          /create or replace function _assert_tenant_admin\(p_tenant_id uuid\)/i,
        );
        expect(sql).toMatch(/raise exception .* using errcode = '42501'/i);
      });

      const memoryWriteRpcs = [
        "memory_note_upsert",
        "memory_note_delete",
        "memory_entity_upsert",
        "memory_relation_upsert",
      ];
      for (const rpc of memoryWriteRpcs) {
        it(`${rpc} now calls _assert_tenant_admin (Brain write-gate, F4)`, () => {
          const body = fnBodyOf(rpc);
          expect(body).not.toBe("");
          expect(body).toMatch(/_assert_tenant_admin\(/i);
        });
      }
    });

    describe("chat-run path allowlist (C2)", () => {
      it("patches send_agent_chat_turn with the allowlist check", () => {
        const body = fnBodyOf("send_agent_chat_turn");
        expect(body).not.toBe("");
        expect(body).toMatch(/tenant_member_agents/i);
        expect(body).toMatch(/agent_slug/i);
        expect(body).toMatch(/42501/);
      });

      it("patches send_agent_chat_turn_v2 with the allowlist check", () => {
        const body = fnBodyOf("send_agent_chat_turn_v2");
        expect(body).not.toBe("");
        expect(body).toMatch(/tenant_member_agents/i);
        expect(body).toMatch(/42501/);
      });
    });

    describe("seven new RPCs — shape + membership re-derivation (Codex C8)", () => {
      const rpcs = [
        "invite_member",
        "accept_invite",
        "set_member_agents",
        "promote_member_to_admin",
        "demote_admin_to_member",
        "revoke_member",
        "revoke_invite",
      ];

      for (const rpc of rpcs) {
        it(`${rpc} is security-definer with pinned search_path`, () => {
          const re = new RegExp(
            `create or replace function ${rpc}[\\s\\S]{0,800}security definer set search_path = public`,
            "i",
          );
          expect(sql, `${rpc} declaration`).toMatch(re);
        });

        it(`${rpc} re-derives tenant_id from tenant_users + auth.uid() (Codex C8)`, () => {
          const body = fnBodyOf(rpc);
          expect(body).not.toBe("");
          expect(body).toMatch(
            /from tenant_users|_assert_tenant_admin\(|from tenant_member_invites/i,
          );
          expect(body).toMatch(/auth\.uid\(\)/i);
        });
      }

      it("invite_member checks role in ('owner','admin')", () => {
        const body = fnBodyOf("invite_member");
        expect(body).toMatch(
          /role in \('owner','admin'\)|_assert_tenant_admin\(/i,
        );
      });

      it("invite_member normalizes email to lowercase (F2)", () => {
        const body = fnBodyOf("invite_member");
        expect(body).toMatch(/lower\(/i);
      });

      it("invite_member uses tenant_seat_limits joined on tenants.tier for cap check", () => {
        const body = fnBodyOf("invite_member");
        expect(body).toMatch(/tenant_seat_limits/i);
        expect(body).toMatch(/tier/i);
      });

      it("revoke_member rejects target.role = 'owner'", () => {
        const body = fnBodyOf("revoke_member");
        expect(body).toMatch(/owner/i);
        expect(body).toMatch(/raise exception/i);
      });

      it("promote_member_to_admin requires caller role = 'owner' (admin promotions are owner-only)", () => {
        const body = fnBodyOf("promote_member_to_admin");
        expect(body).toMatch(/owner/i);
        expect(body).toMatch(/raise exception|42501/i);
      });

      it("revoke_invite verifies the invite's tenant matches the caller's active tenant (F3 cross-tenant defense)", () => {
        const body = fnBodyOf("revoke_invite");
        expect(body).toMatch(/tenant_id/i);
        expect(body).toMatch(/tenant_member_invites/i);
      });

      it("accept_invite requires the invite to be open (not accepted, not revoked)", () => {
        const body = fnBodyOf("accept_invite");
        expect(body).toMatch(/accepted_at|revoked_at/i);
        expect(body).toMatch(/42501|raise exception/i);
      });
    });

    describe("RPC grants (revoke public + grant authenticated)", () => {
      const rpcs = [
        "invite_member",
        "accept_invite",
        "set_member_agents",
        "promote_member_to_admin",
        "demote_admin_to_member",
        "revoke_member",
        "revoke_invite",
      ];
      for (const rpc of rpcs) {
        it(`${rpc} has revoke-public + grant-authenticated`, () => {
          expect(sql).toMatch(new RegExp(`revoke all on function ${rpc}\\(`, "i"));
          expect(sql).toMatch(
            new RegExp(`grant execute on function ${rpc}\\(.*to authenticated`, "i"),
          );
        });
      }
    });
  },
);

