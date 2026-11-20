import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260528072757_agent_run_checkpoints.sql",
  ),
  "utf-8",
);

describe("20260528072757_agent_run_checkpoints.sql", () => {
  it("creates both substrate tables", () => {
    expect(sql).toMatch(/create table if not exists agent_run_checkpoints/i);
    expect(sql).toMatch(/create table if not exists agent_tool_effects/i);
  });

  it("FK ON DELETE CASCADE from agent_runs on both tables (PII purge)", () => {
    const cascades = sql.match(
      /references agent_runs\(id\) on delete cascade/gi,
    );
    expect(cascades).not.toBeNull();
    expect(cascades!.length).toBe(2);
  });

  it("checkpoint has a UNIQUE (run_id, iter) — defensive upsert target", () => {
    expect(sql).toMatch(
      /unique index if not exists agent_run_checkpoints_run_iter_uq\s+on agent_run_checkpoints \(run_id, iter\)/i,
    );
  });

  it("tool-effects ledger is keyed UNIQUE (run_id, tool_use_id) — resume-by-replay", () => {
    expect(sql).toMatch(/tool_use_id\s+text not null/i);
    expect(sql).toMatch(
      /unique index if not exists agent_tool_effects_key_uq\s+on agent_tool_effects \(run_id, tool_use_id\)/i,
    );
  });

  it("tool-effects status is a two-phase CHECK (pending|committed)", () => {
    expect(sql).toMatch(
      /status\s+text not null default 'pending'\s*\n?\s*check \(status in \('pending', 'committed'\)\)/i,
    );
  });

  it("RLS enabled + denies authenticated (server-only PII posture)", () => {
    expect(sql).toMatch(
      /alter table agent_run_checkpoints enable row level security/i,
    );
    expect(sql).toMatch(
      /alter table agent_tool_effects\s+enable row level security/i,
    );
    expect(sql).toMatch(/revoke all on agent_run_checkpoints from anon, authenticated/i);
    expect(sql).toMatch(/revoke all on agent_tool_effects\s+from anon, authenticated/i);
    expect(sql).not.toMatch(/create policy.*on agent_run_checkpoints/i);
    expect(sql).not.toMatch(/create policy.*on agent_tool_effects/i);
  });

  it("is net-new only — no CREATE OR REPLACE FUNCTION (DB-fn-rebuild-gate exempt)", () => {
    const ddl = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).not.toMatch(/create or replace function/i);
  });
});
