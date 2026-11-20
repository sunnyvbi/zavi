
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scopeKind } from "@/services/tenant-client";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260901010000_bench_identity_and_engagement_plane.sql",
  ),
  "utf-8",
);

const GLOBAL_TABLES = ["bench_members", "bench_member_handles", "bench_member_pii"] as const;
const GLOBAL_TABLES_LIVE = ["human_members", "human_member_handles", "human_member_pii"] as const;
const TENANT_TABLES = ["brief_applications", "engagements", "engagement_messages"] as const;

describe("20260901010000_bench_identity_and_engagement_plane.sql — global identity plane", () => {
  it("creates all three identity tables idempotently", () => {
    for (const t of GLOBAL_TABLES) {
      expect(sql, t).toMatch(new RegExp(`create table if not exists ${t} \\(`, "i"));
    }
  });

  it("enables RLS on every global table", () => {
    for (const t of GLOBAL_TABLES) {
      expect(sql, t).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
    }
  });

  it("creates ZERO policies on the global tables (default-deny, the staff_users pattern)", () => {
    for (const t of GLOBAL_TABLES) {
      expect(sql, `${t} must have no policy`).not.toMatch(
        new RegExp(`create policy [a-z_]+ on ${t}\\b`, "i"),
      );
    }
  });

  it("never grants the global tables to anon or authenticated", () => {
    for (const t of GLOBAL_TABLES) {
      expect(sql, t).not.toMatch(new RegExp(`grant [a-z, ]+ on ${t} to (anon|authenticated)`, "i"));
    }
  });

  it("carries NO tenant_id column on the identity plane (a person is not a tenant's row)", () => {
    const identityBlock = sql.slice(
      sql.indexOf("create table if not exists bench_members ("),
      sql.indexOf("create table if not exists brief_applications ("),
    );
    expect(identityBlock.length).toBeGreaterThan(0);
    const columnLines = identityBlock
      .split("\n")
      .filter((l) => /^\s{2,}[a-z_]+\s+(uuid|text|jsonb|timestamptz|numeric|bytea|text\[\])/i.test(l));
    expect(columnLines.length).toBeGreaterThan(10);
    expect(columnLines.join("\n")).not.toMatch(/\btenant_id\b/i);
  });

  it("one bench member per auth user, cascading on user delete", () => {
    expect(sql).toMatch(/auth_user_id\s+uuid not null unique references auth\.users\(id\) on delete cascade/i);
  });

  it("is discipline-agnostic (R4) with only ugc_creator openable in Phase 1", () => {
    expect(sql).toMatch(
      /check \(discipline in \('ugc_creator', 'engineer', 'designer', 'support'\)\)/i,
    );
    expect(sql).toMatch(/rate_unit in \('per_deliverable', 'per_hour', 'per_month'\)/i);
    expect(sql).toMatch(/profile\s+jsonb not null default '\{\}'::jsonb/i);
  });

  it("detects duplicate handles case-insensitively", () => {
    expect(sql).toMatch(
      /create unique index if not exists bench_member_handles_platform_handle_key\s+on bench_member_handles \(platform, lower\(handle\)\)/i,
    );
  });

  it("uniques PII on lower(email) and partially on the two hashes", () => {
    expect(sql).toMatch(
      /create unique index if not exists bench_member_pii_email_key\s+on bench_member_pii \(lower\(email\)\)/i,
    );
    expect(sql).toMatch(
      /create unique index if not exists bench_member_pii_tin_key\s+on bench_member_pii \(tin_sha256\) where tin_sha256 is not null/i,
    );
    expect(sql).toMatch(
      /create unique index if not exists bench_member_pii_payout_ref_key\s+on bench_member_pii \(payout_ref_hash\) where payout_ref_hash is not null/i,
    );
  });

  it("stores hashes only — no raw TIN, bank, or payout column anywhere", () => {
    expect(sql).toMatch(/tin_sha256\s+bytea/i);
    expect(sql).toMatch(/payout_ref_hash\s+bytea/i);
    for (const forbidden of [
      /\bstripe_[a-z_]*\s+(text|uuid|numeric|jsonb)/i,
      /\bpayout_(amount|status|at|account)\b/i,
      /\b(bank_account|routing_number|iban|account_number)\b/i,
      /\btax_id\b/i,
      /\bw9\b/i,
    ]) {
      expect(sql, `Phase 1 has no payout rail: ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("20260901010000 — tenant engagement plane", () => {
  it("enables RLS on every tenant table", () => {
    for (const t of TENANT_TABLES) {
      expect(sql, t).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
    }
  });

  it("gates every tenant policy on tenant_users membership (verbatim competitor_profiles shape)", () => {
    for (const t of TENANT_TABLES) {
      expect(sql, t).toMatch(
        new RegExp(
          `create policy ${t}_member_select on ${t}\\s+for select using \\(\\s*exists \\(\\s*select 1 from tenant_users tu\\s+where tu\\.tenant_id = ${t}\\.tenant_id\\s+and tu\\.user_id = auth\\.uid\\(\\)`,
          "i",
        ),
      );
    }
  });

  it("drops each policy before creating it (idempotent re-apply)", () => {
    for (const t of TENANT_TABLES) {
      expect(sql, t).toMatch(new RegExp(`drop policy if exists ${t}_member_select on ${t};`, "i"));
    }
  });

  it("revokes writes from anon+authenticated and grants only select", () => {
    for (const t of TENANT_TABLES) {
      expect(sql, t).toMatch(
        new RegExp(`revoke insert, update, delete on ${t}\\s+from anon, authenticated;`, "i"),
      );
      expect(sql, t).toMatch(new RegExp(`grant select on ${t}\\s+to authenticated;`, "i"));
    }
  });

  it("every tenant table FKs tenant_id to tenants with cascade", () => {
    const cascades = sql.match(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/gi) ?? [];
    expect(cascades.length).toBe(TENANT_TABLES.length);
  });

  it("keys applications + engagements POLYMORPHICALLY, not by FK to creator_briefs", () => {
    const polymorphic = sql.match(
      /brief_kind\s+text not null default 'creative' check \(brief_kind in \('creative'\)\)/gi,
    );
    expect(polymorphic?.length).toBe(2);
    expect(sql).not.toMatch(/brief_id\s+uuid[^,]*references creator_briefs/i);
    expect(sql).toMatch(/brief_id\s+uuid not null,/i);
  });

  it("enforces one application per member per brief, tenant-first", () => {
    expect(sql).toMatch(/unique \(tenant_id, brief_kind, brief_id, bench_member_id\)/i);
  });

  it("pins the receipt seam: engagements.utm_campaign is NOT NULL", () => {
    expect(sql).toMatch(/utm_campaign\s+text not null check \(length\(btrim\(utm_campaign\)\) between 1 and 64\)/i);
  });

  it("opens the thread at APPLICATION, not at engagement (R3)", () => {
    expect(sql).toMatch(
      /application_id\s+uuid not null references brief_applications\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/sender_kind\s+text not null check \(sender_kind in \('tenant', 'bench_member'\)\)/i);
  });

  it("indexes only the query shapes that exist", () => {
    expect(sql).toMatch(/brief_applications_tenant_status_idx\s+on brief_applications \(tenant_id, status, created_at desc\)/i);
    expect(sql).toMatch(/engagements_tenant_status_idx\s+on engagements \(tenant_id, status, created_at desc\)/i);
    expect(sql).toMatch(/engagement_messages_application_idx\s+on engagement_messages \(application_id, created_at\)/i);
    expect(sql).toMatch(/bench_member_handles_member_idx\s+on bench_member_handles \(bench_member_id\)/i);
  });
});

describe("20260901010000 — tenant-client REGISTRY classification", () => {
  it("classifies the identity plane as global (globalClient() asserts this)", () => {
    for (const t of GLOBAL_TABLES_LIVE) {
      expect(scopeKind(t), t).toBe("global");
    }
  });

  it("classifies the engagement plane as tenant_id (tenantClient() scopes on this)", () => {
    for (const t of TENANT_TABLES) {
      expect(scopeKind(t), t).toBe("tenant_id");
    }
  });
});

describe("20260901010000 — migration hygiene", () => {
  it("is wrapped in a single transaction", () => {
    expect(sql.trimStart()).toMatch(/^--/);
    expect((sql.match(/^begin;$/gim) ?? []).length).toBe(1);
    expect((sql.match(/^commit;$/gim) ?? []).length).toBe(1);
  });

  it("is idempotent: every create is guarded", () => {
    const creates = sql.match(/^create (table|index|unique index)\b.*/gim) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const line of creates) {
      expect(line, line).toMatch(/if not exists/i);
    }
  });

  it("does NOT touch creator_briefs (shipped PR #2236)", () => {
    expect(sql).not.toMatch(/alter table creator_briefs/i);
    expect(sql).not.toMatch(/drop table[^\n]*creator_briefs/i);
    expect(sql).not.toMatch(/alter table [a-z_]+ rename/i);
  });
});
