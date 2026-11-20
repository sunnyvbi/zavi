import { describe, it, expect, afterEach } from "vitest";
import {
  MCP_FANOUT_LINE,
  mcpFollowLine,
  hasInflightHandoffClaim,
  hasWorkUnderwayClaim,
  reconcileSideEffectClaims,
  reconcilerModeFromEnv,
  removeClaimSentences,
} from "../side-effect-claim-reconciler";

const CLAIM = "Dispatched to engineer: **tutor-noshow-endpoint**.\n\n1 action sent to engineer.";
const TRUTHFUL_PARSED = { dispatched_actions: [{ item_id: "x" }] };
const DROPPED_PARSED = { dispatched_actions: [] };

describe("side-effect-claim reconciler — dispatch adapter", () => {
  it("rewrite: claimed dispatch but 0 recorded → removes the claim sentences, no banner (case #1)", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: DROPPED_PARSED },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.mismatch?.actual).toBe(0);
    expect(r.removed_sentences).toBe(2);
    expect(r.text).toBe("No changes were made.");
    expect(r.text).not.toMatch(/⚠|Correction/);
  });

  it("rewrite: keeps the rest of the reply when only one sentence is the claim", () => {
    const text = "The pricing page has two bugs.\n\nDispatched to engineer: **pricing-fix**.\n\nNext I will check the checkout flow.";
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: text, parsed: DROPPED_PARSED },
      "rewrite",
    );
    expect(r.text).toBe("The pricing page has two bugs.\n\nNext I will check the checkout flow.");
  });

  it("log: detects mismatch but does NOT mutate text", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: DROPPED_PARSED },
      "log",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.text).toBe(CLAIM);
  });

  it("happy path: claimed dispatch AND 1 recorded → byte-unchanged, no mismatch", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: TRUTHFUL_PARSED },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(CLAIM);
  });

  it("no dispatch claim → untouched even with 0 recorded", () => {
    const prose = "Here is your RICE-ranked backlog. Nothing was sent anywhere.";
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: prose, parsed: DROPPED_PARSED },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(prose);
  });

  it("off mode → never touches anything", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: DROPPED_PARSED },
      "off",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(CLAIM);
  });

  it("agent not in applies_to (e.g. research) → no-op", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "research", output_text: CLAIM, parsed: DROPPED_PARSED },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(CLAIM);
  });

  it("future/conditional dispatch language does NOT trip (tight detector)", () => {
    const prose = "I would dispatch the engineer, but I can recommend the fix instead.";
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: prose, parsed: DROPPED_PARSED },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(prose);
  });

  it("null/non-object parsed treated as 0 recorded → mismatch on a claim", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.actual).toBe(0);
  });
});

describe("reconcilerModeFromEnv — default flipped to rewrite (go-live 2026-06-08)", () => {
  const orig = process.env.SIDE_EFFECT_CLAIM_GUARD_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.SIDE_EFFECT_CLAIM_GUARD_MODE;
    else process.env.SIDE_EFFECT_CLAIM_GUARD_MODE = orig;
  });
  it("env unset → rewrite (live auto-correct)", () => {
    delete process.env.SIDE_EFFECT_CLAIM_GUARD_MODE;
    expect(reconcilerModeFromEnv()).toBe("rewrite");
  });
  it("env=log → log (shadow dial-back)", () => {
    process.env.SIDE_EFFECT_CLAIM_GUARD_MODE = "log";
    expect(reconcilerModeFromEnv()).toBe("log");
  });
  it("env=off → off (inert dial-back)", () => {
    process.env.SIDE_EFFECT_CLAIM_GUARD_MODE = "off";
    expect(reconcilerModeFromEnv()).toBe("off");
  });
  it("env=garbage → rewrite (fail to live default)", () => {
    process.env.SIDE_EFFECT_CLAIM_GUARD_MODE = "banana";
    expect(reconcilerModeFromEnv()).toBe("rewrite");
  });
});

