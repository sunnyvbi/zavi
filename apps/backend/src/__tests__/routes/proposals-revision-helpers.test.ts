import { describe, expect, it } from "vitest";
import {
  classifyRevisionResolution,
  pickRevisionReplacement,
  REVISION_STALE_MS,
} from "../../routes/agents/proposals";

const baseRevision = {
  id: "rev-1",
  decision_id: "decision-1",
  agent_run_id: "run-1",
  thread_id: null,
  status: "running",
  message: "change it",
  original_decision_class: "meta_ads.update_ad_set_budget_review",
  original_handler: "meta_ads.update_ad_set_budget_review",
  original_body: { ad_set_id: "adset-1", daily_budget_usd: 144 },
  assistant_text: null,
  replacement_decision_id: null,
  last_error: null,
  created_at: "2026-06-06T12:00:00.000Z",
};

describe("proposal revision helpers", () => {
  it("picks same-target replacement before single-fallback, and refuses ambiguous multi-emit", () => {
    const sameTarget = {
      id: "same",
      agent_run_id: "run-1",
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: { ad_set_id: "adset-1", daily_budget_usd: 90 },
      status: "proposed",
      emitted_at: "2026-06-06T12:01:00.000Z",
    };
    const other = {
      id: "other",
      agent_run_id: "run-1",
      decision_class: "meta_ads.set_status_review",
      body: { object_id: "campaign-1", status: "PAUSED" },
      status: "proposed",
      emitted_at: "2026-06-06T12:01:01.000Z",
    };

    expect(pickRevisionReplacement(baseRevision, [other, sameTarget])?.id).toBe("same");
    expect(pickRevisionReplacement(baseRevision, [other])?.id).toBe("other");
    expect(pickRevisionReplacement(baseRevision, [other, { ...other, id: "third" }])).toBeNull();
  });

  it("marks stale active revisions failed by wall-clock timeout", () => {
    const now = new Date(baseRevision.created_at).getTime() + REVISION_STALE_MS + 1;
    expect(classifyRevisionResolution(baseRevision, undefined, [], now)).toEqual({
      kind: "stale_failed",
      last_error: "Revision request timed out. You can approve the original or ask again.",
    });
  });

  it("checks replacement before stale timeout so late replacements self-heal", () => {
    const now = new Date(baseRevision.created_at).getTime() + REVISION_STALE_MS + 1;
    const replacement = {
      id: "replacement",
      agent_run_id: "run-1",
      decision_class: "meta_ads.set_status_review",
      body: { object_id: "campaign-1", status: "PAUSED" },
      status: "proposed",
      emitted_at: "2026-06-06T12:11:00.000Z",
    };
    expect(classifyRevisionResolution(baseRevision, undefined, [replacement], now)).toEqual({
      kind: "replacement",
      replacement,
    });
  });
});
