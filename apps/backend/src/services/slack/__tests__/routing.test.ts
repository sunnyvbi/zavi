
import { describe, it, expect } from "vitest";
import {
  decideSlackRoute,
  parseExplicitSlug,
  buildLowConfidenceReply,
  OPERATOR_SLUG,
} from "../routing";
import { GOLDENS } from "../routing-eval/goldens";
import { scoreDeterministic } from "../routing-eval/runner";

describe("decideSlackRoute — golden routing gate (deterministic, no LLM)", () => {
  const report = scoreDeterministic(GOLDENS);

  it("every golden routes as expected (100% deterministic accuracy)", () => {
    const failures = report.cases.filter((c) => !c.pass);
    expect(
      failures,
      `routing regressions:\n${failures
        .map((f) => `  - ${f.name}: ${f.reason}`)
        .join("\n")}`,
    ).toEqual([]);
    expect(report.accuracy).toBe(1);
  });

  it("no seeded incident regresses (empty-roster + connector-blindness gates)", () => {
    expect(
      report.incidentFailures,
      `INCIDENT REGRESSION:\n${report.incidentFailures
        .map((f) => `  - [${f.incident}] ${f.name}: ${f.reason}`)
        .join("\n")}`,
    ).toEqual([]);
    const incidents = new Set(GOLDENS.map((g) => g.incident).filter(Boolean));
    expect(incidents).toContain("empty_roster_outage");
    expect(incidents).toContain("operator_connector_blindness");
  });

  it("covers the full (roster × scenario) cross-product", () => {
    const rosters = ["with_operator", "no_operator", "empty"] as const;
    const scenarios = [
      "explicit_slug",
      "tier1",
      "tier2",
      "tier3_valid",
      "tier3_hallucinated",
      "low_confidence",
      "classify_null",
    ] as const;
    const seen = new Set(GOLDENS.map((g) => `${g.roster}:${g.scenario}`));
    const required: string[] = [];
    for (const r of ["with_operator", "no_operator"] as const) {
      for (const s of scenarios) required.push(`${r}:${s}`);
    }
    for (const s of ["classify_null", "low_confidence", "tier3_hallucinated"] as const) {
      required.push(`empty:${s}`);
    }
    const missing = required.filter((k) => !seen.has(k));
    expect(missing, `missing cross-product buckets: ${missing.join(", ")}`).toEqual(
      [],
    );
    void rosters;
  });
});

const WITH_OP = [
  { slug: "operator" },
  { slug: "engineer" },
  { slug: "performance-marketer" },
];
const NO_OP = [{ slug: "engineer" }, { slug: "performance-marketer" }];

