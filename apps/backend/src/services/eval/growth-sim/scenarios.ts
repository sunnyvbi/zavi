
import type { DayLog, RunLog, Scenario, SimApplied } from "./types";

const days = 14;
const by = (log: RunLog, day: number) => log.days.filter((d) => d.day <= day);
const applied = (ds: DayLog[]) => ds.flatMap((d) => (d.applied ? [d.applied] : []));
const paused = (ds: DayLog[], slug: string) => applied(ds).some((a) => a.channelPauses.some((p) => p.slug === slug));
const anyChange = (ds: DayLog[]) =>
  applied(ds).some((a) => a.goalChanges.length + a.channelPauses.length + a.moves.length > 0);
const has = (lines: string[], words: string[]) => lines.some((l) => words.some((w) => l.toLowerCase().includes(w)));
const noteText = (d: { applied: SimApplied }): string[] => [
  ...d.applied.note.saw,
  ...d.applied.note.changed,
  ...d.applied.note.need,
  ...(d.applied.note.would ?? []),
  ...d.applied.channelPauses.map((p) => `${p.slug} ${p.why}`),
  ...d.applied.goalChanges.map((g) => g.why),
  ...d.applied.moves.map((m) => m.what),
];
const reviews = (log: RunLog, day: number) =>
  by(log, day).filter((d): d is DayLog & { view: NonNullable<DayLog["view"]>; applied: NonNullable<DayLog["applied"]> } =>
    d.view !== null && d.applied !== null,
  );
const ignoredOn = (d: { view: NonNullable<DayLog["view"]> }, slug: string) => {
  const k = d.view.channels.find((c) => c.slug === slug)?.cards14d;
  if (!k || k.approved + k.rejected > 0) return false;
  return k.pending >= 3 || (k.oldestPendingAge ?? 0) >= 5 || k.seenNotActed >= 3;
};

const saas = (id: string, addedBy: "plan" | "founder", autopilot: boolean, pass: Scenario["pass"]): Scenario => ({
  id,
  business: "B2B SaaS: invoicing tool for freelancers",
  outcomeLabel: "trials",
  goal: { objective: "Get 40 trial signups this month", target: 40, dueDays: 30, baseline: 0 },
  channels: [
    { slug: "reddit_organic", addedBy, cardsPerDay: 1, visitsPerApproved: 40 },
    { slug: "email_marketing", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 60 },
  ],
  founder: {
    policy: {
      reddit_organic: { seen: 0.8, approve: 0, reject: 0 },
      email_marketing: { seen: 1, approve: 1, reject: 0 },
    },
    answers: {},
  },
  world: { baseVisitsPerDay: 20, conversion: 0.025 },
  autopilot,
  days,
  pass,
});

