import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  INCOMPLETE_TITLE_PREFIX,
  buildStepCapProposal,
  applyHandBackFields,
  isStepCapFallback,
  markIncompleteProposal,
} from "../incomplete-pr";
import { runCtoPostRun } from "../post-run";

const { buildSpy, sandboxSpy } = vi.hoisted(() => ({
  buildSpy: vi.fn(),
  sandboxSpy: vi.fn(async () => "sbx-1"),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: sandboxSpy }));
vi.mock("@/services/pr-builder/from-sandbox-fs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildPrFilesFromSandboxFs: buildSpy,
}));
vi.mock("../product-builder-flag", () => ({ isProductBuilderEnabled: async () => false }));
vi.mock("@/services/agents/engineer-large-diff-allowlist", () => ({
  isEngineerLargeDiffAllowlisted: async () => false,
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: async () => undefined,
}));

const FALLBACK = {
  rendered_markdown: "## I reached the maximum number of turns (40)\nI ran out of tool budget. Edited Banner.tsx.",
  refused: true,
  parse_fallback_kind: "tool_iter_cap_fallback",
};

describe("isStepCapFallback", () => {
  it("is true only for a v2 engineer run whose envelope is the max-turns fallback", () => {
    const eng = { agent: { slug: "engineer" }, engineer_cost_v2: true };
    expect(isStepCapFallback(eng, FALLBACK)).toBe(true);
    expect(isStepCapFallback({ ...eng, engineer_cost_v2: undefined }, FALLBACK)).toBe(false);
    expect(isStepCapFallback({ agent: { slug: "pm" }, engineer_cost_v2: true }, FALLBACK)).toBe(false);
    expect(isStepCapFallback(eng, { rendered_markdown: "x", refused: true })).toBe(false);
  });

  it("is false for a build-pipeline run (payload.stage): a partial build never reaches push_to_main", () => {
    const eng = { agent: { slug: "engineer" }, engineer_cost_v2: true };
    expect(isStepCapFallback(eng, FALLBACK, { stage: "build" })).toBe(false);
    expect(isStepCapFallback(eng, FALLBACK, { repo_hint: "acme/web" })).toBe(true);
  });
});

