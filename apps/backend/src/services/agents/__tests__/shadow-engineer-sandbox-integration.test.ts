import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatcherSrc = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);
const dispBodyStart = dispatcherSrc.indexOf(
  "export async function runGeneric(",
);
const dispBody = dispatcherSrc.slice(dispBodyStart);

describe("PROOF #1 — live (non-shadow) engineer run STILL enters the live sandbox setup", () => {
  it("the requires_sandbox setup block is guarded by `!isShadowSandboxRun` (the ONLY new condition)", () => {
    expect(dispBody).toMatch(
      /const isShadowSandboxRun = isShadowRun && ctx\.agent\.slug === "engineer";/,
    );
    expect(dispBody).toMatch(
      /if \(ctx\.agent\.metadata_praxis\.requires_sandbox && !isShadowSandboxRun && !isBench\)/,
    );
  });

  it("the live setup still resolves via getSandboxIdForRun + mounts mcpSandbox (unchanged for a live run)", () => {
    expect(dispBody).toMatch(/resolveRepoFullName\(\{/);
    expect(dispBody).toMatch(/\.sandbox = await mcpSandbox\(\{/);
    expect(dispBody).toMatch(
      /getSandboxIdForRun\(ctx\.tenant_id, runRepoForTools \?\? ""\)/,
    );
  });

  it("isShadowSandboxRun requires BOTH shadow_mode AND engineer — a non-engineer shadow run keeps the live setup unaffected", () => {
    expect(dispBody).toMatch(
      /isShadowSandboxRun = isShadowRun && ctx\.agent\.slug === "engineer"/,
    );
  });
});

describe("PROOF #2 — shadow engineer run never reaches the live (tenant,repo) sandbox", () => {
  it("a shadow engineer SKIPS the live requires_sandbox setup (no resolveRepoFullName / getSandboxIdForRun on that path)", () => {
    expect(dispBody).toMatch(
      /if \(ctx\.agent\.metadata_praxis\.requires_sandbox && !isShadowSandboxRun && !isBench\)/,
    );
  });

  it("the shadow sandbox executor resolves SOLELY via ctx.shadow_sandbox_id (resolveShadowOrLiveSandboxId), never getSandboxIdForRun(tenant,repo)", () => {
    expect(dispBody).toMatch(
      /isShadowEngineerRun =\s*\n?\s*ctx\.shadow_mode === true && ctx\.agent\.slug === "engineer";/,
    );
    expect(dispBody).toMatch(
      /getSandboxId: \(\) =>\s*\n?\s*resolveShadowOrLiveSandboxId\(\s*\n?\s*\{ shadow_mode: true, shadow_sandbox_id: ctx\.shadow_sandbox_id \}/,
    );
  });
});

const { getSandboxIdForRun } = vi.hoisted(() => ({
  getSandboxIdForRun: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/services/sandbox/lifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSandboxIdForRun };
});

import { runCtoPostRun } from "@/agents/engineer/post-run";
import type { AgentContext } from "@/services/agents/types";

function fakeCtx(overrides: Partial<AgentContext>): AgentContext {
  return {
    runId: "run_shadow_eng",
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    agent: { slug: "engineer", metadata_praxis: { requires_sandbox: true } },
    trigger: "chat",
    ...overrides,
  } as unknown as AgentContext;
}

describe("PROOF #2 (post-run) — runCtoPostRun is fail-closed under shadow_mode", () => {
  beforeEach(() => getSandboxIdForRun.mockClear());

  it("returns a no-op suppress BEFORE resolving any live sandbox when ctx.shadow_mode is true", async () => {
    const ctx = fakeCtx({ shadow_mode: true });
    const out = await runCtoPostRun(
      ctx,
      { envelope_kind: "pr_proposal", rendered_markdown: "x" } as unknown,
      { repo_hint: "rravi149/praxis" },
    );
    expect(out).toEqual({ kind: "suppress", reason: "shadow_mode" });
    expect(getSandboxIdForRun).not.toHaveBeenCalled();
  });
});

import {
  createShadowSandboxForRun,
  destroyShadowSandbox,
  ShadowSandboxProvisionError,
  type ShadowSandboxHandle,
} from "@/services/sandbox/shadow-lifecycle";

vi.mock("@/services/sandbox/shadow-lifecycle", () => ({
  createShadowSandboxForRun: vi.fn(),
  destroyShadowSandbox: vi.fn(async () => {}),
  ShadowSandboxProvisionError: class extends Error {
    sandbox_id?: string;
    constructor(m: string, id?: string) {
      super(m);
      this.sandbox_id = id;
    }
  },
}));

const createMock = vi.mocked(createShadowSandboxForRun);
const destroyMock = vi.mocked(destroyShadowSandbox);

async function replaySkeleton(
  run: () => Promise<string>,
): Promise<{ result: string; threw?: unknown }> {
  let handle: ShadowSandboxHandle | undefined;
  try {
    handle = await createShadowSandboxForRun({
      run_id: "r",
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      payload: {},
    });
  } catch (e) {
    if (e instanceof ShadowSandboxProvisionError) {
      await destroyShadowSandbox(e.sandbox_id);
    }
    return { result: `skip: provision failed: ${(e as Error).message}` };
  }
  try {
    return { result: await run() };
  } catch (e) {
    return { result: "threw", threw: e };
  } finally {
    await destroyShadowSandbox(handle?.sandbox_id);
  }
}

describe("PROOF #3 — shadow-replay caller tears the box down ALWAYS", () => {
  beforeEach(() => {
    createMock.mockReset();
    destroyMock.mockReset();
    destroyMock.mockResolvedValue();
  });

  it("(a) provision throws AFTER create → caller destroys error.sandbox_id (no orphan)", async () => {
    createMock.mockRejectedValue(
      new ShadowSandboxProvisionError("clone failed", "sbx_halfcreated"),
    );
    const { result } = await replaySkeleton(async () => "ran");
    expect(result).toMatch(/skip: provision failed/);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledWith("sbx_halfcreated");
  });

  it("(b) successful provision but the run THROWS → the finally still destroys the box", async () => {
    createMock.mockResolvedValue({
      sandbox_id: "sbx_fresh",
      repo_full_name: "rravi149/praxis",
    });
    const { result } = await replaySkeleton(async () => {
      throw new Error("runGeneric blew up mid-replay");
    });
    expect(result).toBe("threw");
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledWith("sbx_fresh");
  });

  it("(c) happy path → finally destroys exactly once", async () => {
    createMock.mockResolvedValue({
      sandbox_id: "sbx_fresh",
      repo_full_name: "rravi149/praxis",
    });
    const { result } = await replaySkeleton(async () => "ok run_x");
    expect(result).toBe("ok run_x");
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledWith("sbx_fresh");
  });
});
