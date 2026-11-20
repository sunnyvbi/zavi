
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  computeFunnel,
  computeMomentumGate,
  computeForecast,
  parseTargetAmount,
  deriveRaisePhase,
  readinessState,
  nextRaiseAction,
  alertStrip,
  resolveRaise,
  suppressDuplicateAlerts,
  hasRoundDesign,
  RAISE_PHASES,
  RAISE_SECTION_IDS,
  ADVISE_READINESS_PROMPT,
  ADVISE_ROUND_DESIGN_PROMPT,
  MOMENTUM_THRESHOLD,
  type ResolverInvestor,
  type ResolverIntro,
  type ResolverMeeting,
  type ReadinessSnapshot,
} from "../raise-resolver";

const NOW = Date.parse("2026-07-15T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe("deriveRaisePhase", () => {
  it("defaults to prep on a null row", () => {
    expect(deriveRaisePhase(null)).toBe("prep");
    expect(deriveRaisePhase({ current_phase: null })).toBe("prep");
    expect(deriveRaisePhase({ current_phase: "bogus" })).toBe("prep");
  });
  it("returns the persisted cursor", () => {
    expect(deriveRaisePhase({ current_phase: "outreach" })).toBe("outreach");
  });
});

describe("readinessState", () => {
  it("null / empty snapshot => not_assessed", () => {
    expect(readinessState(null)).toBe("not_assessed");
    expect(readinessState({ dimensions: [] })).toBe("not_assessed");
  });
  it("any gap dimension => not_ready (never reads a number)", () => {
    const snap: ReadinessSnapshot = {
      dimensions: [
        { key: "traction", status: "good" },
        { key: "revenue", status: "gap" },
      ],
    };
    expect(readinessState(snap)).toBe("not_ready");
  });
  it("all good/watch => ready", () => {
    expect(
      readinessState({
        dimensions: [
          { key: "traction", status: "good" },
          { key: "narrative", status: "watch" },
        ],
      }),
    ).toBe("ready");
  });
});

describe("computeFunnel", () => {
  it("buckets by priority passed > interested > contacted > notContacted", () => {
    const investors: ResolverInvestor[] = [
      { review_state: "removed", replied: true },
      { outreach_state: "replied" },
      { review_state: "approved" },
      { stage: "committed" },
      { sent_marker_count: 1 },
      { outreach_state: "sent" },
      {},
      { outreach_state: "queued" },
    ];
    expect(computeFunnel(investors)).toEqual({
      notContacted: 2,
      contacted: 2,
      interested: 3,
      passed: 1,
      total: 8,
    });
  });
});

describe("computeMomentumGate", () => {
  it(`flips ready at exactly ${MOMENTUM_THRESHOLD} sent`, () => {
    const four: ResolverIntro[] = Array(4).fill({ status: "sent" });
    const five: ResolverIntro[] = Array(5).fill({ status: "sent" });
    expect(computeMomentumGate(four).ready).toBe(false);
    expect(computeMomentumGate(four).sentCount).toBe(4);
    expect(computeMomentumGate(five).ready).toBe(true);
    expect(
      computeMomentumGate([...five, { status: "queued" }]).sentCount,
    ).toBe(5);
  });
});

describe("parseTargetAmount", () => {
  it("parses common ask formats, else null (never a fake 0)", () => {
    expect(parseTargetAmount("$500K")).toBe(500_000);
    expect(parseTargetAmount("$1.5M")).toBe(1_500_000);
    expect(parseTargetAmount("250,000")).toBe(250_000);
    expect(parseTargetAmount("raising 2M on a SAFE")).toBe(2_000_000);
    expect(parseTargetAmount("")).toBeNull();
    expect(parseTargetAmount(null)).toBeNull();
    expect(parseTargetAmount("no number here")).toBeNull();
  });
});

