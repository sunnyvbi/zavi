import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/tool-registry", () => ({ persistImageArtifact: vi.fn(async () => null) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { callBrowserTaskTool } from "../browser-task";
import type { ToolEffectDeps } from "../../tool-effect-ledger";
import type { McpCallResult } from "../../types";

const ARGS = { goal: "What are the plans?", start_url: "https://acme.com/pricing" };
const CTX = { tenant_id: "t1", run_id: "run-1", tool_use_id: "toolu_1" };
const RESULT = { status: "done" as const, answer: "Starter $20", facts: [], final_url: "https://acme.com/pricing", screenshot_artifact_ids: [] };

function ledger() {
  const store = new Map<string, { input_hash: string; result?: McpCallResult }>();
  const deps: ToolEffectDeps = {
    lookupCommitted: vi.fn(async (r, t) => {
      const row = store.get(`${r}:${t}`);
      return row?.result ? { result: row.result, input_hash: row.input_hash } : null;
    }),
    claimPending: vi.fn(async (i) => {
      const k = `${i.run_id}:${i.tool_use_id}`;
      if (store.has(k)) return false;
      store.set(k, { input_hash: i.input_hash });
      return true;
    }),
    commit: vi.fn(async (r, t, res) => {
      const row = store.get(`${r}:${t}`);
      if (row) row.result = res;
    }),
  };
  return deps;
}

beforeEach(() => {
  delete process.env.PRAXIS_TOOL_EFFECT_LEDGER;
});

describe("browser__task replay", () => {
  it("a replay of the same tool_use_id returns the stored result without browsing again", async () => {
    const l = ledger();
    const run = vi.fn(async () => RESULT);
    const first = await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run });
    const second = await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.content).toBe(first.content);
    expect(first.content).toContain("Starter $20");
  });

  it("a different tool_use_id browses (it is a new call)", async () => {
    const l = ledger();
    const run = vi.fn(async () => RESULT);
    await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run });
    await callBrowserTaskTool({ ...CTX, tool_use_id: "toolu_2" }, "task", ARGS, { ledger: l, run });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a ledger outage fails open (browses once, still answers)", async () => {
    const l: ToolEffectDeps = {
      lookupCommitted: vi.fn(async () => {
        throw new Error("db");
      }),
      claimPending: vi.fn(async () => {
        throw new Error("db");
      }),
      commit: vi.fn(async () => {
        throw new Error("db");
      }),
    };
    const run = vi.fn(async () => RESULT);
    const r = await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("the tool keeps its read effect (punt-guard / read-only bridge unchanged)", async () => {
    const { listBrowserTaskTools } = await import("../browser-task");
    expect(listBrowserTaskTools()[0].effect).toBe("read");
  });

  it("a reused tool_use_id with DIFFERENT args never gets the other URL's stored content", async () => {
    const l = ledger();
    const run = vi.fn(async (i: { start_url: string }) => ({ ...RESULT, answer: `page ${i.start_url}`, final_url: i.start_url }));
    await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run: run as never });
    const b = await callBrowserTaskTool(CTX, "task", { ...ARGS, start_url: "https://acme.com/about" }, { ledger: l, run: run as never });
    expect(run).toHaveBeenCalledTimes(2);
    expect(b.content).toContain("acme.com/about");
    expect(b.content).not.toContain("page https://acme.com/pricing");
  });

  it("a concurrent attempt holding the key answers status busy and never browses", async () => {
    const l = ledger();
    l.claimPending = vi.fn(async () => false);
    const run = vi.fn(async () => RESULT);
    const r = await callBrowserTaskTool(CTX, "task", ARGS, { ledger: l, run });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(r.content).status).toBe("busy");
  });
});