describe("decideSlackRoute — operator-woken Tier-1/2 (2026-07-16 answer-drop gate)", () => {
  const HIGH_CONF_T1 = {
    tier: 1 as const,
    reply: "Yes, that PR merged this morning.",
    confidence: "high" as const,
  };

  it("INCIDENT: high-conf Tier-1/2 + operator woken → ack_and_route_operator (never terminalizes the claim)", () => {
    const r = decideSlackRoute({
      decision: HIGH_CONF_T1,
      active: WITH_OP,
      operatorWillRun: true,
    });
    expect(r.kind).toBe("ack_and_route_operator");
    if (r.kind === "ack_and_route_operator") {
      expect(r.placeholder_text.length).toBeGreaterThan(0);
      expect(r.result).toEqual({
        tier: 1,
        posted: true,
        routed: "operator",
        reason: "tier12_operator_woken",
      });
    }
  });

  it("high-conf Tier-1/2 + operator NOT woken (plain channel chatter) → unchanged self-answer", () => {
    const r = decideSlackRoute({
      decision: HIGH_CONF_T1,
      active: WITH_OP,
      operatorWillRun: false,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.text).toBe(HIGH_CONF_T1.reply);
      expect(r.success_emoji_on_post_ok).toBe(true);
    }
  });

  it("operatorWillRun defaults to false → existing callers/goldens byte-for-byte unchanged", () => {
    const r = decideSlackRoute({ decision: HIGH_CONF_T1, active: WITH_OP });
    expect(r.kind).toBe("post_and_terminate");
  });

  it("INCIDENT: high-conf Tier-1/2 + operator woken + wsDefault set → ack_and_route_operator (13 of 37 measured drops)", () => {
    const r = decideSlackRoute({
      decision: HIGH_CONF_T1,
      active: WITH_OP,
      operatorWillRun: true,
      workspaceDefaultSlug: "engineer",
    });
    expect(r.kind).toBe("ack_and_route_operator");
  });

  it("wsDefault still owns the LOW-conf tail (feature untouched)", () => {
    const r = decideSlackRoute({
      decision: { tier: 1, reply: "maybe?", confidence: "low" },
      active: WITH_OP,
      operatorWillRun: true,
      workspaceDefaultSlug: "engineer",
    });
    expect(r.kind).toBe("enqueue_direct");
    if (r.kind === "enqueue_direct") expect(r.agent_slug).toBe("engineer");
  });

  it("never carries the classifier's ungrounded answer as a postable field", () => {
    const r = decideSlackRoute({
      decision: HIGH_CONF_T1,
      active: WITH_OP,
      operatorWillRun: true,
    });
    expect(r.kind).toBe("ack_and_route_operator");
    expect(JSON.stringify(r)).not.toContain(HIGH_CONF_T1.reply);
  });

  it("high-conf Tier-1/2 + operator woken + operator HIDDEN → unchanged self-answer", () => {
    const r = decideSlackRoute({
      decision: HIGH_CONF_T1,
      active: NO_OP,
      operatorWillRun: true,
    });
    expect(r.kind).toBe("post_and_terminate");
  });

  it("LOW-conf + operator woken → still low_conf_operator_dispatch (sweep path untouched)", () => {
    const r = decideSlackRoute({
      decision: { tier: 1, reply: "maybe?", confidence: "low" },
      active: WITH_OP,
      operatorWillRun: true,
    });
    expect(r.kind).toBe("low_conf_operator_dispatch");
  });
});