describe("buildStepCapProposal + markIncompleteProposal", () => {
  it("writes a proposal the pipeline can ship, marked incomplete", () => {
    const p = buildStepCapProposal({ fallback: FALLBACK, repo: "acme/web", taskText: "Add an admin banner" });
    expect(p.repo).toBe("acme/web");
    expect(p.incomplete).toBe(true);
    expect(p.refused).toBeUndefined();
    expect(p.parse_fallback_kind).toBeUndefined();
    expect(p.body).toContain("step budget ran out");
    expect(p.body).toContain("Add an admin banner");
    expect(p.body).toContain("Edited Banner.tsx.");
    markIncompleteProposal(p);
    expect(p.title).toBe(`${INCOMPLETE_TITLE_PREFIX}Add an admin banner`);
    expect((p.body as string).match(/What is left/g)).toHaveLength(1);
  });

  it("marks a model hand-back: title prefix once, remaining listed, within limits", () => {
    const m: Record<string, unknown> = {
      title: "x".repeat(120),
      body: "Did the API half.",
      incomplete: true,
      remaining: ["wire the UI", "add tests"],
    };
    markIncompleteProposal(m);
    expect((m.title as string).startsWith(INCOMPLETE_TITLE_PREFIX)).toBe(true);
    expect((m.title as string).length).toBeLessThanOrEqual(120);
    expect(m.body).toContain("Did the API half.");
    expect(m.body).toContain("- wire the UI");
    expect(m.body).toContain("- add tests");
    markIncompleteProposal(m);
    expect((m.title as string).split("[incomplete]").length).toBe(2);
    expect((m.body as string).match(/### What is left/g)).toHaveLength(1);
  });

  it("keeps the body under the 8000-char schema cap", () => {
    const m: Record<string, unknown> = {
      title: "t",
      body: "b".repeat(7990),
      incomplete: true,
      remaining: Array.from({ length: 20 }, () => "r".repeat(400)),
    };
    markIncompleteProposal(m);
    expect((m.body as string).length).toBeLessThanOrEqual(8000);
  });

  it("leaves a complete proposal untouched", () => {
    const m: Record<string, unknown> = { title: "Fix it", body: "done" };
    markIncompleteProposal(m);
    expect(m).toEqual({ title: "Fix it", body: "done" });
  });
});

describe("pr_proposal model schema carries the hand-back fields", () => {
  it("keeps incomplete + remaining, and never fails on a sloppy shape", async () => {
    const { prProposalModelOutputSchema } = await import("../output-schema");
    const base = { repo: "acme/web", base_branch: "main", title: "t", body: "b" };
    const ok = prProposalModelOutputSchema.safeParse({
      ...base,
      incomplete: true,
      remaining: ["wire the UI", "", 7, "x".repeat(900)],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.incomplete).toBe(true);
      expect(ok.data.remaining).toEqual(["wire the UI", "x".repeat(400)]);
    }
    const sloppy = prProposalModelOutputSchema.safeParse({ ...base, incomplete: "yes", remaining: "all" });
    expect(sloppy.success).toBe(true);
    if (sloppy.success) {
      expect(sloppy.data.incomplete).toBeUndefined();
      expect(sloppy.data.remaining).toBeUndefined();
    }
  });
});

describe("applyHandBackFields (post-run's single call)", () => {
  const handBack = () => ({
    title: "Add banner",
    body: "Did half.",
    incomplete: true,
    remaining: ["wire UI"],
  });

  it("v2 on, normal run: marks the proposal", () => {
    const m: Record<string, unknown> = handBack();
    applyHandBackFields(m, { costV2: true, payload: { repo_hint: "acme/web" } });
    expect(m.title).toBe("[incomplete] Add banner");
    expect(m.body).toContain("- wire UI");
  });

  it("build-pipeline run (payload.stage) with incomplete:true: fields stripped, title and body untouched", () => {
    const m: Record<string, unknown> = handBack();
    applyHandBackFields(m, { costV2: true, payload: { stage: "build" } });
    expect(m).toEqual({ title: "Add banner", body: "Did half." });
  });

  it("v2 off: fields stripped, never marked", () => {
    const m: Record<string, unknown> = handBack();
    applyHandBackFields(m, { costV2: false, payload: {} });
    expect(m).toEqual({ title: "Add banner", body: "Did half." });
  });

  it("post-run applies it after the head-branch pin and before the push_to_main stamp", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");
    const call = src.indexOf("applyHandBackFields(merged");
    expect(call).toBeGreaterThan(src.indexOf("resolveHeadBranch({"));
    expect(call).toBeLessThan(src.indexOf("Autopilot codegen→push-to-main stamp"));
    expect(src).not.toMatch(/\bmarkIncompleteProposal\(/);
  });
});

describe("runCtoPostRun at the step cap", () => {
  beforeEach(() => {
    buildSpy.mockReset();
    sandboxSpy.mockClear();
  });

  function ctx(v2: boolean) {
    return {
      tenant_id: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      agent: { slug: "engineer" },
      ...(v2 ? { engineer_cost_v2: true } : {}),
      emitProgress: vi.fn(async () => undefined),
    } as never;
  }
  const payload = { repo_hint: "acme/web", task_description: "Add an admin banner" };

  it("no diff: reports progress, opens no PR", async () => {
    buildSpy.mockResolvedValue({ files: [] });
    const out = await runCtoPostRun(ctx(true), { ...FALLBACK }, payload, []);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("suppress");
    if (out.kind === "suppress") {
      expect(out.reason).toBe("empty_diff");
      expect(out.output_text).toContain("Edited Banner.tsx.");
    }
  });

  it("v2 OFF: the fallback is suppressed as a refused envelope, as before", async () => {
    const out = await runCtoPostRun(ctx(false), { ...FALLBACK }, payload, []);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(out.kind).toBe("suppress");
    if (out.kind === "suppress") expect(out.reason).toBe("refused_envelope");
  });
});
