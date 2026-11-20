import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runnerSrc = readFileSync(
  join(__dirname, "../../services/agents/runner.ts"),
  "utf-8",
);
const killSwitchSrc = readFileSync(
  join(__dirname, "../../services/agents/kill-switch.ts"),
  "utf-8",
);
const ensureRunnableSrc = readFileSync(
  join(__dirname, "../../services/agents/ensure-runnable.ts"),
  "utf-8",
);
const killSwitchMigration = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0047_tenant_agent_kill_switch.sql"),
  "utf-8",
);
const dispatchSrc = readFileSync(
  join(__dirname, "../../../workers/functions/dispatch-decision.ts"),
  "utf-8",
);
const killCheckFixMigration = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260619050802_killcheck_override_state_visible_optin.sql",
  ),
  "utf-8",
);

describe("runner — kill switch enqueue gate", () => {
  it("calls ensureAgentRunnable (which resolves the kill/visibility gate) before enqueueing", () => {
    expect(runnerSrc).toMatch(
      /await ensureAgentRunnable\(input\.tenant_id, input\.agent_slug,/,
    );
    expect(ensureRunnableSrc).toMatch(/getEffectiveVisibility\(tenant_id, slug\)/);
  });

  it("throws SafetyGateError when killed (or any runtime-gate reason)", () => {
    expect(runnerSrc).toMatch(
      /if \(!gates\.runnable\) \{[\s\S]*?throw new SafetyGateError/,
    );
  });

  it("audits the kill_switch rejection (not silent)", () => {
    expect(runnerSrc).toMatch(/"kill_switch"/);
  });

  it("isAgentKilled fails open (returns false on DB error)", () => {
    expect(killSwitchSrc).toMatch(/async function isAgentKilled/);
    expect(killSwitchSrc).toMatch(/console\.warn\(`\[kill-switch\] isAgentKilled lookup failed/);
    expect(killSwitchSrc).toMatch(/return false;\s*\}\s*return !!data;/);
  });

  it("re-exports isAgentKilled from runner.ts for backwards compat", () => {
    expect(runnerSrc).toMatch(/from "\.\/kill-switch"/);
    expect(runnerSrc).toMatch(/export \{ isAgentKilled \}/);
  });

  it("ensure-runnable.ts resolves visibility via getEffectiveVisibility from ./visibility", () => {
    expect(ensureRunnableSrc).toMatch(/import \{ getEffectiveVisibility \} from "\.\/visibility"/);
    expect(ensureRunnableSrc).toMatch(/getEffectiveVisibility\(tenant_id, slug\)/);
  });
});

describe("emit_decision RPC — kill switch short-circuit (migration 0047)", () => {
  it("checks tenant_agent_kill_switch before resolving autonomy", () => {
    expect(killSwitchMigration).toMatch(/from tenant_agent_kill_switch/);
    expect(killSwitchMigration).toMatch(/where tenant_id = p_tenant_id and agent_slug = v_agent_slug/);
  });

  it("inserts a 'rejected' decision with kill_switch as dispatch_error", () => {
    expect(killSwitchMigration).toMatch(/'rejected'[\s\S]*?dispatch_error[\s\S]*?'kill_switch'/);
  });

  it("set_kill_switch RPC requires tenant membership (auth.uid check)", () => {
    expect(killSwitchMigration).toMatch(/from tenant_users[\s\S]*?user_id = auth\.uid\(\)/);
    expect(killSwitchMigration).toMatch(/raise exception 'not a member of tenant/);
  });
});

describe("executeDispatch — kill switch dispatch-time recheck", () => {
  it("resolves agent_slug from agent_runs by decision.agent_run_id", () => {
    expect(dispatchSrc).toMatch(/\.from\("agent_runs"\)\s*\.select\("agent_slug"\)/);
    expect(dispatchSrc).toMatch(/\.eq\("id", decision\.agent_run_id\)/);
  });

  it("reads tenant_agent_kill_switch keyed by (tenant_id, agent_slug)", () => {
    expect(dispatchSrc).toMatch(
      /\.from\("tenant_agent_kill_switch"\)[\s\S]*?\.eq\("tenant_id", decision\.tenant_id\)[\s\S]*?\.eq\("agent_slug", agent_slug\)/,
    );
  });

  it("fail-CLOSED on agent_runs or kill_switch DB error (does NOT flip status)", () => {
    expect(dispatchSrc).toMatch(/agent_runs read failed:/);
    expect(dispatchSrc).toMatch(/kill_switch_check_failed:/);

    const branchBody = (guard: string, message: string): string => {
      const start = dispatchSrc.indexOf(guard);
      expect(start, `${guard} not found in dispatch-decision.ts`).toBeGreaterThan(-1);
      const ret = dispatchSrc.indexOf(`return { ok: false, error: \`${message}`, start);
      expect(ret, `${guard} does not return ok:false with "${message}"`).toBeGreaterThan(start);
      return dispatchSrc.slice(start, ret);
    };

    for (const [guard, message] of [
      ["if (runErr) {", "agent_runs read failed:"],
      ["if (killErr) {", "kill_switch_check_failed:"],
    ] as const) {
      const body = branchBody(guard, message);
      expect(body, `${guard} writes a decisions row before failing closed`).not.toMatch(
        /\.from\("decisions"\)|DECISION_STATUS_/,
      );
      expect(body, `${guard} fails closed without handing the claim back`).toMatch(
        /releaseClaim\(/,
      );
    }
  });

  it("on killed row, writes status=dispatch_failed + dispatch_error='kill_switch' and returns", () => {
    expect(dispatchSrc).toMatch(
      /if \(killRow\) \{[\s\S]*?status: DECISION_STATUS_DISPATCH_FAILED[\s\S]*?dispatch_error: "kill_switch"[\s\S]*?return \{ ok: false, error: "kill_switch" \}/,
    );
  });

  it("skips the kill-switch check when decision has no agent_run_id (manual ops)", () => {
    expect(dispatchSrc).toMatch(/if \(decision\.agent_run_id\) \{[\s\S]*?\.from\("agent_runs"\)/);
    expect(dispatchSrc).toMatch(/let agent_slug: string \| null = null;/);
    expect(dispatchSrc).toMatch(/if \(agent_slug\) \{[\s\S]*?\.from\("tenant_agent_kill_switch"\)/);
  });
});

describe("kill gates ignore override_state='visible' opt-in rows (all readers agree)", () => {
  it("isAgentKilled (kill-switch.ts) filters override_state='hidden'", () => {
    expect(killSwitchSrc).toMatch(/\.eq\("override_state",\s*"hidden"\)/);
  });

  it("dispatch-decision.ts kill read filters override_state='hidden'", () => {
    expect(dispatchSrc).toMatch(
      /\.from\("tenant_agent_kill_switch"\)[\s\S]*?\.eq\("override_state",\s*"hidden"\)/,
    );
  });

  it("claim_agent_run RPC kill-check filters override_state='hidden'", () => {
    expect(killCheckFixMigration).toMatch(
      /create or replace function claim_agent_run/,
    );
    expect(killCheckFixMigration).toMatch(
      /from tenant_agent_kill_switch[\s\S]*?agent_slug = v_agent_slug[\s\S]*?override_state = 'hidden'/,
    );
  });

  it("emit_decision RPC kill-check filters override_state='hidden'", () => {
    expect(killCheckFixMigration).toMatch(
      /create or replace function emit_decision/,
    );
    expect(killCheckFixMigration).toMatch(
      /from tenant_agent_kill_switch[\s\S]*?agent_slug = v_agent_slug[\s\S]*?override_state = 'hidden'/,
    );
  });

  it("the fix migration recreates BOTH SQL kill-checks (completes the Slice G sweep)", () => {
    const claimIdx = killCheckFixMigration.indexOf(
      "create or replace function claim_agent_run",
    );
    const emitIdx = killCheckFixMigration.indexOf(
      "create or replace function emit_decision",
    );
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(emitIdx).toBeGreaterThan(claimIdx);
    const hits = killCheckFixMigration.match(/^\s+and override_state = 'hidden'/gm) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
