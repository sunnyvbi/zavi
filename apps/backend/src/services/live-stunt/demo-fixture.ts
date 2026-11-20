import { parseLiveRun } from "./config";
import { toPublicPayload, type LiveUpcarPublic, type StoredDay } from "./public-view";
import type { StuntSnapshot } from "./snapshot";
import type { Entry } from "./draft";

export const liveStuntDemoOn = () => process.env.LIVE_STUNT_DEMO === "1" && process.env.NODE_ENV !== "production";

const demoCfg = (slug: string) =>
  parseLiveRun(slug, {
    tenant_id: "00000000-0000-4000-8000-000000000000",
    start_at: "2026-10-01T00:00:00-04:00",
    unlock_at: "2026-10-13T09:00:00-04:00",
    end_at: "2026-10-30T23:59:59-04:00",
    budget_usd: 25000,
    goals: { bookings: 600, hosts: 500 },
    public: true,
    home_pill: slug === "upcar",
  })!;
const DAILY = [
  [14, 12, 480], [16, 13, 560], [18, 15, 640], [17, 16, 700], [15, 14, 660], [19, 15, 620], [19, 17, 660],
  [21, 17, 880], [24, 19, 950], [22, 18, 980], [25, 20, 1000], [27, 22, 1040], [22, 22, 670],
];
const snapshot: StuntSnapshot = {
  taken_at: "2026-10-13T22:00:00.000Z", day: 13,
  pace: { bookings_per_week: 119, hosts_per_week: 118 },
  last_review_at: "2026-10-13T21:48:00.000Z", changes_today: 1, channels_today: ["Meta"],
  by_day: DAILY.map(([hosts, bookings, spent], i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, hosts, bookings, spent_usd: spent })),
};

type E = Omit<Entry, "day">;
const e = (x: Partial<E> & Pick<E, "kind" | "headline">): E => ({ channels: [], work: [], why: null, budget: [], spent_usd: null, bookings: null, hosts: null, ...x });
const ENTRIES: [number, E, E][] = [
  [1, e({ kind: "PLAN", headline: "Split the $25,000 and started two campaigns.", channels: ["Google", "Meta"], work: ["Read 8 weeks of Upcar bookings, searches and host sign-ups", "Wrote the plan: $15K on bookings, $10K on new hosts", "Launched a Google search campaign for “car rental near me”", "Launched Meta ads for renters"], why: "Upcar has more cars than renters right now, so demand comes first.", budget: [{ channel: "Google", from_usd: 0, to_usd: 120 }, { channel: "Meta", from_usd: 0, to_usd: 360 }], spent_usd: 480, bookings: 12, hosts: 14 }),
      e({ kind: "PLAN", headline: "Split the $25,000 and started two campaigns.", channels: ["Google", "Meta"], work: ["Read 8 weeks of Upcar bookings, searches and host sign-ups", "Launched a Google search campaign for “car rental near me”", "Launched Meta ads for renters"], budget: [{ channel: "Google", from_usd: null, to_usd: null }, { channel: "Meta", from_usd: null, to_usd: null }] })],
  [3, e({ kind: "WIN", headline: "My Meta host ad works. Doubled its budget.", channels: ["Meta", "YouTube"], work: ["Compared the two host ads", "Moved the weaker ad's money to the stronger one", "Started a YouTube test for renters"], why: "“Earn with the car you already own” brings new hosts at $28 each, under what I planned.", budget: [{ channel: "Meta", from_usd: 150, to_usd: 300 }, { channel: "YouTube", from_usd: 0, to_usd: 200 }], spent_usd: 640, bookings: 15, hosts: 18 }),
      e({ kind: "WORK", headline: "Changed 2 budgets across Meta and YouTube.", channels: ["Meta", "YouTube"], work: ["Compared the two host ads", "Started a YouTube test for renters"], budget: [{ channel: "Meta", from_usd: null, to_usd: null }, { channel: "YouTube", from_usd: null, to_usd: null }] })],
  [5, e({ kind: "LOSS", headline: "My YouTube test flopped. Stopped it.", channels: ["YouTube"], work: ["Counted it up: $400 spent, 2 bookings", "Stopped the YouTube campaign"], why: "$200 a booking is about 4x what search costs.", budget: [{ channel: "YouTube", from_usd: 200, to_usd: 0 }], spent_usd: 660, bookings: 14, hosts: 15 }),
      e({ kind: "WORK", headline: "Changed a YouTube budget.", channels: ["YouTube"], budget: [{ channel: "YouTube", from_usd: null, to_usd: null }] })],
  [8, e({ kind: "HUMAN", headline: "Upcar's engineers shipped my cancellation fix.", channels: ["Upcar app"], work: ["Handed the proposal to Upcar's engineers", "They shipped it. A person did this, so it's logged here."], why: "I can't change Upcar's code myself.", spent_usd: 880, bookings: 17, hosts: 21 }),
      e({ kind: "HUMAN", headline: "Upcar's engineers shipped my cancellation fix.", channels: ["Upcar app"] })],
  [9, e({ kind: "CHANGE", headline: "Moved $100/day from Meta renter ads to Google search.", channels: ["Meta", "Google"], work: ["Compared cost per booking, Google vs Meta, days 1 to 8", "Kept Meta renter ads running, smaller, to keep learning"], why: "Bookings from search cost less than bookings from Meta. Same money, more bookings.", budget: [{ channel: "Meta", from_usd: 360, to_usd: 260 }, { channel: "Google", from_usd: 120, to_usd: 220 }], spent_usd: 950, bookings: 19, hosts: 24 }),
      e({ kind: "WORK", headline: "Changed 2 budgets across Meta and Google.", channels: ["Meta", "Google"] })],
  [12, e({ kind: "LOSS", headline: "My new renter ad got clicks but no bookings. Paused it.", channels: ["Meta"], work: ["48 hours in: lots of clicks, 0 bookings", "Started writing replacements"], why: "Clicks aren't bookings. The line didn't say why Upcar over a rental counter.", budget: [{ channel: "Meta", from_usd: 80, to_usd: 0 }], spent_usd: 1040, bookings: 22, hosts: 27 }),
      e({ kind: "WORK", headline: "Changed a Meta budget.", channels: ["Meta"] })],
];
const days: StoredDay[] = ENTRIES.map(([d, full, neutral]) => {
  const day = `2026-10-${String(d).padStart(2, "0")}`;
  return { day, status: "published", full_entry: { ...full, day }, neutral_entry: { ...neutral, day }, edited_headline: null, edited_why: null, edited_kind: null };
});