describe("operator — successful handoff tool_calls are the truth source (no envelope BY DESIGN)", () => {
  const OPERATOR_CLAIM = "Handed off to the engineer — they'll pick it up from here.";

  it("truthful operator handoff (successful praxis__handoff) → byte-unchanged", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: OPERATOR_CLAIM,
        parsed: { rendered_markdown: OPERATOR_CLAIM },
        tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(OPERATOR_CLAIM);
  });

  it("SDK-prefixed trace name (mcp__praxis__handoff) also counts", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: OPERATOR_CLAIM,
        parsed: null,
        tool_calls: [{ name: "mcp__praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("handoff_parallel + action also count as real dispatches", () => {
    for (const name of ["praxis__handoff_parallel", "praxis__action"]) {
      const r = reconcileSideEffectClaims(
        {
          agent_slug: "operator",
          output_text: "1 action sent to engineer.",
          parsed: null,
          tool_calls: [{ name, status: "ok" }],
        },
        "rewrite",
      );
      expect(r.corrected).toBe(false);
    }
  });

  it("FAILED handoff (tool_error) does NOT count → banner still protects", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: OPERATOR_CLAIM,
        parsed: null,
        tool_calls: [
          { name: "praxis__handoff", status: "tool_error" },
          { name: "memory__search", status: "ok" },
        ],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("operator claims dispatch with NO tool calls at all → still corrected", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: OPERATOR_CLAIM, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.actual).toBe(0);
  });

  it("pm empty envelope + a successful praxis__handoff is NO LONGER masked (Slice 4)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "pm",
        output_text: CLAIM,
        parsed: { dispatched_actions: [] },
        tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(CLAIM);
  });

  it("pm empty envelope + ZERO dispatch tool calls → correction STILL fires (Slice 4)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "pm",
        output_text: CLAIM,
        parsed: { dispatched_actions: [] },
        tool_calls: [{ name: "memory__search", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("pm NON-EMPTY envelope stays authoritative (max picks the populated array)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "pm",
        output_text: CLAIM,
        parsed: { dispatched_actions: [{ item_id: "x" }] },
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(CLAIM);
  });

  it("operator (absent envelope) unchanged — successful handoff still counts", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Handed off to the engineer — they'll pick it up.",
        parsed: null,
        tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });
});

describe("dispatch detector — softer 'queued' phrasing (real prod prose 2026-06-08)", () => {
  const QUEUED = "## Dispatched\n- 1 action queued for engineer (`tutor-noshow-endpoint`) — **will not execute until** a repo is connected.";
  it("rewrite: '1 action queued for engineer' + 0 recorded → corrected", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: QUEUED, parsed: { dispatched_actions: [] } },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
  });
  it("happy path: '1 action queued for engineer' WITH 1 recorded → unchanged", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: QUEUED, parsed: { dispatched_actions: [{ x: 1 }] } },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(QUEUED);
  });
  it("conditional 'would queue it for the engineer' does NOT trip", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: "I would queue it for the engineer if you connect a repo.", parsed: { dispatched_actions: [] } },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
  });
});

