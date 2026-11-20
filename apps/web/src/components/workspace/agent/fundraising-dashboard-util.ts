

export type InvestorDossier = {
  who: string;
  why_you: string;
  how_to_reach: string;
  best_channel: string;
  draft_message: string;
  no_draft_reason: string;
  what_theyll_push_on: string;
  sources: string[];
};

type RawDossier = {
  who_they_are?: unknown;
  why_this_company?: unknown;
  how_to_reach?: unknown;
  draft_message?: unknown;
  no_draft_reason?: unknown;
  pushbacks?: unknown;
  sources?: unknown;
  who?: unknown;
  why_you?: unknown;
  what_theyll_push_on?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function joinLines(parts: Array<string>): string {
  return parts.filter((p) => p.length > 0).join("\n\n");
}

export function normalizeDossier(raw: unknown): InvestorDossier | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as RawDossier;

  let reach = "";
  let bestChannel = "";
  if (typeof d.how_to_reach === "string") {
    reach = d.how_to_reach.trim();
  } else if (d.how_to_reach && typeof d.how_to_reach === "object") {
    const r = d.how_to_reach as Record<string, unknown>;
    bestChannel = str(r.best_channel);
    reach = joinLines([
      str(r.warm_path),
      bestChannel ? `Best channel: ${bestChannel}` : "",
      str(r.who_to_go_through) ? `Go through: ${str(r.who_to_go_through)}` : "",
    ]);
  }

  let push = str(d.what_theyll_push_on);
  if (!push && Array.isArray(d.pushbacks)) {
    push = joinLines(
      d.pushbacks.map((p) => {
        if (!p || typeof p !== "object") return "";
        const o = p as Record<string, unknown>;
        return joinLines([str(o.objection), str(o.honest_answer)]);
      }),
    );
  }

  const sources: string[] = Array.isArray(d.sources)
    ? d.sources
        .map((s) => {
          if (typeof s === "string") return s.trim();
          if (!s || typeof s !== "object") return "";
          const o = s as Record<string, unknown>;
          const url = str(o.url);
          const claim = str(o.claim);
          return url && claim ? `${url} · ${claim}` : url || claim;
        })
        .filter((s) => s.length > 0)
    : [];

  return {
    who: str(d.who_they_are) || str(d.who),
    why_you: str(d.why_this_company) || str(d.why_you),
    how_to_reach: reach,
    best_channel: bestChannel,
    draft_message: str(d.draft_message),
    no_draft_reason: str(d.no_draft_reason),
    what_theyll_push_on: push,
    sources,
  };
}

export function investorDossier(
  inv: FundraisingInvestor,
): InvestorDossier | null {
  return normalizeDossier(inv.dossier);
}

export function hasDossier(inv: FundraisingInvestor): boolean {
  const d = inv.dossier;
  return Boolean(d) && typeof d === "object" && !Array.isArray(d);
}

export type FundraisingInvestor = {
  firm: string;
  name: string;
  tier: number;
  fit_rationale: string;
  source: string;
  source_url: string;
  review_key?: string;
  identity_key?: string;
  review_state?: "undecided" | "approved" | "saved" | "removed";
  last_sent_at?: string | null;
  sent_markers?: Array<{ channel: string; sent_at: string }>;
  replied?: boolean;
  contact_hint?: string;
  durable_email?: string | null;
  dossier?: unknown;
};

export function investorKey(inv: FundraisingInvestor): string {
  return (
    inv.review_key ??
    inv.identity_key ??
    `${inv.firm.trim().toLowerCase()}|${inv.name.trim().toLowerCase()}`
  );
}

export function investorWriteKey(inv: FundraisingInvestor): string | null {
  return inv.review_key ?? inv.identity_key ?? null;
}

export type InvestorStatus =
  | "new"
  | "researched"
  | "reached out"
  | "replied"
  | "passed";

export function investorStatus(inv: FundraisingInvestor): InvestorStatus {
  if (inv.review_state === "removed") return "passed";
  if (inv.replied === true) return "replied";
  if ((inv.sent_markers?.length ?? 0) > 0 || Boolean(inv.last_sent_at)) {
    return "reached out";
  }
  if (hasDossier(inv)) return "researched";
  return "new";
}

export function hasNamedPartner(inv: FundraisingInvestor): boolean {
  return inv.name.trim().length > 0;
}

export function hasEmailOnFile(inv: FundraisingInvestor): boolean {
  return Boolean(inv.durable_email && inv.durable_email.trim().length > 0);
}

export type OutreachChannel = "email" | "linkedin" | "twitter" | "warm_intro";

export const OUTREACH_CHANNELS: ReadonlyArray<{
  value: OutreachChannel;
  label: string;
}> = [
  { value: "email", label: "email" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "twitter", label: "X" },
  { value: "warm_intro", label: "warm intro" },
];

