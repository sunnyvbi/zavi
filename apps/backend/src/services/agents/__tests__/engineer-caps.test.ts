import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENGINEER_PR_CAPS_STANDARD,
  ENGINEER_PR_CAPS_XL,
  ENGINEER_PR_CAPS_PRODUCT_BUILD,
  ENGINEER_PR_DISPATCH_CEILING,
  RENDERED_MARKDOWN_MAX_CHARS,
} from "../engineer-caps";
import {
  DEFAULT_BUILDER_CAPS,
  OPERATOR_OPT_IN_BUILDER_CAPS,
  PRODUCT_BUILD_BUILDER_CAPS,
} from "@/services/pr-builder/from-sandbox-fs";
import {
  prProposalSchema,
  validateProposalForDispatch,
  __caps,
} from "@/agents/engineer/output-schema";

describe("engineer-caps — shared tier values", () => {
  it("STANDARD tier = 5000 lines / 512KB / 2MB / 100 files", () => {
    expect(ENGINEER_PR_CAPS_STANDARD).toEqual({
      maxChangedLines: 5000,
      diffByteCap: 512 * 1024,
      maxPostImageBytes: 2 * 1024 * 1024,
      maxFiles: 100,
    });
  });

  it("XL tier = 15000 lines / 1MB / 4MB / 200 files, and is the dispatch ceiling", () => {
    expect(ENGINEER_PR_CAPS_XL).toEqual({
      maxChangedLines: 15_000,
      diffByteCap: 1024 * 1024,
      maxPostImageBytes: 4 * 1024 * 1024,
      maxFiles: 200,
    });
    expect(ENGINEER_PR_DISPATCH_CEILING).toBe(ENGINEER_PR_CAPS_XL);
  });

  it("tier ordering STANDARD < XL < PRODUCT_BUILD holds on every dimension", () => {
    for (const dim of [
      "maxChangedLines",
      "diffByteCap",
      "maxPostImageBytes",
      "maxFiles",
    ] as const) {
      expect(ENGINEER_PR_CAPS_XL[dim]).toBeGreaterThan(
        ENGINEER_PR_CAPS_STANDARD[dim],
      );
      expect(ENGINEER_PR_CAPS_PRODUCT_BUILD[dim]).toBeGreaterThan(
        ENGINEER_PR_CAPS_XL[dim],
      );
    }
  });
});

describe("engineer-caps — cross-module parity (builder ↔ dispatch zod)", () => {
  it("builder cap tiers derive from the shared source", () => {
    expect(DEFAULT_BUILDER_CAPS).toEqual(ENGINEER_PR_CAPS_STANDARD);
    expect(OPERATOR_OPT_IN_BUILDER_CAPS).toEqual(ENGINEER_PR_CAPS_XL);
    expect(PRODUCT_BUILD_BUILDER_CAPS).toEqual(ENGINEER_PR_CAPS_PRODUCT_BUILD);
  });

  it("dispatch zod total caps = the dispatch ceiling (XL tier), NOT the old 200/32KB", () => {
    expect(__caps.TOTAL_LINE_CAP).toBe(ENGINEER_PR_DISPATCH_CEILING.maxChangedLines);
    expect(__caps.TOTAL_BYTE_CAP).toBe(ENGINEER_PR_DISPATCH_CEILING.diffByteCap);
    expect(__caps.TOTAL_LINE_CAP).toBeGreaterThanOrEqual(
      DEFAULT_BUILDER_CAPS.maxChangedLines,
    );
    expect(__caps.TOTAL_BYTE_CAP).toBeGreaterThanOrEqual(
      DEFAULT_BUILDER_CAPS.diffByteCap,
    );
  });

  it("github open_pr tool-input file cap derives from the shared source (lockstep guard)", () => {
    const githubSrc = readFileSync(
      join(__dirname, "../../mcp/internal/github.ts"),
      "utf-8",
    );
    expect(githubSrc).toMatch(/\.max\(ENGINEER_PR_DISPATCH_CEILING\.maxFiles\)/);
    expect(githubSrc).toMatch(/\.max\(ENGINEER_PR_CAPS_PRODUCT_BUILD\.maxFiles\)/);
  });

  it("agent.md prompt quotes the STANDARD tier numbers (manual sync guard)", () => {
    const agentMd = readFileSync(
      join(__dirname, "../../../agents/engineer/agent.md"),
      "utf-8",
    );
    expect(agentMd).toContain("Max 100 files changed");
    expect(agentMd).toContain("Max 5000 added/deleted lines total");
    expect(agentMd).toContain("Max 512KB total unified-diff bytes");
    expect(agentMd).toContain("Max 2MB total post-image bytes");
    expect(agentMd).not.toContain("Max 200 added/deleted lines");
    expect(agentMd).not.toContain("Max 32KB total unified-diff bytes");
  });
});

function diffOfLines(n: number): string {
  return [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    `@@ -0,0 +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+line ${i}`),
  ].join("\n");
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/app",
    base_branch: "main",
    head_branch: "engineer/fix",
    title: "fix: something",
    body: "",
    files: [
      { path: "x.ts", action: "modify", content: "x", diff: diffOfLines(10) },
    ],
    ...overrides,
  };
}

