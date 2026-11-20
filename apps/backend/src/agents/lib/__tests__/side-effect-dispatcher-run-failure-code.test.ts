
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const mockRunGeneric = vi.fn();
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => mockRunGeneric(...args),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: vi.fn() }),
}));

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { hasRunFailureCode } from "@/services/agents/run-failure-code";
import { AppDatabaseSetupError } from "@/services/provisioning/app-db-on-demand";
import { classifyAppDatabaseError } from "@/services/agents/conductor";

beforeEach(() => {
  vi.clearAllMocks();
});

function okResult(): DispatcherResult {
  return {
    output_text: "",
    parsed: { rendered_markdown: "x" },
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  } as DispatcherResult;
}

function ctx(): AgentContext {
  return { emitDecision: vi.fn().mockResolvedValue("d-1"), tenant_id: "tnt-1", runId: "r-1" } as unknown as AgentContext;
}

function dispatcherThrowing(err: unknown) {
  return createSideEffectDispatcher({
    slug: "engineer",
    decisionClass: "engineer.ship-pr",
    transformBeforeCriticAndEmit: async () => {
      throw err;
    },
  });
}

describe("run_failure_code errors fail the run as themselves", () => {
  it("side-effect-dispatcher rethrows an AppDatabaseSetupError unchanged; nothing is emitted", async () => {
    mockRunGeneric.mockResolvedValueOnce(okResult());
    const err = new AppDatabaseSetupError("database not ready: neon 500");
    const c = ctx();
    await expect(dispatcherThrowing(err)(c, {})).rejects.toBe(err);
    expect(c.emitDecision).not.toHaveBeenCalled();
  });

  it("any other transform error still becomes a parse failure (unchanged behavior)", async () => {
    mockRunGeneric.mockResolvedValueOnce(okResult());
    const r = await dispatcherThrowing(new Error("boom"))(ctx(), {});
    expect(r.parse_ok).toBe(false);
    expect(r.parse_error).toBe("transform_threw:boom");
  });

  it("hasRunFailureCode: only errors with a non-empty string code", () => {
    expect(hasRunFailureCode(new AppDatabaseSetupError("x"))).toBe(true);
    expect(hasRunFailureCode(new Error("x"))).toBe(false);
    expect(hasRunFailureCode(Object.assign(new Error("x"), { run_failure_code: "" }))).toBe(false);
    expect(hasRunFailureCode({ run_failure_code: "x", message: "x" })).toBe(false);
  });

  it("run-agent never natively retries it and keeps the message", () => {
    const src = readFileSync(join(__dirname, "../../../../workers/functions/run-agent.ts"), "utf8");
    expect(src).toMatch(/if \(hasRunFailureCode\(e\)\) \{\s*\n\s*throw new NonRetriableError\(msg\);/);
    expect(src).toMatch(/const rawMessage = \(e as Error\)\.message \?\? "unknown error";/);
  });

  it("persistTerminal's error branch stores the error verbatim", () => {
    const src = readFileSync(join(__dirname, "../../../services/agents/runner.ts"), "utf8");
    expect(src).toMatch(/update\.status = "dispatch_error";\s*\n\s*update\.error = error;/);
  });

  it("the stored run error classifies as an app-database failure in the conductor", () => {
    const stored = new AppDatabaseSetupError("env-var PUT DATABASE_URL failed (500)").message;
    expect(stored).toBe("app_database_setup_failed: Couldn't set up your site's database. No changes were published. Retry.");
    expect(classifyAppDatabaseError(stored).app_database).toBe(true);
  });
});
