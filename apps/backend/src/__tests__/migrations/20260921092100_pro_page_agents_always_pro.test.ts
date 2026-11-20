import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260921092100_pro_page_agents_always_pro.sql"),
  "utf-8",
);

describe("pro-page always-Pro gate (20260921092100)", () => {
  it("the Build exemption requires the conductor's own a2a trigger", () => {
    expect(SQL).toMatch(/p_slug = 'engineer'\s+and p_trigger = 'a2a'/);
  });

  it("both credit triggers pass NEW.trigger into the exemption", () => {
    const calls = SQL.match(/_is_live_build_stage\(NEW\.tenant_id, NEW\.agent_slug, NEW\.payload, NEW\.trigger\)/g);
    expect(calls?.length).toBe(2);
    expect(SQL).not.toMatch(/_is_live_build_stage\(NEW\.tenant_id, NEW\.agent_slug, NEW\.payload\)/);
  });

  it("drops the 3-arg signature so the old, trigger-blind form is not callable", () => {
    expect(SQL).toMatch(/drop function if exists _is_live_build_stage\(uuid, text, jsonb\);/);
  });

  it("revokes execute on the exemption helper from every non-service role", () => {
    expect(SQL).toMatch(
      /revoke all on function _is_live_build_stage\(uuid, text, jsonb, text\) from public, anon, authenticated/,
    );
    expect(SQL).toMatch(/grant execute on function _is_live_build_stage\(uuid, text, jsonb, text\) to service_role/);
  });

  it("only engineer is exempt from the always-Pro rule", () => {
    const fn = SQL.slice(SQL.indexOf("function _is_live_build_stage"));
    const body = fn.slice(0, fn.indexOf("$$;") + 3);
    expect(body).toMatch(/p_slug = 'engineer'/);
    expect(body).not.toMatch(/fundraising|supply-demand-balancer/);
  });
});
