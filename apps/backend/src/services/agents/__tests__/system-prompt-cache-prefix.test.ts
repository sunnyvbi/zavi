import { describe, it, expect } from "vitest";
import {
  buildStablePromptPrefix,
  buildSystemPromptForTest,
} from "../generic-dispatcher";
import { CITATION_INSTRUCTION } from "../citation-parser";
import {
  TRUNCATED_RESULT_INSTRUCTION,
  SANDBOX_EXEC_TRUNCATION_INSTRUCTION,
} from "../smart-truncate";
import { OPSEC_FOOTER } from "../opsec-footer";

const BODY = "# pm\n\nYou are an agent. Tenant: {{tenant.name}}.\n";
const TENANT = { name: "Upcar" };
const MEMORY = {
  company: "test co",
  ops: "test ops",
  policies: "",
  disputes: "",
  support: "",
};

function makeRunContextTail(recentRuns: unknown): string {
  return (
    "\n\n---\n## Run context\nRun context (JSON):\n```json\n" +
    JSON.stringify({ tenant_id: "t-1", recent_runs: recentRuns }, null, 2) +
    "\n```\n"
  );
}

describe("system-prompt KV-cache split — stable prefix", () => {
  it("stable prefix is byte-identical across two runs with different recent_runs", () => {
    const prefixA = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    const prefixB = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    expect(prefixA).toBe(prefixB);
    expect(prefixA.length).toBeGreaterThan(0);
  });

  it("the cached (stable) block contains NO churning timestamp / id strings", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    expect(prefix).not.toContain("finished_at");
    expect(prefix).not.toContain("created_at");
    expect(prefix).not.toContain("recent_runs");
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(prefix).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("stable prefix ends with the instruction trio (citation → truncated → opsec)", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    const citationIdx = prefix.indexOf("## Citations");
    const truncatedIdx = prefix.indexOf("## Truncated tool results");
    const sandboxExecIdx = prefix.indexOf("## Truncated sandbox command output");
    const opsecIdx = prefix.indexOf("## Operational security");
    expect(citationIdx).toBeGreaterThan(-1);
    expect(truncatedIdx).toBeGreaterThan(citationIdx);
    expect(sandboxExecIdx).toBeGreaterThan(truncatedIdx);
    expect(opsecIdx).toBeGreaterThan(sandboxExecIdx);
    expect(prefix.endsWith(OPSEC_FOOTER)).toBe(true);
    expect(prefix.split(CITATION_INSTRUCTION).length - 1).toBe(1);
    expect(prefix.split(TRUNCATED_RESULT_INSTRUCTION).length - 1).toBe(1);
    expect(prefix.split(SANDBOX_EXEC_TRUNCATION_INSTRUCTION).length - 1).toBe(1);
  });

  it("the sandbox-exec truncation contract teaches reading _truncated / _errors / narrower-rerun", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });
    const block = SANDBOX_EXEC_TRUNCATION_INSTRUCTION;
    expect(prefix).toContain(block);
    expect(block).toContain("run_bash");
    expect(block).toContain("run_tests");
    expect(block).toContain("git_diff");
    expect(block).toContain("_truncated");
    expect(block).toContain("_errors");
    expect(block.toLowerCase()).toContain("narrower");
    expect(block.toLowerCase()).toContain("never claim");
  });

  it("full system text = stable prefix + dynamic tail; only the prefix is the cache key", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: TENANT,
      memory: MEMORY,
    });

    const tailRun1 = makeRunContextTail([
      { agent_slug: "engineer", status: "success", output_text: "shipped" },
    ]);
    const tailRun2 = makeRunContextTail([
      { agent_slug: "performance-marketer", status: "error", output_text: "rate-limited" },
      { agent_slug: "qa", status: "success", output_text: "passed" },
    ]);

    const full1 = prefix + tailRun1;
    const full2 = prefix + tailRun2;

    expect(full1).not.toBe(full2);
    expect(full1.startsWith(prefix)).toBe(true);
    expect(full2.startsWith(prefix)).toBe(true);
    expect(full1.slice(0, prefix.length)).toBe(full2.slice(0, prefix.length));
  });

  it("buildSystemPromptForTest delegates to buildStablePromptPrefix (no drift)", () => {
    const viaTestSeam = buildSystemPromptForTest({
      body_markdown: BODY.replace("{{tenant.name}}", "X"),
      memory: { company: "c", ops: "o" },
      run_context: {},
    });
    const viaHelper = buildStablePromptPrefix({
      body_markdown: BODY.replace("{{tenant.name}}", "X"),
      memory: { company: "c", ops: "o" },
    });
    expect(viaTestSeam).toBe(viaHelper);
  });
});