export function channelLabel(channel: OutreachChannel): string {
  return (
    OUTREACH_CHANNELS.find((c) => c.value === channel)?.label ?? channel
  );
}

const CHANNEL_PATTERNS: ReadonlyArray<[OutreachChannel, RegExp]> = [
  ["email", /\b(e-?mails?|e-?mailing)\b/],
  ["linkedin", /\blinked[\s-]?in\b/],
  ["twitter", /\b(twitter|tweets?|x\.com|x)\b/],
  ["warm_intro", /\b(warm[\s-]?intro\w*|intro|introduction|warm[\s-]?path)\b/],
];

const NEGATION_RE = /\b(not|no|never|avoid|don'?t|do not|rather than|instead of|without|except)\b/;

export function mapOutreachChannel(raw: string): OutreachChannel | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (NEGATION_RE.test(v)) return null;
  const hits = CHANNEL_PATTERNS.filter(([, re]) => re.test(v)).map(([c]) => c);
  const distinct = Array.from(new Set(hits));
  return distinct.length === 1 ? distinct[0] : null;
}

export function investorOutreachChannel(
  inv: FundraisingInvestor,
): OutreachChannel | null {
  const d = investorDossier(inv);
  return d ? mapOutreachChannel(d.best_channel) : null;
}

export function tierOf(tier: number): 1 | 2 | 3 {
  return tier === 1 ? 1 : tier === 2 ? 2 : 3;
}

export function tierLabel(tier: 1 | 2 | 3): string {
  return tier === 1
    ? "Tier 1: strong fit"
    : tier === 2
      ? "Tier 2: solid"
      : "Tier 3: broader";
}

export function splitTiers(list: FundraisingInvestor[]): {
  tier1: FundraisingInvestor[];
  tier2: FundraisingInvestor[];
  tier3: FundraisingInvestor[];
} {
  return {
    tier1: list.filter((i) => tierOf(i.tier) === 1),
    tier2: list.filter((i) => tierOf(i.tier) === 2),
    tier3: list.filter((i) => tierOf(i.tier) === 3),
  };
}

export type ListCounts = {
  total: number;
  noPartner: number;
  withEmail: number;
  researched: number;
};

export function listCounts(list: FundraisingInvestor[]): ListCounts {
  return {
    total: list.length,
    noPartner: list.filter((i) => !hasNamedPartner(i)).length,
    withEmail: list.filter(hasEmailOnFile).length,
    researched: list.filter((i) => hasDossier(i)).length,
  };
}

export function researchSentence(researched: number): string {
  if (researched === 0) {
    return "Nothing has been researched deeply yet. Start with a Tier 1 name.";
  }
  if (researched === 1) {
    return "One deep round done. One more and Zavi can sequence an outreach plan.";
  }
  return `${researched} researched deeply.`;
}

export type NextStepAction =
  | { kind: "deep_top"; count: number }
  | { kind: "build_plan" }
  | { kind: "open_plan" };

export type NextStep = {
  key:
    | "researching"
    | "deep_first"
    | "deep_one_more"
    | "build_plan"
    | "send_yourself"
    | "nothing_pending";
  title: string;
  why: string;
  cta: string | null;
  action: NextStepAction | null;
};

