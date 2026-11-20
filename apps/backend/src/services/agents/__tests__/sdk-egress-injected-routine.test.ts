
import { describe, it, expect } from "vitest";
import { preToolUsePolicyHook } from "../pre-tool-use-policy";
import type { PreToolUsePolicyCtx } from "../pre-tool-use-policy";
import { evaluateToolCallPolicy } from "../tool-call-policy";
import { runTenantRoutine, type RoutineRunnerDeps } from "@/services/routines/runner";

const ROUTINE_NAME = "tenant_skill__operator__abc12345";
const SDK_WEB_FETCH = "mcp__server__web_fetch__fetch";

type Scenario = {
  resolved: string[];
  agent_slug: string;
  untrusted_inbound: boolean;
};

function ctx(s: Scenario): PreToolUsePolicyCtx {
  return {
    tenant_id: "t1",
    agent: { slug: s.agent_slug },
    runId: "run-1",
    thread_id: null,
    killed: { value: false },
    iter: { value: 0 },
    resolved_tool_names: s.resolved,
    research_scoped: false,
    untrusted_inbound: s.untrusted_inbound,
  };
}
const hookInput = {
  hook_event_name: "PreToolUse" as const,
  tool_name: SDK_WEB_FETCH,
  tool_input: { url: "https://x" },
  tool_use_id: "tu-1",
  cwd: "/tmp",
  permission_mode: "default" as const,
  session_id: "s",
  transcript_path: "/tmp/t",
};
async function sdkAllows(s: Scenario): Promise<boolean> {
  const r = await preToolUsePolicyHook({
    isAgentKilled: async () => false,
    emitThreadEvent: async () => {},
    ctx: ctx(s),
    hookInput,
  });
  return r.continue === true;
}

function legacyAllows(s: Scenario): boolean {
  return evaluateToolCallPolicy({
    tool_name: "web_fetch__fetch",
    resolved_tool_names: s.resolved,
    research_scoped: false,
    agent_slug: s.agent_slug,
    untrusted_inbound: s.untrusted_inbound,
  }).allow;
}

const RUN_ID = "run-1";
const TENANT = "t1";
function runnerDeps(s: Scenario): { deps: RoutineRunnerDeps; ran: { n: number } } {
  const ran = { n: 0 };
  const routine = {
    id: "routine-1",
    tenant_id: TENANT,
    agent_slug: s.agent_slug,
    status: "approved",
    emitted_tool_name: "tenant_skill__op__abc12345",
    routine_spec: { type: "tool_sequence", steps: [{ tool: "web_fetch__fetch", args: { url: "https://x" } }] },
    granted_tool_names: ["web_fetch__fetch"],
    provenance_agent_def_hash: "h",
  };
  return {
    ran,
    deps: {
      db: {
        from: (table: string) => {
          const f: Record<string, unknown> = {};
          const q: { select: () => typeof q; eq: (c: string, v: unknown) => typeof q; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
            select: () => q,
            eq: (c: string, v: unknown) => {
              f[c] = v;
              return q;
            },
            maybeSingle: async () => {
              if (table === "agent_runs") return { data: { id: RUN_ID, tenant_id: TENANT, agent_slug: s.agent_slug }, error: null };
              return { data: routine, error: null };
            },
          };
          return q;
        },
      } as unknown as RoutineRunnerDeps["db"],
      loadLiveAgentDef: async () => ({ tools: ["web_fetch__fetch"], def_hash: "h" }),
      callStep: async () => {
        ran.n += 1;
        return { is_error: false, content: "{}" };
      },
      resolveRunTools: async () => s.resolved,
    },
  };
}
async function runnerAllows(s: Scenario): Promise<boolean> {
  const { deps, ran } = runnerDeps(s);
  const r = await runTenantRoutine(
    { run_id: RUN_ID, emitted_tool_name: "tenant_skill__op__abc12345", untrusted_inbound: s.untrusted_inbound },
    deps,
  );
  return r.ok && ran.n === 1;
}

describe("FIX 14 — SDK egress hook applies D2 untrusted-inbound (operator email)", () => {
  it("DENIES web_fetch on an operator EMAIL run even with a baseline-only resolved set (D2)", async () => {
    const s: Scenario = { resolved: ["web_fetch__fetch"], agent_slug: "operator", untrusted_inbound: true };
    expect(await sdkAllows(s)).toBe(false);
    expect(legacyAllows(s)).toBe(false);
    expect(await runnerAllows(s)).toBe(false);
  });

  it("ALLOWS web_fetch on a NON-email operator run with baseline-only resolved set", async () => {
    const s: Scenario = { resolved: ["web_fetch__fetch"], agent_slug: "operator", untrusted_inbound: false };
    expect(await sdkAllows(s)).toBe(true);
    expect(legacyAllows(s)).toBe(true);
    expect(await runnerAllows(s)).toBe(true);
  });
});

describe("E-2 co-residency block REMOVED (2026-06-03) — web allowed even with an injected routine co-resident", () => {
  it("ALLOWS web_fetch when an injected routine is co-resident (non-email; block removed)", async () => {
    const s: Scenario = { resolved: ["web_fetch__fetch", ROUTINE_NAME], agent_slug: "operator", untrusted_inbound: false };
    expect(await sdkAllows(s)).toBe(true);
    expect(legacyAllows(s)).toBe(true);
  });
});

describe("EGRESS PARITY — dispatcher loop ≡ SDK hook (full set incl. skills), runner matches on real co-residency", () => {
  const skillFree: Scenario[] = [
    { resolved: ["web_fetch__fetch"], agent_slug: "operator", untrusted_inbound: false },
    { resolved: ["web_fetch__fetch"], agent_slug: "operator", untrusted_inbound: true },
    { resolved: ["web_fetch__fetch", "stripe__get_customer"], agent_slug: "cto-engineer", untrusted_inbound: false },
    { resolved: ["web_fetch__fetch"], agent_slug: "cto-engineer", untrusted_inbound: true },
  ];

  it("dispatcher loop ≡ SDK hook ≡ routine runner for every SKILL-FREE scenario", async () => {
    for (const s of skillFree) {
      const legacy = legacyAllows(s);
      const sdk = await sdkAllows(s);
      const runner = await runnerAllows(s);
      expect({ ...s, sdk }).toEqual({ ...s, sdk: legacy });
      expect({ ...s, runner }).toEqual({ ...s, runner: legacy });
    }
  });

  it("dispatcher ≡ SDK hook even WITH an injected routine co-resident (both ALLOW post-block-removal)", async () => {
    const s: Scenario = { resolved: ["web_fetch__fetch", ROUTINE_NAME], agent_slug: "operator", untrusted_inbound: false };
    const legacy = legacyAllows(s);
    const sdk = await sdkAllows(s);
    expect(legacy).toBe(true);
    expect(sdk).toBe(true);
  });

  it("all three paths now AGREE on a routine co-resident set (the FIX-18 divergence collapsed once E-2 was removed)", async () => {
    const s: Scenario = { resolved: ["web_fetch__fetch", ROUTINE_NAME], agent_slug: "operator", untrusted_inbound: false };
    expect(legacyAllows(s)).toBe(true);
    expect(await sdkAllows(s)).toBe(true);
    expect(await runnerAllows(s)).toBe(true);
  });
});
