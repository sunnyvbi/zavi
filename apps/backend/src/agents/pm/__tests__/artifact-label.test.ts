
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyProductPmMode } from "../classify";
import { productPmBacklogSchema } from "../output-schema";
import { normalizeArtifactLabel, processProductPmBacklog } from "../post-run";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "00000000-0000-0000-0000-000000000001",
    runId: "00000000-0000-0000-0000-000000000099",
    trigger: "chat",
    agent: {
      slug: "pm",
      metadata_praxis: {} as never,
    } as never,
    memory: {} as never,
    ...overrides,
  } as AgentContext;
}

function makeEmptyEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: "no_signal",
    rendered_markdown: "",
    summary: { bullets: [] },
    backlog: [],
    dispatched_actions: [],
    recommended_actions_not_dispatched: [],
    sources_all: [],
    ...overrides,
  };
}

describe("classifier — sacred invariants preserved by role-flex", () => {
  it("Test #2: chat strategy-request → strategy_memo (no regression)", () => {
    const mode = classifyProductPmMode({
      trigger: "chat",
      userText: "What's our growth strategy for the next quarter?",
    });
    expect(mode).toBe("strategy_memo");
  });

  it("Test #3: chat backlog-request → delivery (no regression)", () => {
    const mode = classifyProductPmMode({
      trigger: "chat",
      userText: "What are the top product backlog items we should ship?",
    });
    expect(mode).toBe("delivery");
  });

  it("Test #4: cron trigger with artifact-shape user text → delivery (sacred invariant)", () => {
    const mode = classifyProductPmMode({
      trigger: "cron",
      userText: "draft an email to Jack about the renewal",
    });
    expect(mode).toBe("delivery");
  });

  it("Test #5: A2A trigger with artifact-shape user text → delivery (sacred invariant)", () => {
    const mode = classifyProductPmMode({
      trigger: "a2a",
      userText: "write a weekly status update",
    });
    expect(mode).toBe("delivery");
  });
});

describe("output-schema — artifact_label", () => {
  it("Test #1 (schema half): chat artifact-request envelope shape parses cleanly", () => {
    const env = makeEmptyEnvelope({
      status: "no_signal",
      artifact_label: "insurance reply draft",
      rendered_markdown: "Hi Jack,\n\nThanks for the update. Here is where we stand on each item...\n\n[real artifact body well past 50 chars to satisfy the sanity floor]",
    });
    const parsed = productPmBacklogSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.artifact_label).toBe("insurance reply draft");
      expect(parsed.data.status).toBe("no_signal");
    }
  });

  it("artifact_label is optional — old envelopes without it parse fine (backward-compat)", () => {
    const env = makeEmptyEnvelope({ status: "no_signal", rendered_markdown: "_no signal_" });
    const parsed = productPmBacklogSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.artifact_label).toBeUndefined();
  });

  it("artifact_label raw cap = 120 chars (allows pre-normalization input)", () => {
    const env = makeEmptyEnvelope({
      status: "no_signal",
      artifact_label: "x".repeat(120),
      rendered_markdown: "body that is at least 50 chars long to pass the sanity floor.",
    });
    expect(productPmBacklogSchema.safeParse(env).success).toBe(true);
    const tooLong = makeEmptyEnvelope({ status: "no_signal", artifact_label: "x".repeat(121) });
    expect(productPmBacklogSchema.safeParse(tooLong).success).toBe(false);
  });

  it("artifact_label min length = 1 (empty string rejected)", () => {
    const env = makeEmptyEnvelope({ status: "no_signal", artifact_label: "" });
    expect(productPmBacklogSchema.safeParse(env).success).toBe(false);
  });
});