describe("computeForecast", () => {
  it("committed strictly from stage==='committed'; projectedWeeks null when nothing committed", () => {
    const investors: ResolverInvestor[] = [
      { stage: "committed" },
      { outreach_state: "replied" },
      { sent_marker_count: 1 },
    ];
    const f = computeForecast(investors, [], "$500K");
    expect(f.committed).toBe(1);
    expect(f.target).toBe(500_000);
    expect(f.interestedCount).toBe(2);
    expect(f.activeCount).toBe(3);
    expect(f.projectedWeeks).not.toBeNull();
  });
  it("committed=0 => projectedWeeks null, target null on unparseable ask", () => {
    const f = computeForecast([{ outreach_state: "sent" }], [], "TBD");
    expect(f.committed).toBe(0);
    expect(f.projectedWeeks).toBeNull();
    expect(f.target).toBeNull();
  });
});

describe("PATHOLOGICAL TAIL (invariant d) — 40 cold, not ready, idle", () => {
  const investors: ResolverInvestor[] = Array.from({ length: 40 }, () => ({
  }));
  const readinessSnap: ReadinessSnapshot = {
    dimensions: [
      { key: "traction", status: "good" },
      { key: "revenue", status: "gap" },
    ],
  };
  const raise = { current_phase: "prep", readiness_snapshot: readinessSnap };

  it("funnel: all 40 notContacted, nothing else", () => {
    const f = computeFunnel(investors);
    expect(f).toEqual({
      notContacted: 40,
      contacted: 0,
      interested: 0,
      passed: 0,
      total: 40,
    });
  });

  it("momentum gate NOT met (0 intros in flight)", () => {
    expect(computeMomentumGate([]).ready).toBe(false);
  });

  it("committed=0 and no 'on track' string anywhere in the resolved payload", () => {
    const state = resolveRaise({
      raise,
      ask: "$500K",
      investors,
      intros: [],
      meetings: [],
      followupsDueCount: 0,
      nowMs: NOW,
    });
    expect(state.forecast.committed).toBe(0);
    expect(state.momentum.ready).toBe(false);
    expect(state.readiness_state).toBe("not_ready");
    expect(state.next_action.ctaTarget).toBe("prep");
    expect(state.next_action.title.toLowerCase()).toContain("not ready");
    const blob = JSON.stringify(state).toLowerCase();
    expect(blob).not.toContain("on track");
    expect(blob).not.toMatch(/\$\s*\d/);
    expect(blob).not.toMatch(/\d+\s*%/);
  });
});

describe("computeForecast — real meeting signal (Slice 7)", () => {
  it("counts soft_yes DONE meetings into softYesMeetings, never into committed", () => {
    const investors: ResolverInvestor[] = [{ outreach_state: "replied" }];
    const meetings: ResolverMeeting[] = [
      { kind: "done", outcome: "soft_yes" },
      { kind: "done", outcome: "soft_yes" },
      { kind: "done", outcome: "pass" },
      { kind: "upcoming" },
    ];
    const f = computeForecast(investors, meetings, "$500K");
    expect(f.softYesMeetings).toBe(2);
    expect(f.committed).toBe(0);
  });
  it("no meetings => softYesMeetings 0 (backward-compatible)", () => {
    expect(computeForecast([{ outreach_state: "sent" }], [], "$500K").softYesMeetings).toBe(0);
  });
});

describe("alertStrip — debrief-due meeting signal (Slice 7)", () => {
  it("surfaces a debrief_due alert for DONE meetings with no outcome", () => {
    const meetings: ResolverMeeting[] = [
      { kind: "done", outcome: null },
      { kind: "done", outcome: "soft_yes" },
      { kind: "upcoming" },
    ];
    const alerts = alertStrip([], 0, "ready", "meetings", NOW, meetings);
    const debrief = alerts.find((a) => a.kind === "debrief_due");
    expect(debrief?.count).toBe(1);
    expect(debrief?.ctaTarget).toBe("meetings");
  });
  it("no meetings arg => no debrief_due alert (default param, back-compat)", () => {
    const alerts = alertStrip([{}], 0, "ready", "outreach", NOW);
    expect(alerts.some((a) => a.kind === "debrief_due")).toBe(false);
  });
});

