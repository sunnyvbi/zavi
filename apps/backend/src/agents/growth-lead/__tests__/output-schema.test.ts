import { describe, it, expect } from "vitest";

import { growthDigestSchema } from "../output-schema";
import { outputSchemas } from "../../index";

const GROWTH_CLUSTER = [
  "growth-lead",
  "performance-marketer",
] as const;

const TIERED_AGENTS = [
  "chief-of-staff",
  "qa",
] as const;

describe("growthDigestSchema (flat)", () => {
  it("accepts the prompt shape: { rendered_markdown }", () => {
    expect(growthDigestSchema.safeParse({ rendered_markdown: "## hi" }).success).toBe(true);
  });

  it("is tolerant — extra tier keys are stripped, not rejected", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "## hi",
      tier1: [{ anything: true }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).tier1).toBeUndefined();
  });

  it("still requires rendered_markdown (empty object fails)", () => {
    expect(growthDigestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts + retains the two-channel shape: { rendered_markdown, machine_digest }", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "Top move: fix activation.",
      machine_digest: "## Tier 1\nBet: shift spend\nLever: budget",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.machine_digest).toBe(
        "## Tier 1\nBet: shift spend\nLever: budget",
      );
      expect(r.data.rendered_markdown).toBe("Top move: fix activation.");
    }
  });

  it("digest_sections absent → parses identically (field is optional, undefined)", () => {
    const r = growthDigestSchema.safeParse({ rendered_markdown: "## hi" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.digest_sections).toBeUndefined();
  });

  it("digest_sections present (all 6) → validates + retained", () => {
    const sections = {
      weekly_summary: "spend up 10%",
      anomalies: "CTR dipped Tue",
      proposed_reallocation: "shift $40 meta → google",
      new_tests: "test new audience",
      risks: "frequency creeping",
      so_what_trend: "CAC trending down 3wk",
    };
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "## full digest",
      digest_sections: sections,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.digest_sections).toEqual(sections);
  });

  it("digest_sections partial subset (only weekly_summary) → validates (.partial())", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "## hi",
      digest_sections: { weekly_summary: "just this one" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.digest_sections?.weekly_summary).toBe("just this one");
      expect(r.data.digest_sections?.anomalies).toBeUndefined();
    }
  });

  it("digest_sections empty object → validates (every section optional)", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "## hi",
      digest_sections: {},
    });
    expect(r.success).toBe(true);
  });

  it("digest_sections with a non-string field → base digest STILL parses, field dropped", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "valid digest",
      machine_digest: "valid",
      digest_sections: { weekly_summary: null },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.digest_sections).toBeUndefined();
  });

  it("digest_sections with an over-long field → base digest parses (no .max rejection)", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "valid digest",
      digest_sections: { weekly_summary: "x".repeat(5000) },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.digest_sections?.weekly_summary?.length).toBe(5000);
    }
  });

  it("digest_sections of the wrong type (array) → dropped, base parses", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "valid digest",
      digest_sections: ["not", "an", "object"],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.digest_sections).toBeUndefined();
  });

  it("confidence + blind_spots present → validate + retained", () => {
    const sections = {
      confidence: "high — pixel + funnel grounded, coverage 41%",
      blind_spots: "TikTok not connected; verified coverage 9% (directional)",
    };
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "## full digest",
      digest_sections: sections,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.digest_sections?.confidence).toBe(sections.confidence);
      expect(r.data.digest_sections?.blind_spots).toBe(sections.blind_spots);
    }
  });

  it("a MALFORMED confidence/blind_spots degrades to undefined, never fails base parse", () => {
    const r = growthDigestSchema.safeParse({
      rendered_markdown: "valid digest",
      machine_digest: "valid",
      digest_sections: { weekly_summary: "ok", blind_spots: { not: "a string" } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.digest_sections).toBeUndefined();
  });
});

describe("growth cluster registry wiring", () => {
  it("every growth agent validates the bare prompt shape it actually emits", () => {
    for (const slug of GROWTH_CLUSTER) {
      const schema = outputSchemas[slug];
      expect(schema, `${slug} must be registered`).toBeDefined();
      expect(
        schema.safeParse({ rendered_markdown: "## digest" }).success,
        `${slug} must accept { rendered_markdown } — its prompt emits nothing else`,
      ).toBe(true);
    }
  });

  it("genuinely-tiered agents still reject a tier-less envelope (no over-flattening)", () => {
    for (const slug of TIERED_AGENTS) {
      const schema = outputSchemas[slug];
      expect(schema, `${slug} must be registered`).toBeDefined();
      expect(
        schema.safeParse({ rendered_markdown: "## digest" }).success,
        `${slug} must still require tier1-4`,
      ).toBe(false);
    }
  });
});
