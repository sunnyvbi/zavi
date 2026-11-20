
import { describe, it, expect } from "vitest";
import { assertsNegativeExistenceArtifact, type DistillArtifact } from "../distill";
import { hasReadFileBudgetRefusal } from "@/services/agents/unverified-absence-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

const ref = (title: string, body: string): DistillArtifact =>
  ({ note_type: "tenant_reference", title, body_markdown: body }) as DistillArtifact;

describe("hasReadFileBudgetRefusal (the distill evidence gate)", () => {
  const refused: ToolCallTrace[] = [
    {
      name: "github__read_file",
      input_preview: '{"path":"apps/web/components/Analytics/Analytics.tsx"}',
      output_preview: "BUDGET EXHAUSTED: `github__read_file` has been called 12 times this run (cap: 12).",
      ms: 0,
      status: "tool_error",
    },
  ];
  it("true when a github__read_file was budget-refused", () => {
    expect(hasReadFileBudgetRefusal(refused)).toBe(true);
  });
  it("false for a clean run (no refusal marker) — a non-truncated run is NOT gated", () => {
    const clean: ToolCallTrace[] = [
      { name: "github__read_file", input_preview: "{}", output_preview: '{"content":"..."}', ms: 0, status: "ok" },
      { name: "github__list_open_prs", input_preview: "{}", output_preview: '{"total":0,"items":[]}', ms: 0, status: "ok" },
    ];
    expect(hasReadFileBudgetRefusal(clean)).toBe(false);
  });
  it("false for a SEARCH-cap burnout (not a refused FILE read)", () => {
    const searchBurn: ToolCallTrace[] = [
      { name: "github__search_code", input_preview: "{}", output_preview: "BUDGET EXHAUSTED: `github__search_code` ...", ms: 0, status: "tool_error" },
    ];
    expect(hasReadFileBudgetRefusal(searchBurn)).toBe(false);
  });
});

describe("assertsNegativeExistenceArtifact", () => {
  it("ANCHOR: catches 'no Google Analytics or GTM' — the class the old CODE-noun guard missed", () => {
    expect(
      assertsNegativeExistenceArtifact(
        ref("Upcar analytics stack", "The rravi149/upcar repo has no Google Analytics or GTM configured; PostHog is the analytics layer."),
      ),
    ).toBe(true);
  });
  it("catches 'X does not exist' / 'not configured' / 'zero hits'", () => {
    expect(assertsNegativeExistenceArtifact(ref("t", "The webhook endpoint does not exist."))).toBe(true);
    expect(assertsNegativeExistenceArtifact(ref("t", "Sentry is not configured on this project."))).toBe(true);
    expect(assertsNegativeExistenceArtifact(ref("t", "Five searches returned zero hits."))).toBe(true);
  });
  it("does NOT fire on a positive fact (a real business note)", () => {
    expect(
      assertsNegativeExistenceArtifact(ref("Take-rate", "Blended take-rate is 14.1% for the week; GA4 is wired via Analytics.tsx.")),
    ).toBe(false);
  });
  it("does NOT fire on a non-durable note type (episodic/other)", () => {
    const episodic = { note_type: "episode", title: "t", body_markdown: "no GA found" } as unknown as DistillArtifact;
    expect(assertsNegativeExistenceArtifact(episodic)).toBe(false);
  });
});

describe("distill truncation-drop semantics (readTruncated && assertsNegativeExistence)", () => {
  const refused: ToolCallTrace[] = [
    { name: "github__read_file", input_preview: "{}", output_preview: "BUDGET EXHAUSTED: `github__read_file` ...", ms: 0, status: "tool_error" },
  ];
  const clean: ToolCallTrace[] = [
    { name: "github__read_file", input_preview: "{}", output_preview: '{"content":"..."}', ms: 0, status: "ok" },
  ];
  const gaAbsence = ref("Upcar analytics", "Upcar has no Google Analytics configured.");
  const legitAbsence = ref("PR state", "There are no open PRs on the upcar repo right now.");

  const wouldDrop = (a: DistillArtifact, tc: ToolCallTrace[]) =>
    hasReadFileBudgetRefusal(tc) && assertsNegativeExistenceArtifact(a);

  it("DROPS the false GA absence from a read-truncated run (the anchor)", () => {
    expect(wouldDrop(gaAbsence, refused)).toBe(true);
  });
  it("KEEPS the same GA claim on a NON-truncated run (evidence gate protects it)", () => {
    expect(wouldDrop(gaAbsence, clean)).toBe(false);
  });
  it("KEEPS a legitimate absence ('no open PRs') even on a truncated run IF... it still asserts absence", () => {
    expect(wouldDrop(legitAbsence, refused)).toBe(true);
    expect(wouldDrop(legitAbsence, clean)).toBe(false);
  });
});
