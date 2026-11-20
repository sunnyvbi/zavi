import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260711030328_agent_run_steers_core.sql",
  ),
  "utf-8",
);

function fnBody(name: string): string {
  const re = new RegExp(
    `create or replace function ${name}[\\s\\S]*?\\$\\$;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

describe("20260711030328_agent_run_steers_core.sql", () => {
  it("creates the agent_run_steers table", () => {
    expect(sql).toMatch(/create table if not exists agent_run_steers/i);
  });

  it("origin is constrained to the 4 interactive surfaces", () => {
    for (const o of ["chat", "slack", "email", "teams"]) {
      expect(sql).toMatch(new RegExp(`'${o}'`));
    }
    expect(sql).toMatch(/origin\s+text not null check \(origin in/i);
  });

  it("status enum covers the richer lease state machine (codex P1)", () => {
    for (const s of [
      "pending",
      "leased",
      "injected",
      "drained",
      "rerouting",
      "rerouted",
      "dead",
    ]) {
      expect(sql).toMatch(new RegExp(`'${s}'`));
    }
    expect(sql).toMatch(/status\s+text not null default 'pending'/i);
  });

  it("binds every steer to its run's tenant via a COMPOSITE FK (defense in depth)", () => {
    expect(sql).toMatch(
      /alter table agent_runs\s+add constraint agent_runs_id_tenant_uq unique \(id, tenant_id\)/i,
    );
    expect(sql).toMatch(
      /foreign key \(run_id, tenant_id\) references agent_runs \(id, tenant_id\)/i,
    );
    expect(sql).not.toMatch(/run_id\s+uuid not null references agent_runs/i);
  });

  it("RLS: exactly one policy, SELECT-only, scoped to the THREAD OWNER (codex P2)", () => {
    expect(sql).toMatch(/alter table agent_run_steers enable row level security/i);
    const policies = sql.match(/create policy/gi) || [];
    expect(policies.length).toBe(1);
    const policyStmt = (sql.match(/create policy[\s\S]*?\);/i) || [""])[0];
    expect(policyStmt).toMatch(/for select to authenticated/i);
    expect(policyStmt).toMatch(
      /from public\.agent_threads t\s+where t\.id::text = agent_run_steers\.thread_id[\s\S]*t\.user_id = auth\.uid\(\)/i,
    );
    expect(policyStmt).not.toMatch(/tenant_users/i);
  });

  it("has the pending-poll hot-path partial index + per-run seq + idempotency uniqueness", () => {
    expect(sql).toMatch(
      /create index if not exists agent_run_steers_pending_idx[\s\S]*where status = 'pending'/i,
    );
    expect(sql).toMatch(
      /create unique index if not exists agent_run_steers_run_seq_uq\s+on agent_run_steers \(run_id, seq\)/i,
    );
    expect(sql).toMatch(
      /create unique index if not exists agent_run_steers_run_idem_uq[\s\S]*where idempotency_key is not null/i,
    );
  });

  describe("chat RPC — enqueue_or_steer_chat_turn (authenticated identity)", () => {
    const body = fnBody("enqueue_or_steer_chat_turn");

    it("is a search_path-pinned security definer trusting auth.uid()", () => {
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path = public/i);
      expect(body).toMatch(/v_uid\s+uuid := auth\.uid\(\)/i);
    });

    it("checks tenant membership INSIDE the definer", () => {
      expect(body).toMatch(
        /if not exists \([\s\S]*from public\.tenant_users tu[\s\S]*tu\.user_id = v_uid[\s\S]*raise exception/i,
      );
    });

    it("resolves the feature flag INSIDE the definer, NOT from a client argument (codex P2)", () => {
      expect(body).not.toMatch(/p_barge_in_enabled/i);
      expect(body).toMatch(
        /blob->>'agent_barge_in_enabled'[\s\S]*from public\.system_config where id = 1/i,
      );
      expect(body).toMatch(/'new_turn'[\s\S]*'flag_off'/i);
    });

    it("enforces THREAD OWNERSHIP — a member cannot steer another member's thread (codex P1)", () => {
      expect(body).toMatch(
        /from public\.agent_threads t\s+where t\.id::text = p_thread_id[\s\S]*t\.user_id = v_uid[\s\S]*'not_thread_owner'/i,
      );
    });

    it("is an ATOMIC decide-before-insert (locks the running run, then decides)", () => {
      expect(body).toMatch(/status = 'running'[\s\S]*for update;/i);
      expect(body).toMatch(/'action', 'new_turn'/);
      expect(body).toMatch(/'action', 'steered'/);
    });

    it("is EXECUTE-able by authenticated, revoked from public/anon", () => {
      expect(sql).toMatch(
        /grant execute on function enqueue_or_steer_chat_turn\(uuid, text, text, text, text\)[\s\S]*to authenticated, service_role/i,
      );
      expect(sql).toMatch(
        /revoke all on function enqueue_or_steer_chat_turn\(uuid, text, text, text, text\)[\s\S]*from public, anon/i,
      );
    });
  });

  describe("webhook RPC — enqueue_agent_run_steer (service_role only)", () => {
    const body = fnBody("enqueue_agent_run_steer");

    it("rejects non-webhook origins and requires the run be RUNNING", () => {
      expect(body).toMatch(
        /if p_origin not in \('slack','email','teams'\) then[\s\S]*raise exception/i,
      );
      expect(body).toMatch(/v_status <> 'running'/i);
      expect(body).toMatch(/'action', 'not_running'/);
    });

    it("does NOT re-match on the chat-shaped payload->>'thread_id' (codex P2)", () => {
      expect(body).not.toMatch(/payload->>'thread_id' = p_thread_id/i);
      expect(body).toMatch(/where\s+id = p_run_id\s+and tenant_id = p_tenant_id\s+for update;/i);
    });

    it("validates a provided author is a tenant member (server-vouched identity)", () => {
      expect(body).toMatch(
        /p_author_user_id is not null and not exists[\s\S]*raise exception/i,
      );
    });

    it("is service_role ONLY (auth.uid() is absent under service_role)", () => {
      expect(sql).toMatch(
        /revoke all on function enqueue_agent_run_steer[\s\S]*from public, anon, authenticated/i,
      );
      expect(sql).toMatch(
        /grant execute on function enqueue_agent_run_steer[\s\S]*to service_role/i,
      );
      expect(sql).not.toMatch(
        /grant execute on function enqueue_agent_run_steer[\s\S]*to authenticated/i,
      );
    });
  });

  it("both RPCs cap body length", () => {
    expect((sql.match(/length\(p_body\) > 8000/g) || []).length).toBe(2);
  });

  describe("definer hardening — pg_temp shadowing (codex P0)", () => {
    it("pins pg_temp LAST in search_path on BOTH definers", () => {
      expect((sql.match(/set search_path = public, pg_temp/g) || []).length).toBe(2);
      expect(sql).not.toMatch(/set search_path = public\s*$/im);
    });

    it("schema-qualifies EVERY relation reference inside both definer bodies", () => {
      for (const name of ["enqueue_or_steer_chat_turn", "enqueue_agent_run_steer"]) {
        const body = fnBody(name);
        for (const rel of [
          "tenant_users",
          "system_config",
          "agent_runs",
          "agent_run_steers",
        ]) {
          const unqualified = new RegExp(
            `(from|join|insert into)\\s+(?!public\\.)${rel}\\b`,
            "i",
          );
          expect(body).not.toMatch(unqualified);
        }
      }
      expect(fnBody("enqueue_or_steer_chat_turn")).not.toMatch(
        /(from|join)\s+(?!public\.)agent_threads\b/i,
      );
    });
  });

  it("NEITHER RPC uses SKIP LOCKED for the decision lock (codex P1)", () => {
    expect(sql).not.toMatch(/for update\s+skip locked/i);
    expect((sql.match(/for update;/g) || []).length).toBe(2);
  });

  it("BOTH RPCs honour the kill switch — the inert claim holds on every write surface (codex P1)", () => {
    const flagReads =
      sql.match(
        /blob->>'agent_barge_in_enabled'\)::boolean from public\.system_config where id = 1/g,
      ) || [];
    expect(flagReads.length).toBe(2);
    expect(fnBody("enqueue_agent_run_steer")).toMatch(/'reason', 'flag_off'/);
    expect(fnBody("enqueue_or_steer_chat_turn")).toMatch(/'reason', 'flag_off'/);
  });
});
