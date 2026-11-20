import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { buildSpy, execSpy, gateImpl, appendSpy, shipGateSeen } = vi.hoisted(() => ({
  buildSpy: vi.fn(),
  execSpy: vi.fn(),
  gateImpl: { ok: false as boolean },
  appendSpy: vi.fn(),
  shipGateSeen: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: async () => "sbx-1" }));
vi.mock("@/services/sandbox/e2b-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  execCommand: execSpy,
}));
vi.mock("@/services/pr-builder/from-sandbox-fs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildPrFilesFromSandboxFs: buildSpy,
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertProvisionedRepoTarget: async (_t: string, repo: string) =>
    gateImpl.ok ? { ok: true, github_full_name: repo } : { ok: false, reason: "not provisioned" },
}));
vi.mock("../ship-gate", async (orig) => {
  const real = await orig<typeof import("../ship-gate")>();
  return {
    ...real,
    evaluateCtoShipGate: (env: unknown) => {
      if (env && typeof env === "object" && "files" in env) {
        shipGateSeen.push({ ...(env as Record<string, unknown>) });
      }
      return real.evaluateCtoShipGate(env);
    },
    appendTestingSection: (...args: Parameters<typeof real.appendTestingSection>) => {
      appendSpy(...args);
      throw new Error("stop at the PR-body append");
    },
  };
});
vi.mock("@/services/supabase", async (orig) => {
  const empty = { data: null, error: null };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(empty) : chain),
    apply: () => chain,
  });
  return { ...(await orig<Record<string, unknown>>()), serviceClient: () => chain };
});
vi.mock("../product-builder-flag", () => ({ isProductBuilderEnabled: async () => false }));
vi.mock("@/services/agents/engineer-large-diff-allowlist", () => ({
  isEngineerLargeDiffAllowlisted: async () => false,
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: async () => undefined,
}));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => false }));

import { runCtoPostRun } from "../post-run";

const REPO = "acme/web";

const progressCodes: string[] = [];

async function runToAppend(envelopeExtra: Record<string, unknown> = {}) {
  const ctx = {
    tenant_id: "11111111-1111-1111-1111-111111111111",
    runId: "22222222-2222-2222-2222-222222222222",
    agent: { slug: "engineer" },
    memory: { company: "" },
    emitProgress: vi.fn(async (_stage: string, meta?: { code?: string }) => {
      if (meta?.code) progressCodes.push(meta.code);
    }),
  } as never;
  const envelope = {
    repo: REPO,
    base_branch: "main",
    title: "Fix the inquiry email",
    body: "Treat inquiry chats like general ones.",
    risk_class: "low",
    ...envelopeExtra,
  };
  await runCtoPostRun(ctx, envelope, { repo_hint: REPO, task_description: "Fix the email" }, []).catch(
    () => undefined,
  );
  return appendSpy.mock.calls;
}

describe("runCtoPostRun — PR-body notes per audience", () => {
  beforeEach(() => {
    appendSpy.mockReset();
    shipGateSeen.length = 0;
    progressCodes.length = 0;
    buildSpy.mockReset();
    execSpy.mockReset();
    execSpy.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    buildSpy.mockResolvedValue({
      files: [
        {
          path: "apps/backend/src/chat.ts",
          action: "modify",
          diff: "+export const x = 1;\n",
          content: "export const x = 1;\n",
        },
      ],
      total_diff_bytes: 1,
      total_changed_lines: 1,
      total_post_image_bytes: 1,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a customer repo with only sandbox limitations gets no Testing section at all", async () => {
    gateImpl.ok = false;
    const calls = await runToAppend({ typecheck_ok: false });
    expect(calls).toEqual([]);
    expect(shipGateSeen.length).toBeGreaterThanOrEqual(1);
    expect(shipGateSeen[0]).not.toHaveProperty("typecheck_ok");
    expect(shipGateSeen[0]).not.toHaveProperty("typecheck_verify");
    expect(progressCodes).toContain("customer_repo_typecheck_red");
    expect(progressCodes).not.toContain("ship_gate_block_typecheck_failed");
  });

  it("a Zavi-built repo keeps today's notes and intro", async () => {
    gateImpl.ok = true;
    const calls = await runToAppend({ typecheck_ok: false });
    expect(calls).toHaveLength(1);
    const [, notes, , audience] = calls[0] as [unknown, string[], unknown, string];
    expect(audience).toBe("zavi_built");
    expect(notes.some((n) => n.startsWith("Tests:"))).toBe(true);
    expect(shipGateSeen[0]).toHaveProperty("typecheck_ok", false);
    expect(progressCodes).not.toContain("customer_repo_typecheck_red");
  });
});
