import { describe, it, expect } from "vitest";
import { runGroundingChecks, type ToolCallLite } from "../grounding-checks";
import { TRUNCATED_SCOPE_DOMAIN_AGENTS } from "../../guard-domains";

const escapedPreview = (payload: unknown): string =>
  JSON.stringify([{ type: "text", text: JSON.stringify(payload) }]);

const metaPayload = (returned: number, total: number) => ({
  campaigns: Array.from({ length: returned }, (_, i) => ({
    campaign_id: `12026038987883005${i}`,
    campaign_name: `Campaign ${i}`,
    spend_usd: 77.4,
  })),
  _truncated: true,
  _returned: returned,
  _total: total,
  _dropped_identity: Array.from({ length: total - returned }, (_, i) => ({
    id: `d${i}`,
    name: `Old ${i}`,
  })),
});

const truncatedList = (returned: number, total: number): ToolCallLite => ({
  name: "mcp__server__meta_ads__list_campaigns",
  status: "success",
  input: JSON.stringify({ date_preset: "last_7d", status: "ALL" }),
  output: escapedPreview(metaPayload(returned, total)),
});

const flagsOf = (output: string, evidence: ToolCallLite[]) =>
  runGroundingChecks({
    input: "give me exact per-campaign numbers for a board update",
    evidence,
    agent_output: output,
    agentSlug: "performance-marketer",
    checkTruncatedScope: true,
  }).flags.filter((f) => f.pattern === "truncated_scope_overclaim");

describe("C10 — the check is actually reachable in production", () => {
  it("arms the agent that shipped the bug", () => {
    expect(TRUNCATED_SCOPE_DOMAIN_AGENTS.has("performance-marketer")).toBe(true);
  });

  it("detects the truncation envelope in the ESCAPED shape prod actually stores", () => {
    const preview = truncatedList(2, 21).output!;
    expect(preview).toContain('\\"_truncated\\":true');
    expect(/"_truncated"\s*:\s*true/.test(preview)).toBe(false);
    expect(flagsOf("The 19 others are all paused.", [truncatedList(2, 21)])).toHaveLength(1);
  });

  it("still works on an unescaped payload (belt and braces)", () => {
    const raw: ToolCallLite = {
      name: "meta_ads__list_campaigns",
      status: "success",
      output: JSON.stringify(metaPayload(2, 21)),
    };
    expect(flagsOf("The 19 others are all paused.", [raw])).toHaveLength(1);
  });
});

describe("C10 — fires on the claim that shipped", () => {
  it("flags invented status for the unseen rows", () => {
    const reply =
      "Here are the campaigns.\n\n**Total | $154.81 | 5,270 | 400**\n\n" +
      "The 19 others (older campaigns from April to August, all paused) are listed in the account " +
      "but had no delivery in this window per the Meta insights endpoint.";

    const flags = flagsOf(reply, [truncatedList(2, 21)]);

    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("hard");
    expect(flags[0].detail).toContain("19 rows");
    expect(flags[0].detail).toContain("_returned 2 of _total 21");
  });

  it("is not defeated by a one-word rewording", () => {
    for (const reply of [
      "The rest are paused.",
      "All others are paused.",
      "The other 19 are paused.",
      "The remaining 19 had no delivery.",
      "The others were paused for the whole window.",
    ]) {
      expect(flagsOf(reply, [truncatedList(2, 21)]), reply).toHaveLength(1);
    }
  });

  it("fires even when the reply DID disclose the scope", () => {
    const reply = "Showing the first 2 of 21 campaigns. The 19 others are all paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(1);
  });
});