describe("dispatch schema — the 201-5000-line window is closed", () => {
  it("REGRESSION: a 201-line diff (used to die at dispatch) now validates", () => {
    const r = prProposalSchema.safeParse(
      proposal({
        files: [
          { path: "x.ts", action: "modify", content: "x", diff: diffOfLines(201) },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("a 5000-line diff (builder STANDARD max) validates at dispatch", () => {
    const r = prProposalSchema.safeParse(
      proposal({
        files: [
          { path: "x.ts", action: "modify", content: "x", diff: diffOfLines(5000) },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("a diff over the XL ceiling (15001 lines) is still rejected", () => {
    const r = prProposalSchema.safeParse(
      proposal({
        files: [
          { path: "x.ts", action: "modify", content: "x", diff: diffOfLines(15_001) },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("a single >64KB per-file diff under the total cap validates (old per-file 64KB cap removed)", () => {
    const bigLine = "+" + "a".repeat(700);
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -0,0 +1,100 @@",
      ...Array.from({ length: 100 }, () => bigLine),
    ].join("\n");
    const r = prProposalSchema.safeParse(
      proposal({ files: [{ path: "x.ts", action: "modify", content: "x", diff }] }),
    );
    expect(r.success).toBe(true);
  });

  it("file-count ceiling is 200 (matches XL tier), not the old 20", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `f${i}.ts`,
        action: "modify" as const,
        content: "x",
        diff: diffOfLines(1),
      }));
    expect(prProposalSchema.safeParse(proposal({ files: mk(21) })).success).toBe(true);
    expect(prProposalSchema.safeParse(proposal({ files: mk(201) })).success).toBe(false);
  });

  it("RENDERED_MARKDOWN_MAX_CHARS matches the zod cap", () => {
    const ok = prProposalSchema.safeParse(
      proposal({ rendered_markdown: "a".repeat(RENDERED_MARKDOWN_MAX_CHARS) }),
    );
    expect(ok.success).toBe(true);
    const over = prProposalSchema.safeParse(
      proposal({ rendered_markdown: "a".repeat(RENDERED_MARKDOWN_MAX_CHARS + 1) }),
    );
    expect(over.success).toBe(false);
  });
});

describe("validateProposalForDispatch — pre-dispatch enforcement helper", () => {
  it("passes a valid standard-size proposal", () => {
    expect(validateProposalForDispatch(proposal(), { productBuild: false })).toEqual({
      ok: true,
    });
  });

  it("classifies an over-line-cap proposal as over_cap with the exact reason", () => {
    const r = validateProposalForDispatch(
      proposal({
        files: [
          { path: "x.ts", action: "modify", content: "x", diff: diffOfLines(16_000) },
        ],
      }),
      { productBuild: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.over_cap).toBe(true);
      expect(r.reason).toMatch(/exceeds line cap/);
    }
  });

  it("classifies a >200-file proposal as over_cap", () => {
    const files = Array.from({ length: 201 }, (_, i) => ({
      path: `f${i}.ts`,
      action: "modify" as const,
      content: "x",
      diff: diffOfLines(1),
    }));
    const r = validateProposalForDispatch(proposal({ files }), {
      productBuild: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.over_cap).toBe(true);
  });

  it("classifies a shape failure (bad head_branch) as NOT over_cap, with reason", () => {
    const r = validateProposalForDispatch(proposal({ head_branch: "fix/x" }), {
      productBuild: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.over_cap).toBe(false);
      expect(r.reason).toMatch(/head_branch/);
    }
  });

  it("product-build mode validates against the relaxed schema (60K lines pass)", () => {
    const r = validateProposalForDispatch(
      proposal({
        files: [
          { path: "x.ts", action: "create", content: "x", diff: diffOfLines(50_000) },
        ],
      }),
      { productBuild: true },
    );
    expect(r.ok).toBe(true);
  });
});

describe("post-run wiring — over-cap is enforced BEFORE dispatch (source-level)", () => {
  const postRunSrc = readFileSync(
    join(__dirname, "../../../agents/engineer/post-run.ts"),
    "utf-8",
  );

  it("post-run validates the final envelope with validateProposalForDispatch before emit", () => {
    expect(postRunSrc).toMatch(/validateProposalForDispatch\(merged/);
    const validateIdx = postRunSrc.indexOf("validateProposalForDispatch(merged");
    const emitIdx = postRunSrc.lastIndexOf('return { kind: "emit", envelope: merged }');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(validateIdx);
  });

  it("a failed pre-dispatch validation suppresses with the reason surfaced to chat", () => {
    expect(postRunSrc).toMatch(/reason: "dispatch_validation_failed"/);
    expect(postRunSrc).toMatch(/check\.reason/);
  });

  it("the server-side rendered_markdown evidence append clamps to the schema cap", () => {
    expect(postRunSrc).toMatch(/RENDERED_MARKDOWN_MAX_CHARS/);
  });
});
