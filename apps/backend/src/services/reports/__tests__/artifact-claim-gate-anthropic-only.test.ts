
import { describe, it, expect, vi, beforeEach } from "vitest";

const criticCalls: Array<{ allowOpenAi: unknown }> = [];
let criticReturn: unknown = {
  verdict: "ok",
  findings: [],
  lanes: { anthropic: { status: "ok" }, openai: { status: "skipped" } },
  cost_usd: 0,
};

vi.mock("@/services/critic/reasoning-critic", () => ({
  runReasoningCritic: vi.fn(async (cfg: { allowOpenAi?: boolean }) => {
    criticCalls.push({ allowOpenAi: cfg.allowOpenAi });
    return criticReturn;
  }),
}));

let flagValue = false;
let flagThrows = false;
vi.mock("@/agents/pm/pm-critic-xfamily-flag", () => ({
  isPmCriticXfamilyEnabled: vi.fn(async () => {
    if (flagThrows) throw new Error("system_config outage");
    return flagValue;
  }),
}));

import { checkArtifactClaims } from "../artifact-claim-gate";

const surfaces = {
  title: "UpcarPrivate Host Referral Program",
  sectionText: ["The two programs deliberately share no infrastructure at v1."],
};
const base = {
  surfaces,
  claims: ["the two programs deliberately share no infrastructure"],
  tenantId: "11111111-1111-1111-1111-111111111111",
  runId: "run-1",
  agentSlug: "artifact_claim_gate",
};

beforeEach(() => {
  criticCalls.length = 0;
  flagValue = false;
  flagThrows = false;
  criticReturn = {
    verdict: "ok",
    findings: [],
    lanes: { anthropic: { status: "ok" }, openai: { status: "skipped" } },
    cost_usd: 0,
  };
});

describe("checkArtifactClaims — flag scopes the lane, not the feature", () => {
  it("THE FIX: flag OFF still REVIEWS, with the OpenAI lane disallowed", async () => {
    flagValue = false;
    await checkArtifactClaims(base);
    expect(criticCalls.length).toBe(1);
    expect(criticCalls[0].allowOpenAi).toBe(false);
  });

  it("flag ON allows the OpenAI lane", async () => {
    flagValue = true;
    await checkArtifactClaims(base);
    expect(criticCalls.length).toBe(1);
    expect(criticCalls[0].allowOpenAi).toBe(true);
  });

  it("a system_config OUTAGE degrades to Anthropic-only — it does not disable review", async () => {
    flagThrows = true;
    await checkArtifactClaims(base);
    expect(criticCalls.length).toBe(1);
    expect(criticCalls[0].allowOpenAi).toBe(false);
  });

  it("refuses on a real finding even when Anthropic is the ONLY lane", async () => {
    flagValue = false;
    criticReturn = {
      verdict: "revise",
      findings: [
        {
          claim: "the two programs deliberately share no infrastructure at v1",
          why: "No file or source cited anywhere in the document.",
          reviewer: "anthropic",
        },
      ],
      lanes: { anthropic: { status: "ok" }, openai: { status: "skipped" } },
      cost_usd: 0.001,
    };
    const r = await checkArtifactClaims(base);
    expect(r.verdict).toBe("refuse");
    expect(r.findings[0].claim).toContain("share no infrastructure");
  });

  it("no detected claims → no lanes fire (cost stays zero on ordinary PDFs)", async () => {
    const r = await checkArtifactClaims({ ...base, claims: [] });
    expect(criticCalls.length).toBe(0);
    expect(r.verdict).toBe("ok");
  });

  it("total lane outage renders anyway (fail-safe, never blocks a legit PDF)", async () => {
    criticReturn = {
      verdict: "ok",
      findings: [],
      lanes: {
        anthropic: { status: "unavailable", error: "boom", reason: "provider_error" },
        openai: { status: "skipped" },
      },
      cost_usd: 0,
    };
    const r = await checkArtifactClaims(base);
    expect(r.verdict).toBe("ok");
  });
});
