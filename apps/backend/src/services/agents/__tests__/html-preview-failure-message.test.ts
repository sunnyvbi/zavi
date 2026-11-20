import { describe, it, expect } from "vitest";
import {
  HTML_PREVIEW_FAILURE_REASONS,
  htmlPreviewFailureMessage,
} from "../html-preview-artifacts";

const CANNED =
  "The preview was not displayed, so I did not build or open a PR. Ask me to retry the preview.";

describe("BUG 8 — a failed preview says which failure it was", () => {
  it("gives every reason its OWN sentence", () => {
    const messages = HTML_PREVIEW_FAILURE_REASONS.map((r) => htmlPreviewFailureMessage(r));
    expect(new Set(messages).size).toBe(HTML_PREVIEW_FAILURE_REASONS.length);
  });

  it("never emits the old canned string", () => {
    for (const r of HTML_PREVIEW_FAILURE_REASONS) {
      expect(htmlPreviewFailureMessage(r)).not.toBe(CANNED);
    }
  });

  it("names the specific reason from the run that shipped", () => {
    expect(htmlPreviewFailureMessage("artifact_missing")).toMatch(
      /written but could not be found/i,
    );
    expect(htmlPreviewFailureMessage("truncated_response")).toMatch(/cut off/i);
    expect(htmlPreviewFailureMessage("artifact_unsafe")).toMatch(/safety check/i);
  });

  it("stays honest about what did NOT happen", () => {
    for (const r of HTML_PREVIEW_FAILURE_REASONS) {
      const m = htmlPreviewFailureMessage(r);
      expect(m).toMatch(/not built anything or opened a PR/i);
      expect(m).toMatch(/retry/i);
    }
  });
});

describe("BUG 8 — the model's own work is no longer thrown away", () => {
  it("PRESERVES the prose the model already wrote", () => {
    const prose =
      "## Pricing page\n\nThree tiers, a comparison table, and a 10-colour palette anchored on #0e0f11.";
    const out = htmlPreviewFailureMessage("artifact_missing", prose);
    expect(out).toContain(prose);
    expect(out).toMatch(/What I had written before it failed/);
  });

  it("but the FAILURE leads, so a confident prose opener cannot read as success", () => {
    const misleading = "Here is your pricing page. The preview is ready and the page is live.";
    const out = htmlPreviewFailureMessage("artifact_missing", misleading);
    expect(out.startsWith("I could not show the preview")).toBe(true);
    expect(out.indexOf("could not show")).toBeLessThan(out.indexOf("is ready"));
  });

  it("falls back to the note alone when there is no prose to keep", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const out = htmlPreviewFailureMessage("artifact_empty", empty);
      expect(out).toMatch(/^I could not show the preview/);
    }
  });
});