export function computeNextStep(input: {
  investors: FundraisingInvestor[];
  researching: ReadonlySet<string>;
  planBuilt: boolean;
}): NextStep {
  const { investors, researching, planBuilt } = input;
  const researchedCount = investors.filter((i) => hasDossier(i)).length;

  if (researching.size > 0) {
    const n = researching.size;
    return {
      key: "researching",
      title: `Researching ${n} investor${n > 1 ? "s" : ""}`,
      why: "Each one reads their team page, recent filings, and anything they've said publicly, then grounds every claim to a source.",
      cta: null,
      action: null,
    };
  }

  const tier1Todo = investors.filter(
    (i) =>
      tierOf(i.tier) === 1 &&
      !hasDossier(i) &&
      !researching.has(investorKey(i)) &&
      investorStatus(i) !== "passed",
  );

  if (researchedCount === 0 && tier1Todo.length > 0) {
    const n = Math.min(5, tier1Todo.length);
    return {
      key: "deep_first",
      title: `Deep round your ${n} strongest Tier 1 name${n > 1 ? "s" : ""}`,
      why: "You can't reach a firm, you reach a person. A deep round is what finds the person, the warm path, and what they'll push back on. Start at the top of Tier 1.",
      cta: `Deep round these ${n}`,
      action: { kind: "deep_top", count: n },
    };
  }

  if (researchedCount === 1 && tier1Todo.length > 0) {
    return {
      key: "deep_one_more",
      title: "Deep round one more",
      why: "One dossier isn't a plan. With two, Zavi can sequence who to approach first and what to lead with for each.",
      cta: "Deep round the next Tier 1",
      action: { kind: "deep_top", count: 1 },
    };
  }

  if (researchedCount >= 2 && !planBuilt) {
    const warm = investors.filter(
      (i) => hasDossier(i) && hasNamedPartner(i),
    ).length;
    return {
      key: "build_plan",
      title: "Build your outreach plan",
      why: `${researchedCount} investors researched${warm > 0 ? `, ${warm} with a named partner` : ""}. Enough to put them in order rather than contacting whoever's on top.`,
      cta: "Build outreach plan",
      action: { kind: "build_plan" },
    };
  }

  const unsent = investors.filter(
    (i) =>
      hasDossier(i) &&
      hasNamedPartner(i) &&
      investorStatus(i) === "researched",
  );
  if (unsent.length > 0) {
    const n = unsent.length;
    return {
      key: "send_yourself",
      title: `Send ${n} draft${n > 1 ? "s" : ""} yourself, then mark ${n > 1 ? "them" : "it"}`,
      why: "This is where Zavi stops. It doesn't send, and it won't chase you about it. Copy each draft, send it from your own inbox, then mark it here. Marking is the only thing keeping this list honest next week.",
      cta: "Open the plan",
      action: { kind: "open_plan" },
    };
  }

  const anyTodo = investors.filter(
    (i) => !hasDossier(i) && investorStatus(i) !== "passed",
  ).length;
  return {
    key: "nothing_pending",
    title: "Nothing pending from Zavi",
    why:
      researchedCount > 0
        ? "Everything you've researched is marked. Deep round more names whenever you want to widen the list. That's the only thing left that Zavi does."
        : investors.length === 0
          ? "No investors saved yet. Ask the Fundraising agent in chat for some."
          : "Nothing researched yet. Deep round a name from your list whenever you're ready.",
    cta: anyTodo > 0 ? "Deep round 5 more" : null,
    action: anyTodo > 0 ? { kind: "deep_top", count: 5 } : null,
  };
}

export type DeepRoundFailure =
  | "dispatch_failed"
  | "run_failed"
  | "no_dossier";

export function deepRoundFailureNotice(
  failure: DeepRoundFailure,
  firm: string,
): string {
  const who = firm.trim() || "this investor";
  if (failure === "dispatch_failed") {
    return `Zavi couldn't start a deep round on ${who}. Nothing ran, and nothing was spent. Try again.`;
  }
  if (failure === "run_failed") {
    return `The deep round on ${who} finished without a usable result, so nothing was saved. Try again.`;
  }
  return `The deep round on ${who} finished, but no dossier came back. Try again.`;
}

export function deepRoundFailureShort(failure: DeepRoundFailure): string {
  if (failure === "dispatch_failed") return "didn't start";
  if (failure === "run_failed") return "came back empty";
  return "no dossier";
}

export function pickForDeepRound(
  investors: FundraisingInvestor[],
  researching: ReadonlySet<string>,
  count: number,
): FundraisingInvestor[] {
  const eligible = investors.filter(
    (i) =>
      !hasDossier(i) &&
      !researching.has(investorKey(i)) &&
      investorStatus(i) !== "passed",
  );
  const byTier = [
    ...eligible.filter((i) => tierOf(i.tier) === 1),
    ...eligible.filter((i) => tierOf(i.tier) === 2),
    ...eligible.filter((i) => tierOf(i.tier) === 3),
  ];
  return byTier.slice(0, Math.max(0, count));
}

export function applyStatusOverride(
  inv: FundraisingInvestor,
  status: InvestorStatus,
  now: string,
): FundraisingInvestor {
  switch (status) {
    case "passed":
      return { ...inv, review_state: "removed" };
    case "replied":
      return { ...inv, review_state: "undecided", replied: true };
    case "reached out":
      return {
        ...inv,
        review_state: "undecided",
        replied: false,
        last_sent_at: inv.last_sent_at ?? now,
      };
    case "researched":
    case "new":
      return {
        ...inv,
        review_state: "undecided",
        replied: false,
        last_sent_at: null,
        sent_markers: [],
      };
  }
}

export type OutreachPlan = {
  goFirst: FundraisingInvestor[];
  researchFirst: FundraisingInvestor[];
  unresearched: number;
};

export function buildOutreachPlan(
  list: FundraisingInvestor[],
): OutreachPlan {
  const researched = list.filter((i) => hasDossier(i));
  return {
    goFirst: researched.filter(hasNamedPartner),
    researchFirst: researched.filter((i) => !hasNamedPartner(i)),
    unresearched: list.length - researched.length,
  };
}

export function sourceLabel(source: string): string {
  return source.trim().toLowerCase() === "investor_db"
    ? "from the investor DB"
    : "found on the web";
}

export function asHref(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  const full = v.match(/https?:\/\/[^\s]+/i);
  if (full) return full[0];
  const domain = v.match(/[\w-]+(?:\.[\w-]+)+(?:\/[^\s]*)?/);
  if (domain) return `https://${domain[0]}`;
  return null;
}