export const SCENARIOS: Scenario[] = [
  saas("1-saas-reddit-ignored", "plan", true, {
    dueDay: 14,
    describe:
      "by day 10 cgo asks about the never-approved Reddit with pause as the stated default; it never pauses it outright; by day 14, the founder still silent, Reddit is paused; email stays active",
    check: (log) => {
      const askDay = reviews(log, 10).find((d) => ignoredOn(d, "reddit_organic") && d.applied.note.need.some((l) => /reddit/i.test(l) && /pause/i.test(l)))?.day;
      if (askDay === undefined) return false;
      const outright = log.days.some((d) => d.day < askDay + 2 && d.applied?.channelPauses.some((p) => p.slug === "reddit_organic"));
      const pausedBy14 = by(log, 14).some((d) => d.snapshot.paused.includes("reddit_organic"));
      return !outright && pausedBy14 && !by(log, 14).some((d) => d.snapshot.paused.includes("email_marketing"));
    },
  }),
  saas("1b-saas-reddit-founder-added", "founder", true, {
    dueDay: 10,
    describe: "by day 10: founder-added Reddit NOT paused and `need` mentions Reddit",
    check: (log) =>
      !paused(log.days, "reddit_organic") &&
      reviews(log, 10).some((d) => ignoredOn(d, "reddit_organic") && has(d.applied.note.need, ["reddit"])),
  }),
  saas("1c-saas-reddit-autopilot-off", "plan", false, {
    dueDay: 10,
    describe: "autopilot OFF: a note names Reddit by day 10, nothing applied over 14 days",
    check: (log) =>
      reviews(log, 10).some((d) => ignoredOn(d, "reddit_organic") && has(noteText(d), ["reddit"])) && !anyChange(log.days),
  }),
  {
    id: "2-dtc-ads-rejected",
    business: "DTC skincare shop",
    outcomeLabel: "orders",
    goal: { objective: "150 orders this month", target: 150, dueDays: 30, baseline: 0 },
    channels: [
      { slug: "meta_ads", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 150 },
      { slug: "instagram_organic", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 100 },
    ],
    founder: {
      policy: {
        meta_ads: { seen: 1, approve: 0, reject: 1 },
        instagram_organic: { seen: 1, approve: 1, reject: 0 },
      },
      answers: {},
    },
    world: { baseVisitsPerDay: 60, conversion: 0.03 },
    autopilot: true,
    days,
    pass: {
      dueDay: 10,
      describe: "by day 10: `need` asks about budget or the rejections; ad channel not paused",
      check: (log) =>
        reviews(log, 10).some((d) => {
          const k = d.view.channels.find((c) => c.slug === "meta_ads")?.cards14d;
          return !!k && k.rejected >= 1 && k.approved === 0 && has(d.applied.note.need, ["budget", "reject"]);
        }) && !paused(by(log, 10), "meta_ads"),
    },
  },
  {
    id: "3-dental-landing-page",
    business: "Local dental clinic",
    outcomeLabel: "bookings",
    goal: { objective: "60 new-patient bookings this month", target: 60, dueDays: 30, baseline: 0 },
    channels: [
      { slug: "seo", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 150 },
      { slug: "instagram_organic", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 100 },
      { slug: "x_organic", addedBy: "plan", cardsPerDay: 1 / 14, visitsPerApproved: 20 },
    ],
    founder: {
      policy: {
        seo: { seen: 1, approve: 1, reject: 0 },
        instagram_organic: { seen: 1, approve: 1, reject: 0 },
        x_organic: { seen: 1, approve: 1, reject: 0 },
      },
      answers: {},
    },
    world: { baseVisitsPerDay: 30, conversion: 0.004 },
    autopilot: true,
    days,
    pass: {
      dueDay: 14,
      describe: "by day 14: `saw` names conversion / landing page and an engineer move for the page",
      check: (log) => {
        const found = reviews(log, 14).some(
          (d) => d.view.tiles7d.visits >= 100 && d.view.tiles7d.conversionPct < 1 && has(noteText(d), ["conversion", "landing"]),
        );
        const eng = applied(by(log, 14)).flatMap((a) => a.moves).filter((m) => m.target_agent === "engineer");
        return found && eng.some((m) => has([m.what], ["page", "landing", "site", "conversion"]));
      },
    },
  },
  {
    id: "4-marketplace-founder-silent",
    business: "Two-sided marketplace: tutors and parents",
    outcomeLabel: "tutor signups",
    goal: { objective: "20 tutor signups this month", target: 20, dueDays: 30, baseline: 0 },
    channels: [{ slug: "linkedin_organic", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 30 }],
    founder: {
      policy: { linkedin_organic: { seen: 1, approve: 1, reject: 0 } },
      silentFromDay: 4,
      answers: {},
    },
    world: { baseVisitsPerDay: 45, conversion: 0.02 },
    autopilot: true,
    days,
    pass: {
      dueDay: 11,
      describe:
        "through day 11 while the founder is away: no goal/channel changes, no moves, no nagging (at most one note sent); either that note names the silence with 1-2 asks, or nothing is sent because a question is already waiting",
      check: (log) => {
        const silent = reviews(log, 11).filter((d) => d.view.founder.daysSilent >= 7);
        const quiet = silent.every((d) => d.applied.goalChanges.length + d.applied.channelPauses.length + d.applied.moves.length === 0);
        const sent = silent.filter((d) => d.applied.note.sent !== false);
        const named = sent.some(
          (d) =>
            noteText(d).some((l) => /silent|quiet|nothing from you|no activity|inactiv|away|absen|last active|haven't been in/i.test(l)) &&
            d.applied.note.need.length >= 1 &&
            d.applied.note.need.length <= 2,
        );
        const waiting = silent.length > 0 && silent[0].snapshot.openAsks > 0;
        return silent.length > 0 && quiet && sent.length <= 1 && (named || (sent.length === 0 && waiting));
      },
    },
  },
  {
    id: "5-newsletter-goal-unreachable",
    business: "Paid newsletter for indie game developers",
    outcomeLabel: "subscribers",
    goal: { objective: "2,000 subscribers in four weeks", target: 2000, dueDays: 28, baseline: 0 },
    channels: [{ slug: "x_organic", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 30 }],
    founder: { policy: { x_organic: { seen: 1, approve: 1, reject: 0 } }, answers: {} },
    world: { baseVisitsPerDay: 380, conversion: 0.035 },
    autopilot: true,
    days,
    pass: {
      dueDay: 14,
      describe:
        "after 5+ days of data, cgo asks the founder whether to change the unreachable goal (naming the pace or a new number) and never makes it easier itself",
      check: (log) => {
        const rs = reviews(log, 14);
        const eased = rs.some((d) =>
          d.applied.goalChanges.some((g) => (g.undo ? g.target < g.undo.target : false) || (g.dueDays !== undefined && g.dueDays > 28)),
        );
        const asked = rs.some(
          (d) => d.day >= 5 && d.applied.note.need.some((l) => /target|goal|pace|date|\b\d{2,}\b/i.test(l) && /\?/.test(l)),
        );
        return asked && !eased;
      },
    },
  },
  {
    id: "C-healthy-control",
    business: "B2B SaaS: scheduling tool for clinics",
    outcomeLabel: "trials",
    goal: { objective: "30 trial signups this month", target: 30, dueDays: 30, baseline: 0 },
    channels: [
      { slug: "email_marketing", addedBy: "plan", cardsPerDay: 1, visitsPerApproved: 40 },
      { slug: "seo", addedBy: "plan", cardsPerDay: 0.5, visitsPerApproved: 30 },
    ],
    founder: {
      policy: {
        email_marketing: { seen: 1, approve: 1, reject: 0 },
        seo: { seen: 1, approve: 1, reject: 0 },
      },
      answers: {},
    },
    world: { baseVisitsPerDay: 30, conversion: 0.02 },
    autopilot: true,
    days,
    pass: {
      dueDay: 14,
      describe: "no pause, no goal cut (a raise is fine), at most 2 new cards over 14 days",
      check: (log) => {
        const a = applied(log.days);
        const paused = a.some((x) => x.channelPauses.length > 0);
        const cut =
          log.final.goal.changes.some((c) => c.to < c.from) || a.some((x) => x.goalChanges.some((g) => g.targetMetric !== undefined));
        const cards = a.reduce((n, x) => n + x.moves.length, 0);
        return !paused && !cut && cards <= 2;
      },
    },
  },
];

const sealed: Scenario[] = [];
export function registerSealedScenario(s: Scenario): void {
  sealed.push(s);
}
export function allScenarios(): Scenario[] {
  return [...SCENARIOS, ...sealed];
}