describe("C10 — does not punish correct behaviour", () => {
  it("stays clean when the reply abstains honestly", () => {
    const reply =
      "Showing the first 2 of 21 campaigns — the list was capped. " +
      "The 19 others were not returned, so I can't tell you their status without paginating.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("stays clean when it merely COUNTS the unseen rows", () => {
    const reply = "There are 19 others beyond this page. Want me to paginate?";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("does not flag a state claim about the rows it DID receive", () => {
    const reply = "There are 19 others beyond this page; the 2 returned campaigns are paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("does not flag the agent QUOTING someone else's claim", () => {
    const reply = 'You wrote: "The 19 others are all paused." I cannot verify that without paginating.';
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("does not flag once the agent actually paginated and saw every row", () => {
    const paginated: ToolCallLite = {
      name: "mcp__server__meta_ads__list_campaigns",
      status: "success",
      output: escapedPreview({ campaigns: [], _returned: 21, _total: 21 }),
    };
    const reply = "The 19 others are all paused.";
    expect(flagsOf(reply, [truncatedList(2, 21), paginated])).toHaveLength(0);
  });

  it("does not fire when nothing was truncated", () => {
    const complete: ToolCallLite = {
      name: "meta_ads__list_campaigns",
      status: "success",
      output: escapedPreview({ campaigns: [], _returned: 21, _total: 21 }),
    };
    expect(flagsOf("The 19 others are all paused.", [complete])).toHaveLength(0);
  });

  it("does not fire when the number is not the unseen count", () => {
    const reply = "The 5 others in the brand group are all paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("stays OFF for an agent outside the domain set", () => {
    const flags = runGroundingChecks({
      evidence: [truncatedList(2, 21)],
      agent_output: "The 19 others are all paused.",
      agentSlug: "engineer",
    }).flags.filter((f) => f.pattern === "truncated_scope_overclaim");
    expect(flags).toHaveLength(0);
  });
});

describe("C10 — the coverage exemption cannot be switched off by a coincidence", () => {
  const unrelatedTool = (total: number): ToolCallLite => ({
    name: "mcp__server__stripe__list_charges",
    status: "success",
    output: escapedPreview({ charges: [], _returned: total, _total: total }),
  });

  it("an UNRELATED later tool with the same _total does NOT suppress the flag", () => {
    const flags = flagsOf("The 19 others are all paused.", [
      truncatedList(2, 21),
      unrelatedTool(21),
    ]);
    expect(flags).toHaveLength(1);
  });

  it("a same-tool call EARLIER in the run does not count as coverage", () => {
    const earlierFull: ToolCallLite = {
      name: "mcp__server__meta_ads__list_campaigns",
      status: "success",
      output: escapedPreview({ campaigns: [], _returned: 21, _total: 21 }),
    };
    const flags = flagsOf("The 19 others are all paused.", [earlierFull, truncatedList(2, 21)]);
    expect(flags).toHaveLength(1);
  });

  it("a FAILED later same-tool call does not count as coverage", () => {
    const failed: ToolCallLite = {
      name: "mcp__server__meta_ads__list_campaigns",
      status: "error",
      output: escapedPreview({ _returned: 21, _total: 21 }),
    };
    expect(flagsOf("The 19 others are all paused.", [truncatedList(2, 21), failed])).toHaveLength(1);
  });
});

describe("C10 — clause-boundary handling", () => {
  it("splits on a semicolon with NO trailing space", () => {
    const reply = "There are 19 others beyond this page;the 2 returned campaigns are paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("does not match an 'others are' fragment scoped to the returned rows", () => {
    const reply = "For the 2 returned campaigns, the others are paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(0);
  });

  it("still catches a bare clause-initial 'the others are' over-claim", () => {
    expect(flagsOf("The others are paused.", [truncatedList(2, 21)])).toHaveLength(1);
  });
});

describe("C10 — the suppression must not swallow a real over-claim", () => {
  it("still fires when the reply mentions the returned COUNT in passing", () => {
    const reply = "Only 2 campaign records came back, but the rest are paused.";
    expect(flagsOf(reply, [truncatedList(2, 21)])).toHaveLength(1);
  });

  it("still suppresses the genuinely returned-scoped clause", () => {
    expect(
      flagsOf("For the 2 returned campaigns, the others are paused.", [truncatedList(2, 21)]),
    ).toHaveLength(0);
  });
});