describe("side-effect-claim reconciler — email-sent adapter (shadow)", () => {
  const EMAIL_CLAIM = "I've sent you an email with the full breakdown.";

  it("SHADOW: global mode=rewrite but adapter forces log — detects, does NOT rewrite", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "chief-of-staff", output_text: EMAIL_CLAIM, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("email_sent");
    expect(r.mismatch?.actual).toBe(0);
    expect(r.text).toBe(EMAIL_CLAIM);
  });

  it("SHADOW under explicit log mode too (no behavior difference, just confirms it still fires)", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "advisor", output_text: "Emailed the summary to your CFO.", parsed: null },
      "log",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("email_sent");
  });

  it("truthful: a real successful email__send tool call → byte-unchanged, no mismatch", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "chief-of-staff",
        output_text: EMAIL_CLAIM,
        parsed: null,
        tool_calls: [{ name: "email__send", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(EMAIL_CLAIM);
  });

  it("SDK-prefixed trace name (mcp__email__send) also counts as truthful", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Email sent.",
        parsed: null,
        tool_calls: [{ name: "mcp__email__send", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("a successful outbound__propose_email does NOT count as a completed send (proposal ≠ sent)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: EMAIL_CLAIM,
        parsed: null,
        tool_calls: [{ name: "outbound__propose_email", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("email_sent");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("a FAILED email__send (tool_error) does not count as truth either", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "advisor",
        output_text: "Emailed you the report.",
        parsed: null,
        tool_calls: [{ name: "email__send", status: "tool_error" }],
      },
      "rewrite",
    );
    expect(r.mismatch?.claim_type).toBe("email_sent");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("future/conditional email language does NOT trip the detector", () => {
    const prose = "I'll email you this once you confirm the recipient — want me to send it?";
    const r = reconcileSideEffectClaims(
      { agent_slug: "chief-of-staff", output_text: prose, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(prose);
  });

  it("advisor's own sanctioned 'queued to email' acknowledgement does NOT trip (not a completed claim)", () => {
    const prose = "(Queued the summary to email. Approve it below to send.)";
    const r = reconcileSideEffectClaims(
      { agent_slug: "advisor", output_text: prose, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("agent not in applies_to (e.g. pm) → no-op even on a completed-claim phrase", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: EMAIL_CLAIM, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("off mode → never touches anything, even a completed claim", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: EMAIL_CLAIM, parsed: null },
      "off",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(EMAIL_CLAIM);
  });
});

describe("side-effect-claim reconciler — slack-posted adapter (shadow)", () => {
  const SLACK_CLAIM = "Sent — DM'd Jemis about the ranking drop.";

  it("SHADOW: global mode=rewrite but adapter forces log — detects, does NOT rewrite", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "growth-lead", output_text: SLACK_CLAIM, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("slack_posted");
    expect(r.mismatch?.actual).toBe(0);
    expect(r.text).toBe(SLACK_CLAIM);
  });

  it("truthful: a real successful slack__post_message tool call → byte-unchanged, no mismatch", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "growth-lead",
        output_text: SLACK_CLAIM,
        parsed: null,
        tool_calls: [{ name: "slack__post_message", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(SLACK_CLAIM);
  });

  it("truthful via slack__upload_file (delivering a file also counts)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "growth-lead",
        output_text: "Posted the report to #growth-rental.",
        parsed: null,
        tool_calls: [{ name: "slack__upload_file", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("slack__open_dm alone does NOT count as truth (opening a DM channel ≠ posting a message)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "growth-lead",
        output_text: SLACK_CLAIM,
        parsed: null,
        tool_calls: [{ name: "slack__open_dm", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.mismatch?.claim_type).toBe("slack_posted");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("agent not in applies_to (operator, even with a successful praxis__action) → no-op", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Posted to the #ops channel.",
        parsed: null,
        tool_calls: [{ name: "praxis__action", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("future/conditional Slack language does NOT trip the detector", () => {
    const prose = "Want me to DM them, or would you rather post it to the channel yourself?";
    const r = reconcileSideEffectClaims(
      { agent_slug: "growth-lead", output_text: prose, parsed: null },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("off mode → never touches anything, even a completed claim", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "growth-lead", output_text: SLACK_CLAIM, parsed: null },
      "off",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(SLACK_CLAIM);
  });
});

describe("side-effect-claim reconciler — Codex fix: SDK-wrapped tool-name normalization", () => {
  it("growth-lead Slack post under mcp__<srv>__slack__post_message still counts as truthful", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "growth-lead",
        output_text: "Sent — DM'd Jemis about the ranking drop.",
        parsed: null,
        tool_calls: [{ name: "mcp__praxis__slack__post_message", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("email send under mcp__<srv>__email__send still counts as truthful", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "chief-of-staff",
        output_text: "Email sent.",
        parsed: null,
        tool_calls: [{ name: "mcp__server__email__send", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });
});

describe("side-effect-claim reconciler — Codex fix: keep scanning after a truthful adapter", () => {
  it("operator: truthful dispatch + false email claim → email mismatch still logged (shadow, no rewrite)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Handed off to the engineer. Also emailed you the summary.",
        parsed: null,
        tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("email_sent");
    expect(r.mismatch?.actual).toBe(0);
    expect(r.text).toBe("Handed off to the engineer. Also emailed you the summary.");
  });

  it("operator: truthful dispatch + NO other claim → byte-unchanged, no mismatch (unchanged behavior)", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Handed off to the engineer — they'll take it from here.",
        parsed: null,
        tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });
});

describe("side-effect-claim reconciler — Codex fix: negation/future are NOT completed claims", () => {
  const emailNonClaims = [
    "I haven't emailed them yet — waiting on your go.",
    "I have not emailed the CFO.",
    "The email will be sent after you approve it in /approvals.",
    "No email was sent; this is a draft for your review.",
    "I didn't email anyone — just drafted it.",
  ];
  for (const prose of emailNonClaims) {
    it(`email non-claim not logged: "${prose.slice(0, 40)}…"`, () => {
      const r = reconcileSideEffectClaims(
        { agent_slug: "chief-of-staff", output_text: prose, parsed: null },
        "rewrite",
      );
      expect(r.corrected).toBe(false);
      expect(r.mismatch).toBeUndefined();
    });
  }

  const slackNonClaims = [
    "I haven't DM'd Jemis yet.",
    "No Slack message sent — want me to?",
    "I did not post the message to the channel.",
  ];
  for (const prose of slackNonClaims) {
    it(`slack non-claim not logged: "${prose.slice(0, 40)}…"`, () => {
      const r = reconcileSideEffectClaims(
        { agent_slug: "growth-lead", output_text: prose, parsed: null },
        "rewrite",
      );
      expect(r.corrected).toBe(false);
      expect(r.mismatch).toBeUndefined();
    });
  }

  it("a real completed email claim STILL fires even when a later clause is future", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "chief-of-staff",
        output_text: "Emailed you the summary. I'll follow up next week.",
        parsed: null,
      },
      "rewrite",
    );
    expect(r.mismatch?.claim_type).toBe("email_sent");
    expect(r.mismatch?.actual).toBe(0);
  });
});

describe("dispatch correction — asserts only what was measured", () => {
  const held = () =>
    reconcileSideEffectClaims(
      { agent_slug: "pm", output_text: CLAIM, parsed: DROPPED_PARSED },
      "rewrite",
    );

  it("does NOT assert an unverified GitHub-connector cause or remediation", () => {
    const { text } = held();
    expect(text).not.toMatch(/GitHub/i);
    expect(text).not.toMatch(/connect(?:ed|ors)?\b/i);
    expect(text).not.toMatch(/repositor(?:y|ies)|\brepo\b/i);
    expect(text).not.toMatch(/Settings\s*→/i);
    expect(text).not.toMatch(/commonly/i);
  });

  it("STILL removes the false claim: nothing was dispatched, so the claim is gone", () => {
    const r = held();
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.mismatch?.actual).toBe(0);
    expect(r.text).not.toMatch(/dispatched to engineer|action sent/i);
    expect(r.text).toBe("No changes were made.");
  });
});

describe("trace names parsed with fromTracedToolName (all three SDK shapes)", () => {
  const OPERATOR_CLAIM = "Handed off to the engineer — they'll pick it up from here.";

  it.each([
    "mcp__server__praxis__handoff",
    "mcp__praxis__handoff",
    "praxis__handoff",
  ])("a successful %s is a real dispatch → no false correction", (name) => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: OPERATOR_CLAIM,
        parsed: null,
        tool_calls: [{ name, status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(OPERATOR_CLAIM);
  });

  it("still flags the claim when NO handoff ran at all", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: OPERATOR_CLAIM,
        parsed: null,
        tool_calls: [{ name: "mcp__server__github__search_code", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.mismatch?.actual).toBe(0);
  });

  it("a server-wrapped PR tool that succeeded is a PR receipt", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "I opened a pull request with the fix.",
        parsed: {},
        parse_ok: false,
        tool_calls: [{ name: "mcp__server__github__create_pull_request", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
  });
});

describe("removeClaimSentences — deterministic sentence removal", () => {
  const isHandoff = (t: string) => /handed off/i.test(t);

  it("returns the same string when nothing matches", () => {
    const text = "Revenue is $1.5M this month. Churn is flat.";
    const r = removeClaimSentences(text, isHandoff);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(text);
  });

  it("never splits on a decimal or version number", () => {
    const r = removeClaimSentences("Revenue is $1.5M on v2.3 today. Handed off to QA.", isHandoff);
    expect(r.text).toBe("Revenue is $1.5M on v2.3 today.");
  });

  it("keeps list/quote/heading markers for the sentences that remain, drops emptied lines", () => {
    const text = [
      "## Update",
      "- Handed off to the engineer. The header is misaligned.",
      "- Handed off to design.",
      "> Handed off. Waiting on you.",
    ].join("\n");
    const r = removeClaimSentences(text, isHandoff);
    expect(r.text).toBe(["## Update", "- The header is misaligned.", "> Waiting on you."].join("\n"));
  });

  it("never touches a fenced code block", () => {
    const text = "Handed off to the engineer.\n\n```\nHanded off to the engineer.\n```";
    const r = removeClaimSentences(text, isHandoff);
    expect(r.text).toBe("```\nHanded off to the engineer.\n```");
  });

  it("returns empty when every sentence was the claim (caller supplies the fallback)", () => {
    expect(removeClaimSentences("Handed off to the engineer.", isHandoff).text).toBe("");
  });
});

describe("operator incident — 'Handed off … Two PRs are being opened.'", () => {
  const INCIDENT = "Handed off to the engineer. Two PRs are being opened.";

  it("zero handoffs → both claim sentences removed, server phrase stands, no banner", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: INCIDENT, parsed: null, tool_calls: [] },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.text).toBe("No changes were made.");
  });

  it("a real mcp__server__praxis__handoff → byte-identical", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: INCIDENT,
        parsed: null,
        tool_calls: [{ name: "mcp__server__praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(INCIDENT);
  });

  it("a future promise about a PR is not part of the claim", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Handed off to the engineer. I'll open a PR once you approve.",
        parsed: null,
        tool_calls: [],
      },
      "rewrite",
    );
    expect(r.text).toBe("I'll open a PR once you approve.");
  });
});

describe("in-flight hand-off claim — 'was just dispatched / will post back once it finishes'", () => {
  const TRUE_PR =
    "The only open PR on the Android repo right now is an unrelated one: [#340 — Checkout: show store credit applied automatically](https://github.com/acme/android/pull/340).";
  const FIXTURE =
    "Not up yet — the engineer was just dispatched this turn and likely hasn't opened the PR yet. " +
    TRUE_PR +
    "\n\nThe QA test PR will post back here in this thread once the engineer finishes — usually a minute or two. I'll have the link for you then.";
  const TRACE = [
    { name: "ToolSearch", status: "ok" },
    { name: "mcp__server__github__list_open_prs", status: "ok" },
  ];

  it("removes the false in-flight sentences and keeps the true PR sentence byte-identical", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: FIXTURE,
        parsed: null,
        tool_calls: TRACE,
        thread_children_working: { ok: true, value: [] },
      },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch_inflight");
    expect(r.text).toBe(TRUE_PR);
  });

  it("a running child keeps the follow-on, but not the 'just dispatched this turn' sentence", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: FIXTURE,
        parsed: null,
        tool_calls: TRACE,
        thread_children_working: { ok: true, value: ["engineer"] },
      },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.text).toBe(
      TRUE_PR +
        "\n\nThe QA test PR will post back here in this thread once the engineer finishes — usually a minute or two. I'll have the link for you then.",
    );
  });

  it("a specialist said to be working now, with no hand-off and nothing running, loses that sentence", () => {
    const cases: Array<[string, string]> = [
      ["The engineer is on it, and the researcher is working on it.", "No changes were made."],
      [
        "The engineer is on it. " + TRUE_PR + "\n\nIt will post back here once the engineer finishes. I'll have the link for you then.",
        TRUE_PR,
      ],
      [
        "I read both posts. The Instagram specialist is now trying to read both handles straight from the post links.",
        "I read both posts.",
      ],
      ["Your AI UGC video specialist is already working on the first cut. Send the logo when you can.", "Send the logo when you can."],
    ];
    for (const [text, after] of cases) {
      expect(hasInflightHandoffClaim(text)).toBe(true);
      const r = reconcileSideEffectClaims(
        {
          agent_slug: "operator",
          output_text: text,
          parsed: null,
          tool_calls: TRACE,
          thread_children_working: { ok: true, value: [] },
          tenant_runs_working: { ok: true, value: [] },
        },
        "rewrite",
      );
      expect(r.corrected).toBe(true);
      expect(r.mismatch?.claim_type).toBe("dispatch_inflight");
      expect(r.text).toBe(after);
    }
  });

  it("a specialist said to be working stays when any run is working, this turn handed off, or the runs are unreadable", () => {
    const text = "The Instagram specialist is now trying to read both handles. I'll have the link for you then.";
    const base = { agent_slug: "operator", output_text: text, parsed: null, tool_calls: TRACE };
    for (const extra of [
      { thread_children_working: { ok: true as const, value: [] }, tenant_runs_working: { ok: true as const, value: ["instagram_organic"] } },
      { thread_children_working: { ok: true as const, value: [] }, tenant_runs_working: { ok: false as const } },
      { thread_children_working: { ok: false as const }, tenant_runs_working: { ok: true as const, value: [] } },
    ]) {
      const r = reconcileSideEffectClaims({ ...base, ...extra }, "rewrite");
      expect(r.text).toBe(text);
    }
    const handedOff = reconcileSideEffectClaims(
      { ...base, tool_calls: [{ name: "mcp__praxis__handoff", status: "ok" }], tenant_runs_working: { ok: true, value: [] } },
      "rewrite",
    );
    expect(handedOff.text).toBe(text);
  });

  it("only a run that could be the NAMED specialist backs the claim", () => {
    const text = "The Instagram specialist is now trying to read both handles. The audit is attached.";
    const run = (working: string[]) =>
      reconcileSideEffectClaims(
        {
          agent_slug: "operator",
          output_text: text,
          parsed: null,
          tool_calls: TRACE,
          thread_children_working: { ok: true, value: [] },
          tenant_runs_working: { ok: true, value: working },
        },
        "rewrite",
      ).text;
    expect(run(["seo-geo"])).toBe("The audit is attached.");
    expect(run(["engineer"])).toBe("The audit is attached.");
    expect(run(["instagram_organic"])).toBe(text);
    const meta = "The Meta Ads specialist is working on it.";
    const backedBy = (slug: string) =>
      reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: meta, parsed: null, tool_calls: TRACE, thread_children_working: { ok: true, value: [] }, tenant_runs_working: { ok: true, value: [slug] } },
        "rewrite",
      ).text === meta;
    expect(backedBy("google_ads")).toBe(false);
    expect(backedBy("meta_ads")).toBe(true);
    const seo = "The SEO/GEO specialist is working on it.";
    expect(
      reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: seo, parsed: null, tool_calls: TRACE, thread_children_working: { ok: true, value: [] }, tenant_runs_working: { ok: true, value: ["seo-geo"] } },
        "rewrite",
      ).text,
    ).toBe(seo);
    const generic = "The specialist is working on it.";
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: generic, parsed: null, tool_calls: TRACE, thread_children_working: { ok: true, value: [] }, tenant_runs_working: { ok: true, value: ["seo-geo"] } },
      "rewrite",
    );
    expect(r.text).toBe(generic);
    const eng = "The engineer is on it.";
    expect(
      reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: eng, parsed: null, tool_calls: TRACE, thread_children_working: { ok: true, value: ["engineer"] }, tenant_runs_working: { ok: true, value: [] } },
        "rewrite",
      ).text,
    ).toBe(eng);
  });

  it("progress that is not a Zavi specialist's, an offer, a question or a condition is never removed", () => {
    for (const text of [
      "As I mentioned earlier, I've dispatched the engineer.",
      "Per your request, the engineer is on it.",
      "Your engineer is working on the fix, per your note.",
      "If the engineer is on it, I'll wait.",
      "Is the specialist working on it?",
      "Want me to check whether the agent is handling it?",
      "The Meta agent is working fine again.",
      "The engineer was working on it yesterday.",
      "The engineer is not working on it.",
      "I can't confirm the engineer is working on it.",
      'You wrote "the engineer is on it" in your note.',
      "The old note reads 'the engineer is on it', but that note is stale.",
    ]) {
      expect(hasWorkUnderwayClaim(text)).toBe(false);
      const r = reconcileSideEffectClaims(
        {
          agent_slug: "operator",
          output_text: text,
          parsed: null,
          tool_calls: TRACE,
          thread_children_working: { ok: true, value: [] },
          tenant_runs_working: { ok: true, value: [] },
        },
        "rewrite",
      );
      expect(r.corrected).toBe(false);
      expect(r.text).toBe(text);
    }
  });

  it("leaves every sentence alone when the child state could not be read", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: FIXTURE,
        parsed: null,
        tool_calls: TRACE,
        thread_children_working: { ok: false },
      },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
    expect(r.text).toBe(FIXTURE);
  });

  it("customer-attributed or generic-team progress is not a Zavi hand-off claim", () => {
    for (const text of [
      "Per your update, the team is already working on it.",
      "The engineer is already working on it, according to your update.",
      "Your engineer was just dispatched this turn.",
      "Your team just handed it off to the engineer.",
    ]) {
      expect(hasInflightHandoffClaim(text)).toBe(false);
      const r = reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: text, parsed: null, tool_calls: TRACE },
        "rewrite",
      );
      expect(r.text).toBe(text);
    }
  });

  it("a denial, a question, or a dispatch that is not the specialist's is never removed", () => {
    for (const text of [
      "The engineer wasn't just dispatched this turn; that hand-off happened yesterday.",
      "Was the engineer just dispatched this turn?",
      "The engineer confirmed order #88 was just dispatched to the courier.",
      "I just checked: order #88 was dispatched just now.",
    ]) {
      expect(hasInflightHandoffClaim(text)).toBe(false);
      const r = reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: text, parsed: null, tool_calls: TRACE },
        "rewrite",
      );
      expect(r.text).toBe(text);
    }
  });

  it("keeps a current-turn claim when this turn really handed off", () => {
    const text = "I've just handed it off to the engineer. I'll have the link for you then.";
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: text,
        parsed: null,
        tool_calls: [{ name: "mcp__praxis__handoff", status: "ok" }],
      },
      "rewrite",
    );
    expect(r.text).toBe(text);
  });

  it("an offer is not a claim: 'I'll hand this to the engineer if you want' is untouched", () => {
    const text = "I'll hand this to the engineer if you want. Want me to have the engineer start on it?";
    expect(hasInflightHandoffClaim(text)).toBe(false);
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: text, parsed: null, tool_calls: TRACE },
      "rewrite",
    );
    expect(r.text).toBe(text);
  });

  it("detects only explicit current-turn markers", () => {
    expect(hasInflightHandoffClaim("I've just handed it off to the engineer.")).toBe(true);
    expect(hasInflightHandoffClaim("The engineer was dispatched this turn.")).toBe(true);
    expect(hasInflightHandoffClaim("The engineer has just been dispatched.")).toBe(true);
    expect(hasInflightHandoffClaim("The engineer was dispatched just now.")).toBe(true);
    expect(hasInflightHandoffClaim("It was handed off this turn.")).toBe(true);
    expect(hasInflightHandoffClaim("The engineer is already working on it.")).toBe(true);
    expect(hasInflightHandoffClaim("Once the engineer finishes, I'll post the link here.")).toBe(false);
    expect(hasInflightHandoffClaim("The engineer wasn't dispatched.")).toBe(false);
    expect(hasInflightHandoffClaim("Order #88 was just dispatched to the courier.")).toBe(false);
    expect(hasInflightHandoffClaim("Your engineer is on it, per your note.")).toBe(false);
  });
});

