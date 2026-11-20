import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  resolve(__dirname, "../../../../../supabase/migrations/20261031160000_slack_identity_link_on_use.sql"),
  "utf8",
).toLowerCase();

describe("20261031160000_slack_identity_link_on_use.sql", () => {
  it("grants the link RPCs and the team-aware resolver to service_role only", () => {
    for (const sig of [
      "link_slack_identity_if_member(uuid, text, text, text, text)",
      "link_slack_installer_identity(uuid, text, text, uuid, text, text)",
      "resolve_slack_approver(uuid, text, text)",
    ]) {
      expect(SQL).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(SQL).not.toMatch(/grant execute on function public\.\S*\s+to\s+(anon|authenticated)/);
  });

  it("the internal helpers are granted to nobody", () => {
    expect(SQL).not.toMatch(/grant execute on function public\._link_slack_identity/);
    expect(SQL).not.toMatch(/grant execute on function public\._slack_tenant_login_by_email/);
    expect(SQL).not.toMatch(/grant execute on function public\._slack_approver_login/);
  });

  it("an existing identity is never re-pointed: insert-or-nothing, then accept only the expected member", () => {
    expect(SQL).toContain("on conflict (tenant_id, provider, (coalesce(team_id, '')), external_id) do nothing");
    expect(SQL).not.toMatch(/update\s+team_member_identities/);
    expect(SQL).toContain("if v_linked is distinct from v_member then");
  });

  it("rule_propose resolves a Slack author with the run's team_id", () => {
    expect(SQL).toContain(
      "resolve_slack_approver(p_tenant_id, v_run.payload -> 'slack' ->> 'team_id', v_run.payload -> 'slack' ->> 'user')",
    );
  });
});
