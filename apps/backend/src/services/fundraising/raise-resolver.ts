
export const RAISE_PHASES = [
  "prep",
  "warmup",
  "outreach",
  "meetings",
  "close",
] as const;
export type RaisePhase = (typeof RAISE_PHASES)[number];

export function isRaisePhase(v: unknown): v is RaisePhase {
  return typeof v === "string" && (RAISE_PHASES as readonly string[]).includes(v);
}

export const MOMENTUM_THRESHOLD = 5;

const COLD_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RaiseRow = {
  current_phase?: string | null;
  readiness_snapshot?: ReadinessSnapshot | null;
  round_design_snapshot?: RoundDesignSnapshot | null;
} | null;

export type ReadinessDimension = {
  key?: string;
  status?: "good" | "watch" | "gap" | string;
};
export type ReadinessSnapshot = {
  dimensions?: ReadinessDimension[];
} | null;

export type RoundDesignSnapshot = Record<string, unknown> | null;

export type ResolverInvestor = {
  outreach_state?: string | null;
  review_state?: string | null;
  stage?: string | null;
  replied?: boolean;
  sent_marker_count?: number;
  earliest_sent_at?: string | null;
};

export type ResolverIntro = {
  status?: string | null;
};

export type ResolverMeeting = {
  kind?: string | null;
  outcome?: string | null;
};

export type Funnel = {
  notContacted: number;
  contacted: number;
  interested: number;
  passed: number;
  total: number;
};

export type MomentumGate = {
  sentCount: number;
  threshold: number;
  ready: boolean;
};

export type Forecast = {
  committed: number;
  target: number | null;
  interestedCount: number;
  activeCount: number;
  softYesMeetings: number;
  projectedWeeks: number | null;
};

export type RaiseTopic =
  | "readiness"
  | "round_design"
  | "outreach_list"
  | "followups"
  | "meetings"
  | "close";

export type RaiseAction =
  | { kind: "navigate"; target: RaisePhase }
  | { kind: "run"; prompt: string; runKey: "readiness" | "round_design" }
  | { kind: "open"; sectionId: string };

export type NextAction = {
  eyebrow: string;
  title: string;
  reason: string;
  ctaLabel: string;
  ctaTarget: RaisePhase;
  action: RaiseAction;
  topic: RaiseTopic;
};

export type Alert = {
  kind: "cold" | "followups_due" | "untouched" | "not_ready" | "debrief_due";
  label: string;
  count: number;
  ctaTarget: RaisePhase;
  topic: RaiseTopic;
  suppressible: boolean;
};

export const ADVISE_READINESS_PROMPT =
  "Am I ready to raise? Assess my fundraising readiness across the key dimensions (traction, retention, provenance, revenue, narrative, materials).";
export const ADVISE_ROUND_DESIGN_PROMPT =
  "How much should I raise? Recommend my round design — the ask, cap, dilution, and runway — grounded in my company's real data.";

export const RAISE_SECTION_IDS = [
  "raise-readiness",
  "raise-warm-intros",
  "raise-meetings",
  "raise-close",
  "fr-full-list",
  "fr-followups-due",
] as const;
export type RaiseSectionId = (typeof RAISE_SECTION_IDS)[number];

const OUTREACH_PHASES: ReadonlySet<RaisePhase> = new Set<RaisePhase>([
  "outreach",
  "meetings",
  "close",
]);

export type ReadinessState = "not_assessed" | "not_ready" | "ready";

export function deriveRaisePhase(raise: RaiseRow): RaisePhase {
  const p = raise?.current_phase;
  return isRaisePhase(p) ? p : "prep";
}

export function readinessState(snap: ReadinessSnapshot | null | undefined): ReadinessState {
  if (!snap || !Array.isArray(snap.dimensions) || snap.dimensions.length === 0) {
    return "not_assessed";
  }
  const anyGap = snap.dimensions.some((d) => d?.status === "gap");
  return anyGap ? "not_ready" : "ready";
}

function classify(inv: ResolverInvestor): keyof Omit<Funnel, "total"> {
  const os = (inv.outreach_state ?? "").toLowerCase();
  const rs = (inv.review_state ?? "").toLowerCase();
  if (rs === "removed" || os === "passed") return "passed";
  if (
    inv.replied === true ||
    os === "replied" ||
    rs === "approved" ||
    (inv.stage ?? "").toLowerCase() === "committed"
  ) {
    return "interested";
  }
  const contacted =
    (inv.sent_marker_count ?? 0) > 0 ||
    Boolean(inv.earliest_sent_at) ||
    os === "sent" ||
    os === "paused" ||
    os === "completed";
  if (contacted) return "contacted";
  return "notContacted";
}

