import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260606114013_decision_revision_requests.sql"),
  "utf8",
);

describe("20260606114013_decision_revision_requests", () => {
  it("creates the durable revision request table", () => {
    expect(sql).toMatch(/create table if not exists decision_revision_requests/i);
    expect(sql).toMatch(/decision_id uuid not null references decisions\(id\)/i);
    expect(sql).toMatch(/agent_run_id uuid null references agent_runs\(id\)/i);
    expect(sql).toMatch(/replacement_decision_id uuid null references decisions\(id\)/i);
    expect(sql).toMatch(/original_decision_class text not null/i);
    expect(sql).toMatch(/original_body jsonb not null default '\{\}'::jsonb/i);
  });

  it("enforces one active revision per decision", () => {
    expect(sql).toMatch(/create unique index if not exists decision_revision_requests_one_active_idx/i);
    expect(sql).toMatch(/where status in \('requested','running'\)/i);
    expect(sql).toMatch(/create index if not exists decision_revision_requests_run_idx/i);
  });

  it("enables member-scoped reads but blocks direct authenticated writes", () => {
    expect(sql).toMatch(/alter table decision_revision_requests enable row level security/i);
    expect(sql).toMatch(/create policy decision_revision_requests_member_select/i);
    expect(sql).toMatch(/revoke insert, update, delete on decision_revision_requests from authenticated/i);
    expect(sql).toMatch(/grant select on decision_revision_requests to authenticated/i);
  });
});
