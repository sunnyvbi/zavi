
import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  type CompletenessGate,
} from "@/services/agents/gate-completeness";
import { isEgressToolName } from "../tool-capability";

const EGRESS_MEMBERS = [
  "web_fetch__fetch",
  "web_search__search",
  "apify__rag_web_browser",
  "competitor_intel__http_fetch",
  "pipedream_apollo__fetch",
  "composio__APOLLO_ENRICH",
  "acmeproxy__http_request",
];

const NON_EGRESS_EXCLUSIONS: Record<string, string> = {
  "operator_db__query_user": "first-party internal read — no off-platform egress",
  "memory__search": "first-party internal memory read — no egress",
  "stripe__list_charges": "first-party internal connector read — no open-web egress",
  "slack__get_channel_history": "first-party internal read — no open-web egress",
  "github__read_file": "first-party internal read — no open-web egress",
  "praxis__handoff": "internal delegation — no off-platform egress",
  "product__probe": "SAME-TENANT-only probe (dest re-derived server-side) — not open-web egress",
  "memory__write": "first-party internal write — governed by the write boundary, not egress",
};

function buildEgressGate(): CompletenessGate {
  return {
    name: "EGRESS_CLASSIFICATION (services/mcp/tool-capability.ts isEgressToolName)",
    enumerateSubjects: () => [...EGRESS_MEMBERS, ...Object.keys(NON_EGRESS_EXCLUSIONS)],
    classify: (subject) => (isEgressToolName(subject) ? "in-set" : "reasoned-exclude"),
    reasonedExclusions: NON_EGRESS_EXCLUSIONS,
  };
}

describe("egress classification completeness (anti-drift for #7/#8)", () => {
  it("every expected-egress tool still classifies as egress (no silent under-coverage)", () => {
    const ev = evaluateGate(buildEgressGate());
    expect(
      ev.uncovered,
      ev.uncovered.length === 0
        ? ""
        : `EGRESS DRIFT — these tools are NO LONGER classified as egress AND are ` +
            `not documented non-egress exclusions. Each has silently fallen out of ` +
            `the untrusted-inbound kill + the outbound secret-scrubber:\n` +
            ev.uncovered.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });

  it("no misleading exclusion — a documented non-egress tool did not become egress", () => {
    const ev = evaluateGate(buildEgressGate());
    expect(
      ev.misleadingExclusions,
      ev.misleadingExclusions.length === 0
        ? ""
        : `EGRESS DRIFT — these are documented as NON-egress but the predicate now ` +
            `classifies them as egress (over-classification / heuristic too broad):\n` +
            ev.misleadingExclusions.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });

  it("no blank exclusion reasons", () => {
    expect(evaluateGate(buildEgressGate()).blankExclusions).toEqual([]);
  });

  it("sanity — the roster covers both sides non-trivially", () => {
    expect(EGRESS_MEMBERS.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(NON_EGRESS_EXCLUSIONS).length).toBeGreaterThanOrEqual(5);
  });
});