describe("thread promise on an MCP run — there is no thread", () => {
  const PROMISE =
    "I've passed your question to the GEO specialist with your facts. The answer will post back in this thread when it finishes.";
  const HANDOFF = [{ name: "mcp__server__praxis__handoff", status: "ok" }];

  it("after a real hand-off, the promise becomes the zavi_get_run_status instruction", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: PROMISE, parsed: null, tool_calls: HANDOFF, surface: "mcp", run_id: "run-123" },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("thread_promise_no_thread");
    expect(r.text).toBe(`I've passed your question to the GEO specialist with your facts. ${mcpFollowLine("run-123")}`);
    expect(r.text).toContain("run-123");
  });

  it("with no hand-off, the promise is removed (any agent)", () => {
    for (const slug of ["operator", "seo-geo", "research"]) {
      const r = reconcileSideEffectClaims(
        { agent_slug: slug, output_text: "Here is the audit. I'll post the result back in this thread later.", parsed: null, tool_calls: [], surface: "mcp" },
        "rewrite",
      );
      expect(r.text).toBe("Here is the audit.");
    }
  });

  it("the same promise on a threaded surface is untouched", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: PROMISE, parsed: null, tool_calls: HANDOFF },
      "rewrite",
    );
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(PROMISE);
  });

  it("a false dispatch claim and the thread promise in one reply are both handled", () => {
    const text = "Dispatched to engineer: **fix-pricing**. The result will post back here when it finishes. The pricing page has two bugs.";
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: text, parsed: null, tool_calls: [], surface: "mcp" },
      "rewrite",
    );
    expect(r.corrected).toBe(true);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.removed_sentences).toBe(2);
    expect(r.text).toBe("The pricing page has two bugs.");
  });

  it("log mode reports the promise and changes nothing", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: PROMISE, parsed: null, tool_calls: HANDOFF, surface: "mcp" },
      "log",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch?.claim_type).toBe("thread_promise_no_thread");
    expect(r.text).toBe(PROMISE);
  });

  it("a statement about this reply, or a denial, is untouched", () => {
    for (const text of [
      "I posted the details here so you can copy them.",
      "I will not post back in this thread.",
      "I'll share the audit here: the title tag is missing on the home page.",
    ]) {
    const r = reconcileSideEffectClaims(
      { agent_slug: "operator", output_text: text, parsed: null, tool_calls: [], surface: "mcp" },
      "rewrite",
    );
    expect(r.text).toBe(text);
    }
  });

  it("a parallel fan-out is not one followable answer: it points at the runs list", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "I asked three specialists. Their answers will post back in this thread when they finish.",
        parsed: null,
        tool_calls: [{ name: "mcp__praxis__handoff_parallel", status: "ok" }],
        surface: "mcp",
      },
      "rewrite",
    );
    expect(r.text).toBe(`I asked three specialists. ${MCP_FANOUT_LINE}`);
  });
});