describe("decideSlackRoute — branch-level invariants", () => {
  it("classify-null + operator visible → route_operator(classify_null)", () => {
    const r = decideSlackRoute({ decision: null, active: WITH_OP });
    expect(r.kind).toBe("route_operator");
    if (r.kind === "route_operator") {
      expect(r.result).toEqual({ routed: "operator", reason: "classify_null" });
    }
  });

  it("classify-null + operator hidden → honest fallback, never silent drop", () => {
    const r = decideSlackRoute({ decision: null, active: NO_OP });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.success_emoji_on_post_ok).toBe(false);
      expect(r.text).toContain("couldn't tell who should pick this up");
      expect(r.text).toContain("@engineer");
      expect(r.result).toEqual({ skip: "classify_failed_terminal" });
    }
  });

  it("classify-null + EMPTY roster → fallback with no agent hint", () => {
    const r = decideSlackRoute({ decision: null, active: [] });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.text).not.toContain("e.g.");
      expect(r.text).toContain("couldn't tell who should pick this up");
    }
  });

  it("Tier-3 explicit match → enqueue_direct, no operator turn", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
      explicit: "engineer",
      active: WITH_OP,
    });
    expect(r.kind).toBe("enqueue_direct");
    if (r.kind === "enqueue_direct") {
      expect(r.agent_slug).toBe("engineer");
      expect(r.result).toEqual({
        tier: 3,
        agent_slug: "engineer",
        route: "explicit",
      });
    }
  });

  it("Tier-3 explicit slug NOT in roster → not treated as explicit (falls to operator)", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, agent_slug: "ghost", confidence: "high" },
      explicit: "ghost",
      active: WITH_OP,
    });
    expect(r.kind).toBe("route_operator");
  });

  it("Tier-3 valid slug (no explicit) + operator → route_operator(tier3) preserves model_slug", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("route_operator");
    if (r.kind === "route_operator") {
      expect(r.result).toEqual({
        routed: "operator",
        reason: "tier3",
        model_slug: "engineer",
      });
    }
  });

  it("Tier-3 missing agent_slug + operator → route_operator with model_slug null", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, confidence: "high" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("route_operator");
    if (r.kind === "route_operator") {
      expect((r.result as { model_slug: unknown }).model_slug).toBeNull();
    }
  });

  it("Tier-3 valid slug + operator hidden → legacy direct dispatch", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
      active: NO_OP,
    });
    expect(r.kind).toBe("enqueue_direct");
    if (r.kind === "enqueue_direct") {
      expect(r.result).toEqual({
        tier: 3,
        agent_slug: "engineer",
        route: "direct_no_operator",
      });
    }
  });

  it("Tier-3 hallucinated slug + operator hidden → honest fallback (unmatched)", () => {
    const r = decideSlackRoute({
      decision: { tier: 3, agent_slug: "ghost", confidence: "high" },
      active: NO_OP,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.success_emoji_on_post_ok).toBe(false);
      expect(r.result).toEqual({ tier: 3, unmatched: "ghost" });
    }
  });

  it("Tier-1 high confidence → post the reply (OK emoji on success)", () => {
    const r = decideSlackRoute({
      decision: { tier: 1, reply: "hello world", confidence: "high" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.success_emoji_on_post_ok).toBe(true);
      expect(r.text).toBe("hello world");
      expect(r.result).toEqual({ tier: 1, posted: true });
    }
  });

  it("Tier-1 high confidence but MISSING reply (operator visible) → operator dispatch", () => {
    const r = decideSlackRoute({
      decision: { tier: 1, confidence: "high" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("low_conf_operator_dispatch");
    if (r.kind === "low_conf_operator_dispatch") {
      expect(r.placeholder_text).toContain("On it");
      expect(r.result).toMatchObject({ tier: 1, routed: "operator" });
    }
  });

  it("Tier-2 high confidence with WHITESPACE-only reply → honest fallback, never a blank bubble", () => {
    const r = decideSlackRoute({
      decision: { tier: 2, reply: "   \n  ", confidence: "high" },
      active: NO_OP,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(r.text).toContain("@Zavi @<agent-slug>");
      expect(r.success_emoji_on_post_ok).toBe(true);
      expect(r.result).toMatchObject({ tier: 2, empty_reply_rescued: true });
    }
  });

  it("Tier-1 whitespace reply + suggested slug (operator visible) → operator dispatch", () => {
    const r = decideSlackRoute({
      decision: {
        tier: 1,
        reply: "\t\t",
        confidence: "high",
        suggested_agent_slug: "engineer",
      },
      active: WITH_OP,
    });
    expect(r.kind).toBe("low_conf_operator_dispatch");
    if (r.kind === "low_conf_operator_dispatch") {
      expect(r.placeholder_text).toContain("On it");
      expect(r.result).toMatchObject({ tier: 1, routed: "operator" });
    }
  });

  it("Tier-1 high confidence with a REAL reply does NOT set the rescue flag", () => {
    const r = decideSlackRoute({
      decision: { tier: 1, reply: "the answer is 42", confidence: "high" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.text).toBe("the answer is 42");
      expect(r.result).toEqual({ tier: 1, posted: true });
      expect("empty_reply_rescued" in r.result).toBe(false);
    }
  });

  it("low-confidence verdict + operator visible + no suggested-slug → low_conf_operator_dispatch (distinct path)", () => {
    const r = decideSlackRoute({
      decision: { tier: 2, confidence: "low" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("low_conf_operator_dispatch");
    if (r.kind === "low_conf_operator_dispatch") {
      expect("empty_reply_rescued" in r.result).toBe(false);
      expect(r.result).toMatchObject({
        tier: 2,
        posted: true,
        routed: "operator",
        reason: "low_conf_dispatch",
      });
    }
  });

  it("Tier-2 low confidence + operator visible → placeholder + async operator dispatch", () => {
    const r = decideSlackRoute({
      decision: { tier: 2, confidence: "low" },
      active: WITH_OP,
    });
    expect(r.kind).toBe("low_conf_operator_dispatch");
    if (r.kind === "low_conf_operator_dispatch") {
      expect(r.placeholder_text).toContain("On it");
    }
  });

  it("Tier-2 low confidence + operator HIDDEN → legacy honest fallback (post_and_terminate)", () => {
    const r = decideSlackRoute({
      decision: { tier: 2, confidence: "low" },
      active: NO_OP,
    });
    expect(r.kind).toBe("post_and_terminate");
    if (r.kind === "post_and_terminate") {
      expect(r.success_emoji_on_post_ok).toBe(true);
      expect(r.text).toContain("@Zavi @<agent-slug>");
    }
  });
});

describe("parseExplicitSlug", () => {
  const slugs = new Set(["engineer", "performance-marketer", OPERATOR_SLUG]);

  it("strips a leading <@U…> mention then matches @slug", () => {
    expect(parseExplicitSlug("<@U123ABC> @engineer fix it", slugs)).toBe(
      "engineer",
    );
  });
  it("matches a bare slug without @", () => {
    expect(parseExplicitSlug("<@U123> performance-marketer what's spend", slugs)).toBe(
      "performance-marketer",
    );
  });
  it("is case-insensitive on the slug token but lowercases the result", () => {
    expect(parseExplicitSlug("<@U1> @Engineer hi", slugs)).toBe(
      "engineer",
    );
  });
  it("returns undefined when the first token is not a known slug", () => {
    expect(parseExplicitSlug("<@U1> hey can you help", slugs)).toBeUndefined();
  });
  it("returns undefined when the first token isn't a slug-shaped token", () => {
    expect(parseExplicitSlug("<@U1> !!! ???", slugs)).toBeUndefined();
  });
  it("works with no leading mention token", () => {
    expect(parseExplicitSlug("@operator route this", slugs)).toBe("operator");
  });
});

describe("buildLowConfidenceReply", () => {
  const active = [{ slug: "engineer" }, { slug: "performance-marketer" }];
  it("suggests the closest match when the suggestion is a real agent", () => {
    expect(buildLowConfidenceReply(active, "engineer")).toContain(
      "Closest match would be `engineer`",
    );
  });
  it("ignores a suggestion that isn't in the active set", () => {
    const r = buildLowConfidenceReply(active, "ghost");
    expect(r).not.toContain("closest match");
    expect(r).toContain("@Zavi @<agent-slug>");
  });
  it("emits the 'no agents configured' reply on an empty roster", () => {
    expect(buildLowConfidenceReply([], undefined)).toContain(
      "No agents are configured for this workspace yet",
    );
  });
});

const LIVE = process.env.SLACK_ROUTING_E2E === "1";
(LIVE ? describe : describe.skip)(
  "decideSlackRoute — live classifier accuracy (opt-in, real spend, reported)",
  () => {
    it("reports routing accuracy against the real classifier", async () => {
      const { classifyMessage } = await import("../triage-classifier");
      const { scoreLiveClassifier } = await import("../routing-eval/runner");
      const tenant_id =
        process.env.SLACK_ROUTING_E2E_TENANT ??
        "73db45ff-457e-4541-bc8f-bdb625390204";
      const report = await scoreLiveClassifier(
        GOLDENS,
        (input) => classifyMessage(input),
        tenant_id,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[slack-routing-e2e] live accuracy ${(report.accuracy * 100).toFixed(
          1,
        )}% (${report.passed}/${report.total})`,
      );
      for (const c of report.cases.filter((x) => !x.pass)) {
        // eslint-disable-next-line no-console
        console.log(`  miss: ${c.name} — ${c.reason}`);
      }
      expect(report.total).toBeGreaterThan(0);
    }, 120_000);
  },
);