export function computeFunnel(investors: ResolverInvestor[]): Funnel {
  const f: Funnel = {
    notContacted: 0,
    contacted: 0,
    interested: 0,
    passed: 0,
    total: investors.length,
  };
  for (const inv of investors) f[classify(inv)] += 1;
  return f;
}

export function computeMomentumGate(intros: ResolverIntro[]): MomentumGate {
  const sentCount = intros.filter(
    (i) => (i.status ?? "").toLowerCase() === "sent",
  ).length;
  return {
    sentCount,
    threshold: MOMENTUM_THRESHOLD,
    ready: sentCount >= MOMENTUM_THRESHOLD,
  };
}

export function parseTargetAmount(ask: string | null | undefined): number | null {
  if (typeof ask !== "string") return null;
  const m = ask.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "b" ? 1e9 : unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

export function computeForecast(
  investors: ResolverInvestor[],
  meetings: ResolverMeeting[],
  ask: string | null | undefined,
): Forecast {
  const funnel = computeFunnel(investors);
  const committed = investors.filter(
    (i) => (i.stage ?? "").toLowerCase() === "committed",
  ).length;
  const softYesMeetings = meetings.filter(
    (m) => (m.outcome ?? "").toLowerCase() === "soft_yes",
  ).length;
  const target = parseTargetAmount(ask);
  const activeCount = funnel.contacted + funnel.interested;
  return {
    committed,
    target,
    interestedCount: funnel.interested,
    activeCount,
    softYesMeetings,
    projectedWeeks: committed > 0 ? Math.max(1, Math.ceil((activeCount + 1) / 2)) : null,
  };
}

export function alertStrip(
  investors: ResolverInvestor[],
  followupsDueCount: number,
  readiness: ReadinessState,
  phase: RaisePhase,
  nowMs: number,
  meetings: ResolverMeeting[] = [],
): Alert[] {
  const funnel = computeFunnel(investors);
  const alerts: Alert[] = [];

  const debriefDue = meetings.filter(
    (m) => (m.kind ?? "").toLowerCase() === "done" && !m.outcome,
  ).length;
  if (debriefDue > 0) {
    alerts.push({
      kind: "debrief_due",
      label: `${debriefDue} meeting${debriefDue === 1 ? "" : "s"} need a debrief`,
      count: debriefDue,
      ctaTarget: "meetings",
      topic: "meetings",
      suppressible: false,
    });
  }

  let coldCount = 0;
  for (const inv of investors) {
    if (inv.replied === true) continue;
    const t = inv.earliest_sent_at ? Date.parse(inv.earliest_sent_at) : NaN;
    if (!Number.isNaN(t) && nowMs - t >= COLD_DAYS * DAY_MS) coldCount += 1;
  }
  const outreachStarted = OUTREACH_PHASES.has(phase);

  if (outreachStarted && coldCount > 0) {
    alerts.push({
      kind: "cold",
      label: `${coldCount} investor${coldCount === 1 ? "" : "s"} going cold (no reply in ${COLD_DAYS}+ days)`,
      count: coldCount,
      ctaTarget: "outreach",
      topic: "outreach_list",
      suppressible: false,
    });
  }

  if (outreachStarted && followupsDueCount > 0) {
    alerts.push({
      kind: "followups_due",
      label: `${followupsDueCount} follow-up${followupsDueCount === 1 ? "" : "s"} due`,
      count: followupsDueCount,
      ctaTarget: "outreach",
      topic: "followups",
      suppressible: false,
    });
  }

  if (outreachStarted && funnel.notContacted > 0) {
    alerts.push({
      kind: "untouched",
      label: `${funnel.notContacted} investor${funnel.notContacted === 1 ? "" : "s"} not contacted yet`,
      count: funnel.notContacted,
      ctaTarget: "outreach",
      topic: "outreach_list",
      suppressible: true,
    });
  }

  if (readiness !== "ready" && (phase === "prep" || phase === "warmup")) {
    alerts.push({
      kind: "not_ready",
      label:
        readiness === "not_assessed"
          ? "You haven't assessed readiness yet"
          : "You're not ready to raise yet — close the flagged gaps first",
      count: 0,
      ctaTarget: "prep",
      topic: "readiness",
      suppressible: true,
    });
  }

  return alerts;
}

export function suppressDuplicateAlerts(
  alerts: Alert[],
  next: NextAction | null,
): Alert[] {
  if (!next) return alerts;
  return alerts.filter((a) => !(a.suppressible && a.topic === next.topic));
}

export function hasRoundDesign(
  snap: Record<string, unknown> | null | undefined,
): boolean {
  if (!snap || typeof snap !== "object") return false;
  return ["ask", "cap", "dilution_pct", "runway_months", "verdict"].some((k) => {
    const v = snap[k];
    return typeof v === "string" ? v.trim().length > 0 : v != null;
  });
}

export function nextRaiseAction(
  phase: RaisePhase,
  ask: string | null | undefined,
  investors: ResolverInvestor[],
  intros: ResolverIntro[],
  _meetings: ResolverMeeting[],
  readiness: ReadinessState,
  roundDesigned = false,
  followupsDueCount = 0,
): NextAction {
  const funnel = computeFunnel(investors);
  const momentum = computeMomentumGate(intros);

  switch (phase) {
    case "prep": {
      if (readiness === "not_assessed") {
        return {
          eyebrow: "Prep",
          title: "Assess your readiness",
          reason: "You haven't run a readiness assessment yet. Do that before you design the round.",
          ctaLabel: "Assess my readiness",
          ctaTarget: "prep",
          action: {
            kind: "run",
            prompt: ADVISE_READINESS_PROMPT,
            runKey: "readiness",
          },
          topic: "readiness",
        };
      }
      if (readiness === "not_ready") {
        return {
          eyebrow: "Prep",
          title: "You're not ready yet — close the flagged gaps",
          reason: "Your readiness assessment flagged at least one gap. Resolve it before opening the round.",
          ctaLabel: "Review the gaps",
          ctaTarget: "prep",
          action: { kind: "open", sectionId: "raise-readiness" },
          topic: "readiness",
        };
      }
      if (!roundDesigned) {
        return {
          eyebrow: "Prep",
          title: "Design the round",
          reason: "Readiness looks solid. Size the ask, cap, and runway before you start warming up intros.",
          ctaLabel: "Design the round",
          ctaTarget: "prep",
          action: {
            kind: "run",
            prompt: ADVISE_ROUND_DESIGN_PROMPT,
            runKey: "round_design",
          },
          topic: "round_design",
        };
      }
      return {
        eyebrow: "Prep",
        title: "Lock the round, then start warming up intros",
        reason: "Readiness looks solid and the round is designed. Move to warm-up.",
        ctaLabel: "Go to Warm-up",
        ctaTarget: "warmup",
        action: { kind: "navigate", target: "warmup" },
        topic: "round_design",
      };
    }
    case "warmup": {
      if (readiness === "not_ready" || readiness === "not_assessed") {
        return {
          eyebrow: "Warm-up",
          title: "Finish prep before you open the round",
          reason: "Readiness isn't resolved yet. Close that out before you rely on warm intros.",
          ctaLabel: "Back to Prep",
          ctaTarget: "prep",
          action: { kind: "navigate", target: "prep" },
          topic: "readiness",
        };
      }
      if (!momentum.ready) {
        const remaining = momentum.threshold - momentum.sentCount;
        return {
          eyebrow: "Warm-up",
          title: `Get ${remaining} more warm intro${remaining === 1 ? "" : "s"} in flight`,
          reason: `${momentum.sentCount} of ${momentum.threshold} warm intros sent. Momentum opens the round once you hit ${momentum.threshold}.`,
          ctaLabel: "Add warm intros",
          ctaTarget: "warmup",
          action: { kind: "open", sectionId: "raise-warm-intros" },
          topic: "outreach_list",
        };
      }
      return {
        eyebrow: "Warm-up",
        title: "Momentum is there — open the round",
        reason: `${momentum.sentCount} warm intros in flight. You've cleared the momentum gate.`,
        ctaLabel: "Go to Outreach",
        ctaTarget: "outreach",
        action: { kind: "navigate", target: "outreach" },
        topic: "outreach_list",
      };
    }
    case "outreach": {
      if (funnel.notContacted > 0) {
        return {
          eyebrow: "Outreach",
          title: `Reach the ${funnel.notContacted} investor${funnel.notContacted === 1 ? "" : "s"} you haven't contacted`,
          reason: `${funnel.contacted + funnel.interested} contacted, ${funnel.notContacted} still untouched.`,
          ctaLabel: "Work the list",
          ctaTarget: "outreach",
          action: { kind: "open", sectionId: "fr-full-list" },
          topic: "outreach_list",
        };
      }
      if (funnel.interested > 0) {
        return {
          eyebrow: "Outreach",
          title: `Book meetings with the ${funnel.interested} interested`,
          reason: "Everyone's been contacted. Convert the interested into meetings.",
          ctaLabel: "Go to Meetings",
          ctaTarget: "meetings",
          action: { kind: "navigate", target: "meetings" },
          topic: "meetings",
        };
      }
      return {
        eyebrow: "Outreach",
        title: "Keep working the pipeline",
        reason: "No replies yet. Follow up on the investors you've contacted.",
        ctaLabel: followupsDueCount > 0 ? "Review follow-ups" : "Work the list",
        ctaTarget: "outreach",
        action:
          followupsDueCount > 0
            ? { kind: "open", sectionId: "fr-followups-due" }
            : { kind: "open", sectionId: "fr-full-list" },
        topic: followupsDueCount > 0 ? "followups" : "outreach_list",
      };
    }
    case "meetings": {
      return {
        eyebrow: "Meetings",
        title: "Prep every upcoming meeting, debrief every finished one",
        reason: "Log outcomes within the hour so the pipeline stays honest.",
        ctaLabel: "Open Meetings",
        ctaTarget: "meetings",
        action: { kind: "open", sectionId: "raise-meetings" },
        topic: "meetings",
      };
    }
    case "close": {
      return {
        eyebrow: "Close",
        title: "Drive the interested to commit",
        reason: "Use the forecast to see the gap to target. Nothing is committed until it's committed.",
        ctaLabel: "Open Close",
        ctaTarget: "close",
        action: { kind: "open", sectionId: "raise-close" },
        topic: "close",
      };
    }
  }
}

export type RaiseState = {
  enabled: true;
  current_phase: RaisePhase;
  readiness_state: ReadinessState;
  next_action: NextAction;
  next_action_by_phase: Record<RaisePhase, NextAction>;
  funnel: Funnel;
  momentum: MomentumGate;
  forecast: Forecast;
  alerts: Alert[];
  alerts_by_phase: Record<RaisePhase, Alert[]>;
  readiness_snapshot: ReadinessSnapshot | null;
  round_design_snapshot: RoundDesignSnapshot | null;
};

export function resolveRaise(input: {
  raise: RaiseRow;
  ask: string | null | undefined;
  investors: ResolverInvestor[];
  intros: ResolverIntro[];
  meetings: ResolverMeeting[];
  followupsDueCount: number;
  nowMs: number;
}): RaiseState {
  const { raise, ask, investors, intros, meetings, followupsDueCount, nowMs } = input;
  const phase = deriveRaisePhase(raise);
  const readiness = readinessState(raise?.readiness_snapshot ?? null);
  const roundDesigned = hasRoundDesign(raise?.round_design_snapshot ?? null);

  const byPhase = {} as Record<RaisePhase, NextAction>;
  const alertsByPhase = {} as Record<RaisePhase, Alert[]>;
  for (const p of RAISE_PHASES) {
    const action = nextRaiseAction(
      p,
      ask,
      investors,
      intros,
      meetings,
      readiness,
      roundDesigned,
      followupsDueCount,
    );
    byPhase[p] = action;
    alertsByPhase[p] = suppressDuplicateAlerts(
      alertStrip(investors, followupsDueCount, readiness, p, nowMs, meetings),
      action,
    );
  }

  return {
    enabled: true,
    current_phase: phase,
    readiness_state: readiness,
    next_action: byPhase[phase],
    next_action_by_phase: byPhase,
    funnel: computeFunnel(investors),
    momentum: computeMomentumGate(intros),
    forecast: computeForecast(investors, meetings, ask),
    alerts: alertsByPhase[phase],
    alerts_by_phase: alertsByPhase,
    readiness_snapshot: raise?.readiness_snapshot ?? null,
    round_design_snapshot: raise?.round_design_snapshot ?? null,
  };
}
