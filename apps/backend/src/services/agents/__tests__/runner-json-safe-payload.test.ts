import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: Record<string, unknown> }> }));
vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../fleet-halt", async (orig) => ({ ...(await orig<typeof import("../fleet-halt")>()), isFleetHalted: async () => false }));
vi.mock("../registry", async (orig) => ({
  ...(await orig<typeof import("../registry")>()),
  loadAgentDefinition: async (slug: string) => ({
    slug, content_hash: "h",
    metadata_praxis: { manual_only: true, side_effects: false, cost_class: "expensive", requires_sandbox: false },
  }),
}));
vi.mock("@/services/sandbox/sandbox-enablement-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/sandbox-enablement-flag")>()),
  resolveSandboxMode: async () => ({ requires_sandbox: false, lazyEligible: false }),
}));
vi.mock("../budget", async (orig) => ({ ...(await orig<typeof import("../budget")>()), resolveDailyCapUsd: async () => 0 }));
vi.mock("../ensure-runnable", async (orig) => ({
  ...(await orig<typeof import("../ensure-runnable")>()),
  ensureAgentRunnable: async (_t: string, slug: string) => ({ runnable: true, agent: { slug } }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: async () => ({}) } }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: () => {} }));
vi.mock("@/services/logging/logEvent", async (orig) => ({ ...(await orig<typeof import("@/services/logging/logEvent")>()), logEvent: async () => {} }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: async () => {} }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      m.calls.push({ name, args });
      return { data: "run-1", error: null };
    },
    from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { enqueueAgentRun } from "../runner";
import { firstLine } from "@/services/growth/cgo-evidence";

const T = "11111111-1111-1111-1111-111111111111";
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
beforeEach(() => { m.calls.length = 0; });

describe("enqueueAgentRun sends a JSON-safe payload", () => {
  it("replaces a lone surrogate and drops NUL anywhere in the payload, keeping whole emoji", async () => {
    const cut = "styled 𝘢𝘣".slice(0, 10);
    expect(LONE.test(cut)).toBe(true);
    const payload = {
      stage: "own_goals",
      memory: { cgo_goals: { evidence: { organic: [{ items: [{ first_line: `${cut}…` }, { first_line: "ok 📰 fine" }] }] } } },
      note: "a\u0000b",
      n: 3,
      flag: true,
      none: null,
    };
    const { run_id } = await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload, cron_dedupe_key: "k" });
    expect(run_id).toBe("run-1");
    const sent = m.calls.find((c) => c.name === "enqueue_agent_run")!.args.p_payload as typeof payload;
    const body = JSON.stringify(sent);
    expect(/\\ud[89a-f][0-9a-f]{2}/i.test(body)).toBe(false);
    expect(body).not.toContain("\\u0000");
    const items = sent.memory.cgo_goals.evidence.organic[0].items;
    expect(items[0].first_line).toBe("styled 𝘢�…");
    expect(items[1].first_line).toBe("ok 📰 fine");
    expect(sent.note).toBe("ab");
    expect({ n: sent.n, flag: sent.flag, none: sent.none, stage: sent.stage }).toEqual({ n: 3, flag: true, none: null, stage: "own_goals" });
  });

  it("never turns a NUL-suffixed key into a reserved key, and keeps __proto__ as data", async () => {
    const payload = JSON.parse('{"staff_model\\u0000":{"key":"opus"},"x":{"__proto__":{"k":1}}}');
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload, cron_dedupe_key: "k3" });
    const sent = m.calls.find((c) => c.name === "enqueue_agent_run")!.args.p_payload as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["staff_model\uFFFD", "x"]);
    expect(JSON.stringify(sent.x)).toBe('{"__proto__":{"k":1}}');
  });

  it("leaves a null payload null", async () => {
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", cron_dedupe_key: "k2" });
    expect(m.calls.find((c) => c.name === "enqueue_agent_run")!.args.p_payload).toBeNull();
  });
});

describe("firstLine never cuts a surrogate pair", () => {
  it("drops the half character at the cut instead of leaving a lone surrogate", () => {
    const s = `${"x".repeat(98)}𝘢 and more text after the cut`;
    const out = firstLine(s);
    expect(LONE.test(out)).toBe(false);
    expect(out).toBe(`${"x".repeat(98)}…`);
  });
  it("keeps a whole emoji that fits", () => {
    const s = `${"x".repeat(97)}📰 and more`;
    expect(firstLine(s)).toBe(`${"x".repeat(97)}📰…`);
  });
});