describe("work-underway claim in a blockquote", () => {
  it("a quoted line is someone else's words and stays", () => {
    const text = "> The engineer is on it.\n\nThat was your teammate's note.";
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: text,
        parsed: null,
        tool_calls: [],
        thread_children_working: { ok: true, value: [] },
        tenant_runs_working: { ok: true, value: [] },
      },
      "rewrite",
    );
    expect(r.text).toBe(text);
  });
});

describe("card_change adapter", () => {
  const MIRROR =
    "Email 1's subject is now \"Welcome to Zavi, start here\". I can't change it on the card itself, because the stored card holds no email text. To change only the subject, I'd need the full text.";
  const input = (over: Record<string, unknown> = {}) => ({
    agent_slug: "email_marketing",
    chat_turn: true,
    output_text: MIRROR,
    parsed: null,
    tool_calls: [{ name: "mcp__praxis_corpus__get_channel_action", status: "ok" }],
    ...over,
  });

  it("MUST-CATCH: the mirror reply loses the false sentence and keeps the rest", () => {
    const r = reconcileSideEffectClaims(input() as never, "rewrite");
    expect(r.corrected).toBe(true);
    expect(r.text).not.toContain("is now");
    expect(r.text).toContain("I can't change it on the card itself");
  });

  it("keeps the claim when the draft was really saved", () => {
    const r = reconcileSideEffectClaims(input({ tool_calls: [{ name: "mcp__email__propose_campaign", status: "ok" }] }) as never, "rewrite");
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(MIRROR);
  });

  it("removes the claim when the propose call was refused", () => {
    const r = reconcileSideEffectClaims(input({ tool_calls: [{ name: "mcp__email__propose_campaign", status: "error" }] }) as never, "rewrite");
    expect(r.corrected).toBe(true);
  });

  it.each([
    "The subject has been updated.",
    "I've changed the subject line.",
    "Email 2 now reads better.",
    "The preview text was replaced.",
  ])("removes %s with no write", (text) => {
    const r = reconcileSideEffectClaims(input({ output_text: text }) as never, "rewrite");
    expect(r.corrected).toBe(true);
    expect(r.text).not.toBe(text);
  });

  it.each([
    "The subject is now too long for mobile.",
    "If you approve, the card will be updated.",
    "The earlier draft was replaced by this one.",
    "I can change the subject if you want.",
    "The subject line reads well.",
  ])("leaves %s alone", (text) => {
    expect(reconcileSideEffectClaims(input({ output_text: text }) as never, "rewrite").text).toBe(text);
  });

  it("does not touch a scheduled run or another agent", () => {
    expect(reconcileSideEffectClaims(input({ chat_turn: false }) as never, "rewrite").corrected).toBe(false);
    expect(reconcileSideEffectClaims(input({ agent_slug: "meta_ads" }) as never, "rewrite").corrected).toBe(false);
  });
});
