
import { describe, expect, it } from "vitest";
import {
  AGENT_ROLEFIT_MODEL,
  DEFAULT_ROLEFIT_MODEL,
  rolefitModel,
} from "../agent-model-map";
import { AGENT_OUTPUT_CLASS } from "@/services/agents/structured-output";

const CODING = ["engineer", "qa"];
const REASONING = [
  "pm",
  "research",
  "growth-lead",
  "advisor",
  "chief-of-staff",
  "company-founder",
];
const THROUGHPUT = [
  "support-lead",
  "dispute-response",
  "social",
  "performance-marketer",
  "content-design",
  "outbound-sdr",
  "browser-operator",
];

describe("AGENT_ROLEFIT_MODEL", () => {
  it("covers all 15 fleet slugs (the 3 role groups, no extras)", () => {
    const expected = [...CODING, ...REASONING, ...THROUGHPUT].sort();
    expect(Object.keys(AGENT_ROLEFIT_MODEL).sort()).toEqual(expected);
    expect(Object.keys(AGENT_ROLEFIT_MODEL)).toHaveLength(15);
  });

  it("CODING agents → gpt-5.3-codex", () => {
    for (const slug of CODING) {
      expect(AGENT_ROLEFIT_MODEL[slug]).toBe("gpt-5.3-codex");
    }
  });

  it("REASONING/JUDGMENT agents → gpt-5.5-pro", () => {
    for (const slug of REASONING) {
      expect(AGENT_ROLEFIT_MODEL[slug]).toBe("gpt-5.5-pro");
    }
  });

  it("STRUCTURED/THROUGHPUT agents → gpt-5.5", () => {
    for (const slug of THROUGHPUT) {
      expect(AGENT_ROLEFIT_MODEL[slug]).toBe("gpt-5.5");
    }
  });

  it("every slug in the live AGENT_OUTPUT_CLASS roster has a role-fit model", () => {
    for (const slug of Object.keys(AGENT_OUTPUT_CLASS)) {
      expect(rolefitModel(slug)).toBeTruthy();
      expect(AGENT_ROLEFIT_MODEL[slug]).toBeDefined();
    }
  });
});

describe("rolefitModel()", () => {
  it("returns the mapped model for a known slug", () => {
    expect(rolefitModel("engineer")).toBe("gpt-5.3-codex");
    expect(rolefitModel("pm")).toBe("gpt-5.5-pro");
    expect(rolefitModel("support-lead")).toBe("gpt-5.5");
  });

  it("defaults an unknown slug to the throughput flagship", () => {
    expect(rolefitModel("not-a-real-agent")).toBe(DEFAULT_ROLEFIT_MODEL);
    expect(rolefitModel("not-a-real-agent")).toBe("gpt-5.5");
  });
});