function demoTestPayload(slug: string): LiveUpcarPublic {
  const cfg = parseLiveRun(slug, {
    tenant_id: "00000000-0000-4000-8000-000000000000",
    start_at: "2026-09-28T09:00:00-04:00",
    end_at: "2026-09-30T23:59:59-04:00",
    budget_usd: 500,
    goals: { bookings: 40, hosts: 30 },
    public: true,
  })!;
  const now = new Date("2026-09-29T20:00:00Z");
  const snap: StuntSnapshot = {
    taken_at: now.toISOString(), day: 2,
    pace: { bookings_per_week: 119, hosts_per_week: 118 },
    last_review_at: new Date(now.getTime() - 9 * 60000).toISOString(), changes_today: 1, channels_today: ["Meta"],
    by_day: [
      { day: "2026-09-28", bookings: 14, hosts: 12, spent_usd: 150 },
      { day: "2026-09-29", bookings: 9, hosts: 8, spent_usd: 110 },
    ],
  };
  const testDays: StoredDay[] = [
    { day: "2026-09-28", status: "published", edited_headline: null, edited_why: null, edited_kind: null,
      full_entry: { day: "2026-09-28", kind: "PLAN", headline: "Changed 2 budgets across Meta and Google.", channels: ["Meta", "Google"], work: ["Read 8 weeks of Upcar bookings and host sign-ups", "Launched Meta ads for new hosts", "Launched a Google search campaign for renters"], why: "A small test: check every step works before the real month.", budget: [{ channel: "Meta", from_usd: 0, to_usd: 100 }, { channel: "Google", from_usd: 0, to_usd: 60 }], spent_usd: 150, bookings: 14, hosts: 12 },
      neutral_entry: { day: "2026-09-28", kind: "PLAN", headline: "Changed 2 budgets across Meta and Google.", channels: ["Meta", "Google"], work: [], why: null, budget: [], spent_usd: null, bookings: null, hosts: null } },
  ];
  const p = toPublicPayload({ snapshot: snap, days: testDays, cfg, now });
  return { ...p, as_of: "demo", demo_now: now.toISOString() } as LiveUpcarPublic;
}

export function demoPayload(slug: string, locked: boolean): LiveUpcarPublic {
  if (slug.endsWith("-test")) return demoTestPayload(slug);
  const cfg = demoCfg(slug);
  const now = locked ? new Date("2026-10-06T22:00:00Z") : new Date("2026-10-13T22:00:00Z");
  const reviewedAt = new Date(now.getTime() - 12 * 60000).toISOString();
  const snap = { ...(locked ? { ...snapshot, day: 6, by_day: snapshot.by_day.slice(0, 6) } : snapshot), last_review_at: reviewedAt };
  const p = toPublicPayload({ snapshot: snap, days: locked ? days.filter((d) => d.day <= "2026-10-06") : days, cfg, now });
  return { ...p, as_of: "demo", demo_now: now.toISOString() } as LiveUpcarPublic;
}

export function demoReview() {
  const [, full, neutral] = ENTRIES[4];
  return { day: "2026-10-09", status: "draft", full: { ...full, day: "2026-10-09" }, neutral: { ...neutral, day: "2026-10-09" }, edited_headline: null, edited_why: null, edited_kind: null, expires_at: "2026-10-12T23:30:00-04:00" };
}