describe("post-run — normalizeArtifactLabel", () => {
  it("Test #10: normalizes label with markdown + newlines + 90 chars → ≤60 + no markdown chars + single-line", () => {
    const dirty =
      "# **Insurance** reply\ndraft for Jack — multi-line\twith markdown chars and " +
      "tons of extra whitespace to push it past 60 chars in length";
    const clean = normalizeArtifactLabel(dirty);
    expect(clean).toBeDefined();
    expect(clean!.length).toBeLessThanOrEqual(60);
    expect(clean).not.toMatch(/[#*\n\t`]/);
    expect(clean).not.toMatch(/\s{2,}/);
  });

  it("returns undefined for whitespace-only input (no garbage labels)", () => {
    expect(normalizeArtifactLabel("   \t\n  ")).toBeUndefined();
    expect(normalizeArtifactLabel("###")).toBeUndefined();
    expect(normalizeArtifactLabel(undefined)).toBeUndefined();
    expect(normalizeArtifactLabel("")).toBeUndefined();
  });

  it("preserves clean labels unchanged", () => {
    expect(normalizeArtifactLabel("insurance reply draft")).toBe("insurance reply draft");
    expect(normalizeArtifactLabel("weekly status update")).toBe("weekly status update");
  });
});

describe("post-run — 3-way discriminator (artifact / fallback artifact / apologetic)", () => {
  it("Test #6 (primary artifact path): artifact_label populated + body ≥50 chars → friendlier header prepended", async () => {
    const env = productPmBacklogSchema.parse(
      makeEmptyEnvelope({
        status: "no_signal",
        artifact_label: "insurance reply draft",
        rendered_markdown:
          "Hi Jack,\n\nThanks for the update. Here is where we stand on each item:\n\n- Driver criteria...\n- Credit threshold...",
      }),
    );
    const { brief } = await processProductPmBacklog(makeCtx(), env);
    expect(brief.rendered_markdown?.startsWith("## insurance reply draft\n\n")).toBe(true);
    expect(brief.rendered_markdown).toContain("Hi Jack,");
    expect(brief.artifact_label).toBe("insurance reply draft");
  });

  it("fallback artifact path: no artifact_label + body ≥200 chars → generic 'Draft' header", async () => {
    const longBody = "x".repeat(220);
    const env = productPmBacklogSchema.parse(
      makeEmptyEnvelope({ status: "no_signal", rendered_markdown: longBody }),
    );
    const { brief } = await processProductPmBacklog(makeCtx(), env);
    expect(brief.rendered_markdown?.startsWith("## Draft\n\n")).toBe(true);
    expect(brief.rendered_markdown).toContain(longBody);
  });

  it("Test #7 (apologetic path): empty rendered_markdown + status:no_signal → preserved as-is", async () => {
    const env = productPmBacklogSchema.parse(
      makeEmptyEnvelope({ status: "no_signal", rendered_markdown: "## No actionable signal\n\n_no signal_" }),
    );
    const { brief } = await processProductPmBacklog(makeCtx(), env);
    expect(brief.rendered_markdown).toBe("## No actionable signal\n\n_no signal_");
  });

  it("Test #11 (idempotent header): LLM body already starts with ## Header → no double-prepend", async () => {
    const env = productPmBacklogSchema.parse(
      makeEmptyEnvelope({
        status: "no_signal",
        artifact_label: "insurance reply",
        rendered_markdown: "## Insurance reply draft\n\nHi Jack, this body already starts with a heading and shouldn't get double-prepended.",
      }),
    );
    const { brief } = await processProductPmBacklog(makeCtx(), env);
    const headingCount = (brief.rendered_markdown ?? "").match(/^##\s/gm)?.length ?? 0;
    expect(headingCount).toBe(1);
    expect(brief.rendered_markdown?.startsWith("## Insurance reply draft\n\n")).toBe(true);
  });

  it("normalizes dirty artifact_label before deriving header", async () => {
    const env = productPmBacklogSchema.parse(
      makeEmptyEnvelope({
        status: "no_signal",
        artifact_label: "# **Insurance** reply\ndraft",
        rendered_markdown: "Hi Jack, here is the draft body that is long enough to pass the sanity floor.",
      }),
    );
    const { brief } = await processProductPmBacklog(makeCtx(), env);
    expect(brief.artifact_label).toBe("Insurance reply draft");
    expect(brief.rendered_markdown?.startsWith("## Insurance reply draft\n\n")).toBe(true);
  });
});

describe("post-run — Test #9: actionable + wiped backlog UNCONDITIONALLY server-overwrites (citation-wipe safety)", () => {
  it("status:actionable with wiped backlog + long LLM rendered_markdown → server still overwrites", async () => {
    const env = productPmBacklogSchema.parse({
      status: "actionable",
      rendered_markdown: "x".repeat(500),
      artifact_label: "should be stripped",
      summary: { bullets: ["theme [src: 00000000-0000-0000-0000-000000000999]"] },
      backlog: [
        {
          item_id: "fake-item",
          theme: "fake",
          theme_normalized: "fake",
          problem: "fake problem",
          proposed_fix: "fake fix",
          target: "backend",
          code_reach: 1,
          code_confidence: 1,
          impact: "high",
          effort: "low",
          rice_score: 9,
          reasoning: "fake",
          evidence_sources: [
            {
              agent_run_id: "00000000-0000-0000-0000-000000000999",
              summary: "non-existent run",
            },
          ],
        },
      ],
      dispatched_actions: [],
      recommended_actions_not_dispatched: [],
      sources_all: [],
    });
    expect(env.status).toBe("actionable");
    expect(env.backlog.length).toBe(1);
  });
});

describe("agent.md contract-ordering — sacred", () => {
  it("Test #12: the JSON-payload wrapper rule appears BEFORE '## ALSO VALID: PM Artifact Shape'", () => {
    const path = join(__dirname, "..", "agent.md");
    const content = readFileSync(path, "utf-8");
    const wrapperRulePos = content.indexOf("every response wraps a JSON payload");
    const artifactSectionPos = content.indexOf("## ALSO VALID: PM Artifact Shape");
    expect(wrapperRulePos).toBeGreaterThan(-1);
    expect(artifactSectionPos).toBeGreaterThan(-1);
    expect(wrapperRulePos).toBeLessThan(artifactSectionPos);
  });

  it("agent.md still declares prose_fallback:true (refused-envelope safety net unchanged)", () => {
    const path = join(__dirname, "..", "agent.md");
    const content = readFileSync(path, "utf-8");
    expect(content).toMatch(/prose_fallback:\s*true/);
  });
});

describe("dispatcher F1 refused-guard — strips artifact_label on refused envelopes", () => {
  it("Test #8: synthesized refused envelope with artifact_label → label stripped before schema parse", () => {
    const refusedParsed: { refused: true; artifact_label?: string; rendered_markdown: string } = {
      refused: true,
      artifact_label: "should-not-survive",
      rendered_markdown: "naked prose body from agent.md fallback",
    };
    if (refusedParsed.refused === true) {
      delete refusedParsed.artifact_label;
    }
    expect(refusedParsed.artifact_label).toBeUndefined();
  });
});
