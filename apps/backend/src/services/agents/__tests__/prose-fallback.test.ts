import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("prose_fallback metadata flag — opt-in shape", () => {
  it("pm agent.md declares prose_fallback: true", () => {
    const src = readFileSync(
      join(__dirname, "../../../agents/pm/agent.md"),
      "utf-8",
    );
    expect(src).toMatch(/prose_fallback:\s*true/);
    expect(src).toMatch(/output_envelope:\s*product_pm_backlog/);
  });

  it("engineer agent.md declares prose_fallback: true", () => {
    const src = readFileSync(
      join(__dirname, "../../../agents/engineer/agent.md"),
      "utf-8",
    );
    expect(src).toMatch(/prose_fallback:\s*true/);
    expect(src).toMatch(/output_envelope:\s*pr_proposal/);
  });

  it("low-fail-rate agents do NOT have prose_fallback enabled (preserves strict contract)", () => {
    const slugs = [
      "dispute-response",
      "chief-of-staff",
      "performance-marketer",
    ];
    for (const slug of slugs) {
      const path = join(__dirname, `../../../agents/${slug}/agent.md`);
      const src = readFileSync(path, "utf-8");
      expect(src, `${slug}/agent.md should NOT declare prose_fallback`).not.toMatch(
        /prose_fallback:\s*true/,
      );
    }
  });
});

describe("generic-dispatcher prose-fallback branch — source guards", () => {
  const src = readFileSync(
    join(__dirname, "../generic-dispatcher.ts"),
    "utf-8",
  );

  it("synthesizes rendered_markdown + refused:true + parse_fallback_kind on no-envelope-match", () => {
    expect(src).toContain("no_envelope_block_prose_fallback");
    expect(src).toMatch(/refused:\s*true/);
  });

  it("opt-in condition reads from agent.metadata_praxis.prose_fallback", () => {
    expect(src).toContain("metadata_praxis.prose_fallback === true");
  });

  it("an email-triggered run falls back to prose, so the reply worker has an answer to mail", () => {
    expect(src).toMatch(/proseFallbackEnabled =[\s\S]{0,200}ctx\.trigger === "email"/);
    expect(src).toMatch(/proseFallbackEnabled =[\s\S]{0,250}ctx\.trigger === "slack"/);
  });

  it("preserves digest envelope backward-compat fallback", () => {
    expect(src).toContain('envelope === "digest"');
  });

  it("emits parsed progress event with distinct code for telemetry", () => {
    expect(src).toContain('"prose_fallback"');
    expect(src).toContain('"digest_fallback"');
  });

  it("agents WITHOUT prose_fallback still hit parse_failed on missing envelope", () => {
    expect(src).toMatch(
      /no <\$\{envelope\}>\.\.\.<\/\$\{envelope\}> block found/,
    );
    expect(src).toContain('"no_envelope_block"');
  });
});

describe("safety: side-effect-dispatcher schema revalidation guards emit", () => {
  const src = readFileSync(
    join(__dirname, "../../../agents/lib/side-effect-dispatcher.ts"),
    "utf-8",
  );

  it("schema revalidation runs before emit + skips on failure", () => {
    expect(src).toMatch(/opts\.schema\.safeParse\(result\.parsed\)/);
    expect(src).toMatch(/schema revalidation failed.+skipping emit/);
  });

  it("early-return when parse_ok is false (defensive)", () => {
    expect(src).toMatch(/!result\.parse_ok.*\|\|.*result\.parsed\s*==\s*null/);
  });
});

describe("safety: pm post-process guards A2A dispatch", () => {
  const src = readFileSync(
    join(__dirname, "../../../agents/pm/dispatcher.ts"),
    "utf-8",
  );

  it("safeParse against productPmBacklogSchema before dispatching", () => {
    expect(src).toContain("productPmBacklogSchema.safeParse");
    expect(src).toMatch(/envelope schema mismatch.*skipping post-run/);
  });
});

describe("AgentDefinitionMetadata Zod schema — prose_fallback field", () => {
  const src = readFileSync(
    join(__dirname, "../types.ts"),
    "utf-8",
  );

  it("declares prose_fallback as z.boolean().default(false)", () => {
    expect(src).toContain("prose_fallback");
    expect(src).toMatch(/prose_fallback:\s*z\.boolean\(\)\.default\(false\)/);
  });
});