describe("momentum gate MET at 5 sent intros through resolveRaise (Slice 6)", () => {
  it("5 sent intros in warm-up => momentum ready, next action opens the round", () => {
    const state = resolveRaise({
      raise: {
        current_phase: "warmup",
        readiness_snapshot: {
          dimensions: [{ key: "traction", status: "good" }],
        },
      },
      ask: "$500K",
      investors: [],
      intros: Array(5).fill({ status: "sent" }) as ResolverIntro[],
      meetings: [],
      followupsDueCount: 0,
      nowMs: NOW,
    });
    expect(state.momentum.ready).toBe(true);
    expect(state.momentum.sentCount).toBe(5);
    expect(state.next_action.ctaTarget).toBe("outreach");
  });
  it("4 sent intros => gate NOT met, still in warm-up", () => {
    const state = resolveRaise({
      raise: {
        current_phase: "warmup",
        readiness_snapshot: { dimensions: [{ key: "traction", status: "good" }] },
      },
      ask: "$500K",
      investors: [],
      intros: Array(4).fill({ status: "sent" }) as ResolverIntro[],
      meetings: [],
      followupsDueCount: 0,
      nowMs: NOW,
    });
    expect(state.momentum.ready).toBe(false);
    expect(state.next_action.ctaTarget).toBe("warmup");
  });
});

describe("nextRaiseAction — warm-up gate never fabricates 'on track'", () => {
  it("warm-up with <5 intros tells the founder exactly how many more", () => {
    const a = nextRaiseAction(
      "warmup",
      "$500K",
      [],
      Array(2).fill({ status: "sent" }),
      [],
      "ready",
    );
    expect(a.title.toLowerCase()).toContain("more warm intro");
    expect(a.reason).toContain("2 of 5");
  });
  it("warm-up with readiness not resolved routes back to prep", () => {
    const a = nextRaiseAction("warmup", "$500K", [], [], [], "not_ready");
    expect(a.ctaTarget).toBe("prep");
  });
});

describe("alertStrip", () => {
  const outreachy: ResolverInvestor[] = [
    { earliest_sent_at: daysAgo(10), replied: false },
    {},
  ];

  it("surfaces cold / untouched / followups / not_ready once outreach is open", () => {
    const kinds = alertStrip(outreachy, 3, "not_ready", "outreach", NOW).map(
      (a) => a.kind,
    );
    expect(kinds).toContain("cold");
    expect(kinds).toContain("followups_due");
    expect(kinds).toContain("untouched");
  });

  it("GATES the outreach-shaped alerts out of prep and warm-up", () => {
    for (const phase of ["prep", "warmup"] as const) {
      const kinds = alertStrip(outreachy, 3, "not_ready", phase, NOW).map(
        (a) => a.kind,
      );
      expect(kinds).not.toContain("cold");
      expect(kinds).not.toContain("followups_due");
      expect(kinds).not.toContain("untouched");
      expect(kinds).toContain("not_ready");
    }
  });

  it("never promises a gate the UI does not enforce", () => {
    const [notAssessed] = alertStrip([], 0, "not_assessed", "prep", NOW);
    expect(notAssessed.label).not.toMatch(/before you open the round/i);
  });

  it("suppresses only the duplicate chip, never one carrying its own count", () => {
    const next = nextRaiseAction(
      "outreach",
      null,
      outreachy,
      [],
      [],
      "ready",
      true,
      3,
    );
    const kept = suppressDuplicateAlerts(
      alertStrip(outreachy, 3, "ready", "outreach", NOW),
      next,
    ).map((a) => a.kind);
    expect(kept).not.toContain("untouched");
    expect(kept).toContain("cold");
    expect(kept).toContain("followups_due");
  });
});

