
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migDir = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const sql = readFileSync(join(migDir, "20260926210000_workspace_role_ladder.sql"), "utf8");
const source = readFileSync(join(migDir, "20260926120000_custom_agents.sql"), "utf8");

const nthBody = (src: string, head: string, n: number): string => {
  const re = new RegExp(`create or replace function (?:public\\.)?${head.replace(/[()]/g, "\\$&")}`, "gi");
  const starts = [...src.matchAll(re)].map((m) => m.index!);
  const i = starts[n];
  expect(i, `${head} #${n}`).toBeDefined();
  const endA = src.indexOf("end $$;", i);
  const endB = src.indexOf("end $function$", i);
  const end = [endA, endB].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  return src.slice(i, end);
};

const chatFns: Array<[string, number]> = [
  ["send_agent_chat_turn(", 0],
  ["send_agent_chat_turn_v2(", 0],
  ["send_agent_chat_turn_v3(", 0],
  ["send_agent_chat_turn_v3(", 1],
  ["submit_clarification_response(", 0],
];

const OLD_GATE =
  /tenant_member_agents|member allowlist|member-allowlist|_custom_agent_member_allowed|v_role = 'member'|custom agents \(decision 18\)|^\s*where tenant_id = v_tenant_id( and user_id = v_user_id and agent_slug = v_slug)?$|^\s*and (user_id = v_user_id|agent_slug = (p_agent_slug|v_slug))$/;
const NEW_GATE =
  /^\s*-- Role ladder \(2026-09-25\)|^\s*if v_role = 'viewer' then$|^\s*raise exception 'viewer role is read-only' using errcode = '42501';$|^\s*end if;$|^\s*-- 2\. Role gate \(viewer is read-only\)/;

describe("20260926210000_workspace_role_ladder.sql", () => {
  it.each(chatFns)("%s (#%i) equals its custom_agents body except the role gate", (head, n) => {
    const prior = nthBody(source, head, n).split("\n");
    const next = nthBody(sql, head, n).split("\n");
    const added = next.filter((l) => !prior.includes(l));
    const removed = prior.filter((l) => !next.includes(l));
    for (const l of added) expect(l, "added line").toMatch(NEW_GATE);
    for (const l of removed) expect(l, "removed line").toMatch(OLD_GATE);
    expect(next.join("\n")).toContain("if v_role = 'viewer' then");
    expect(next.join("\n")).not.toContain("tenant_member_agents");
    expect(next.join("\n")).toMatch(/raise exception 'not a member of tenant'/);
  });

  it("allows 'viewer' in both role check constraints", () => {
    expect(sql).toMatch(/tenant_users_role_check\s+check \(role in \('owner','admin','member','viewer'\)\)/);
    expect(sql).toMatch(/tenant_member_invites_role_check\s+check \(role in \('admin','member','viewer'\)\)/);
  });

  it("run / event / decision SELECT policies no longer read the allowlist", () => {
    for (const pol of ["agent_runs_member_select", "agent_run_events_member_select", "decisions_member_select"]) {
      const at = sql.indexOf(`create policy ${pol}`);
      expect(at, pol).toBeGreaterThan(-1);
      const body = sql.slice(at, sql.indexOf(");\n", at));
      expect(body).toContain("tu.user_id = auth.uid()");
      expect(body).not.toContain("tenant_member_agents");
    }
  });

  it("every browser-callable write it re-creates refuses a viewer", () => {
    for (const fn of ["add_agent_note(", "add_agent_rule(", "_custom_agent_authorize("]) {
      const body = nthBody(sql, fn, 0);
      expect(body, fn).toMatch(/role = 'viewer'/);
      expect(body, fn).toContain("viewer role is read-only");
    }
    expect(nthBody(sql, "set_member_role(", 0)).toContain("only owner can change roles");
  });

  it("the email 'may this sender ask' gate excludes viewers", () => {
    const at = sql.indexOf("create or replace function is_tenant_member_email");
    expect(sql.slice(at, sql.indexOf("$$;", at))).toContain("tu.role <> 'viewer'");
  });

  it("backstops every table the membership-only RPCs write with the viewer trigger", () => {
    expect(sql).toMatch(/create or replace function _refuse_viewer_write\(\)/);
    expect(sql).toMatch(/if v_uid is null then\s+return coalesce\(new, old\);/);
    for (const t of [
      "agent_runs", "agent_threads", "agent_thread_messages", "agent_run_steers",
      "agent_work_items", "tenant_decision_class_overrides", "tenant_agent_schedules",
      "autopilot_goals", "agent_email_recipients", "agent_feedback",
      "agent_clarification_responses", "tenant_build_credits", "tenant_ad_snapshots",
    ]) {
      expect(sql, t).toContain(`'${t}'`);
    }
    expect(sql).toMatch(/before insert or update or delete on public\.%I/);
  });
});
