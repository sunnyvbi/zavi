import { describe, it, expect, vi } from "vitest";
import { preToolUsePolicyHook } from "../pre-tool-use-policy";
import type {
  PreToolUsePolicyCtx,
  PreToolUsePolicyDeps,
} from "../pre-tool-use-policy";

function makeCtx(o?: Partial<PreToolUsePolicyCtx>): PreToolUsePolicyCtx {
  return {
    tenant_id: "11111111-1111-1111-1111-111111111111",
    agent: { slug: "pm" },
    runId: "run_x",
    thread_id: null,
    killed: { value: false },
    iter: { value: 0 },
    ...o,
  };
}
function deps(
  ctx: PreToolUsePolicyCtx,
  tool_name: string,
): PreToolUsePolicyDeps {
  return {
    isAgentKilled: vi.fn(async () => false),
    emitThreadEvent: vi.fn(async () => {}),
    ctx,
    hookInput: { tool_name, tool_input: {}, tool_use_id: "t1" } as never,
  };
}
const isDeny = (r: { continue?: boolean; hookSpecificOutput?: unknown }) =>
  r.continue === undefined &&
  (r.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";
const reason = (r: unknown) =>
  (r as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    .hookSpecificOutput?.permissionDecisionReason ?? "";

const OPERATOR_DB_READ_TOOLS = [
  "operator_db__catalog",
  "operator_db__query_user",
  "operator_db__query_listing",
  "operator_db__query_recent_transactions",
  "operator_db__query_bookings_by_geo_category",
  "operator_db__query_active_supply_by_geo_category",
  "operator_db__query_funnel_by_geo_category",
];

describe("pm operator_db PreToolUse gate — default OFF (Bundle A-E3)", () => {
  it("flag ABSENT (undefined) → DENY every operator_db__* tool", async () => {
    for (const tool of OPERATOR_DB_READ_TOOLS) {
      const r = await preToolUsePolicyHook(deps(makeCtx({}), tool));
      expect(isDeny(r)).toBe(true);
      expect(reason(r)).toMatch(/operator_db denied/);
    }
  });

  it("flag explicit FALSE → DENY operator_db__*", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ pm_operator_db_enabled: false }), "operator_db__query_user"),
    );
    expect(isDeny(r)).toBe(true);
    expect(reason(r)).toMatch(/not enabled/);
  });

  it("flag explicit TRUE → ALLOW every operator_db__* tool", async () => {
    for (const tool of OPERATOR_DB_READ_TOOLS) {
      const r = await preToolUsePolicyHook(
        deps(makeCtx({ pm_operator_db_enabled: true }), tool),
      );
      expect(r).toEqual({ continue: true });
    }
  });

  it("flag ON → DENY still applies to the SDK-wrapped tool-name form", async () => {
    const bare = await preToolUsePolicyHook(
      deps(makeCtx({ pm_operator_db_enabled: false }), "mcp__server__operator_db__query_user"),
    );
    expect(isDeny(bare)).toBe(true);
  });

  it("flag OFF + non-operator_db pm tool (memory__search) → ALLOW (unchanged)", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ pm_operator_db_enabled: false }), "memory__search"),
    );
    expect(r).toEqual({ continue: true });
  });

  it("OTHER agent (operator) + operator_db, no pm flag → ALLOW (gate is pm-scoped)", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ agent: { slug: "operator" } }), "operator_db__query_user"),
    );
    expect(r).toEqual({ continue: true });
  });
});