describe("nextRaiseAction — no state yields a dead CTA", () => {
  const READINESS = ["not_assessed", "not_ready", "ready"] as const;
  const FUNNELS: Record<string, ResolverInvestor[]> = {
    empty: [],
    untouched: [{}],
    interested: [{ replied: true, earliest_sent_at: daysAgo(1) }],
    contacted: [{ earliest_sent_at: daysAgo(1), replied: false }],
  };
  const INTROS = { none: [], momentum: Array.from({ length: 6 }, () => ({ sent_at: daysAgo(1) })) };

  it("every (phase x readiness x funnel x intros x design x followups) combo is live", () => {
    let checked = 0;
    for (const phase of RAISE_PHASES) {
      for (const readiness of READINESS) {
        for (const investors of Object.values(FUNNELS)) {
          for (const intros of Object.values(INTROS)) {
            for (const designed of [false, true]) {
              for (const followups of [0, 3]) {
                const a = nextRaiseAction(
                  phase,
                  "$500K",
                  investors,
                  intros as never,
                  [],
                  readiness,
                  designed,
                  followups,
                );
                checked += 1;
                expect(a.ctaLabel.length).toBeGreaterThan(0);
                switch (a.action.kind) {
                  case "navigate":
                    expect(a.action.target).not.toBe(phase);
                    break;
                  case "open":
                    expect(RAISE_SECTION_IDS).toContain(a.action.sectionId);
                    if (a.action.sectionId === "fr-followups-due") {
                      expect(followups).toBeGreaterThan(0);
                    }
                    break;
                  case "run":
                    expect([
                      ADVISE_READINESS_PROMPT,
                      ADVISE_ROUND_DESIGN_PROMPT,
                    ]).toContain(a.action.prompt);
                    break;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(RAISE_PHASES.length * 3 * 4 * 2 * 2 * 2);
  });
});

describe("hasRoundDesign", () => {
  it("treats null / undefined / empty object as ABSENT", () => {
    expect(hasRoundDesign(null)).toBe(false);
    expect(hasRoundDesign(undefined)).toBe(false);
    expect(hasRoundDesign({})).toBe(false);
    expect(hasRoundDesign({ ask: "   " })).toBe(false);
    expect(hasRoundDesign({ unrelated: "x" })).toBe(false);
  });

  it("treats any populated design field as PRESENT", () => {
    expect(hasRoundDesign({ ask: "$500K" })).toBe(true);
    expect(hasRoundDesign({ cap: "$8M" })).toBe(true);
    expect(hasRoundDesign({ runway_months: 18 })).toBe(true);
  });

  it("drives the prep hand-off: design first, then warm-up", () => {
    const undesigned = nextRaiseAction("prep", null, [], [], [], "ready", false, 0);
    expect(undesigned.action).toEqual({
      kind: "run",
      prompt: ADVISE_ROUND_DESIGN_PROMPT,
      runKey: "round_design",
    });
    const designed = nextRaiseAction("prep", null, [], [], [], "ready", true, 0);
    expect(designed.action).toEqual({ kind: "navigate", target: "warmup" });
  });
});

describe("E3 send-rail boundary guard", () => {
  const NEW_FILES = [
    "src/services/fundraising/raise-resolver.ts",
    "src/routes/agents/fundraising-raise-phase.ts",
    "src/routes/agents/fundraising-raise-actions.ts",
    "src/routes/agents/fundraising-raise-gate.ts",
  ];
  const FORBIDDEN = [
    "fundraising_send_audit",
    "run-angel-round",
    "run_angel_round",
    "send_mode",
    "outbound-send",
    "sendgrid",
    "SendGrid",
    "gmail",
    "Gmail",
  ];
  it("no new resolver/source file references the send rail", () => {
    const backendRoot = join(__dirname, "..", "..", "..", "..");
    for (const rel of NEW_FILES) {
      const body = readFileSync(join(backendRoot, rel), "utf8");
      for (const sym of FORBIDDEN) {
        expect(body.includes(sym), `${rel} must not reference ${sym}`).toBe(false);
      }
    }
  });
});
