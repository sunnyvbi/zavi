
import { describe, expect, it } from "vitest";
import {
  MIN_GAP_MS,
  WAIT_CAP_MS,
  channelOrderFor,
  doneSteps,
  isLegacyRow,
  needsFacts,
  planNext,
  type PlanDecision,
  type PlanFacts,
  type PlanRow,
} from "../plan";
import { SEQUENCE_STEPS } from "../steps";

const T0 = new Date("2026-10-05T10:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    started_at: T0.toISOString(),
    last_step: 0,
    last_sent_at: null,
    sent_steps: [],
    skipped_steps: [],
    channel_order: null,
    wait_since: null,
    digest_until: null,
    ...over,
  };
}

function facts(
  over: {
    cards?: Record<string, number>;
    used?: string[];
    inFlight?: string[];
    upgradeEmailSent?: boolean;
    paid?: boolean;
  } = {},
): PlanFacts {
  const inFlight = new Set(over.inFlight ?? []);
  return {
    openCards: new Map(Object.entries(over.cards ?? {})),
    used: new Set(over.used ?? []),
    inFlight,
    upgradeEmailSent: over.upgradeEmailSent ?? false,
    paidRerunsInFlight: over.paid === true && inFlight.size > 0,
  };
}

const after = (sent: number[], over: Partial<PlanRow> = {}) =>
  row({ sent_steps: sent, last_step: sent[sent.length - 1] ?? 0, last_sent_at: at(-DAY).toISOString(), ...over });

const sendOf = (d: PlanDecision) => {
  if (d.kind !== "send") throw new Error(`expected a send, got ${JSON.stringify(d)}`);
  return d;
};

describe("welcome and day 1", () => {
  it("a new person gets the welcome first, without any workspace read", () => {
    expect(needsFacts(row(), T0)).toBe(false);
    const d = sendOf(planNext(row(), null, T0));
    expect(d.step).toBe(1);
    expect(d.nextDue!.getTime()).toBe(T0.getTime() + DAY);
  });

  it("day 1 with cards: the digest, and Growth Strategy counts as skipped", () => {
    const d = sendOf(planNext(after([1]), facts({ cards: { seo: 2 } }), at(DAY)));
    expect(d).toMatchObject({ step: 10, variant: "digest", skip: [2] });
  });

  it("day 1 with no cards and nothing running: Growth Strategy at once", () => {
    const d = sendOf(planNext(after([1]), facts(), at(DAY)));
    expect(d).toMatchObject({ step: 2, variant: "intro", skip: [10] });
  });

  it("day 1 with no cards while onboarding runs are going: waits, stamping wait_since", () => {
    const d = planNext(after([1]), facts({ inFlight: ["seo"] }), at(DAY));
    expect(d).toMatchObject({ kind: "wait", stampWait: true });
  });

  it("after 24 hours of waiting, the Growth Strategy fallback goes", () => {
    const now = at(2 * DAY);
    const r = after([1], { wait_since: new Date(now.getTime() - WAIT_CAP_MS).toISOString() });
    expect(sendOf(planNext(r, facts({ inFlight: ["seo"] }), now))).toMatchObject({ step: 2, variant: "intro" });
  });

  it("a row written by older code with last_step 1 never gets a welcome, even with empty sent_steps", () => {
    const r = row({ last_step: 1, sent_steps: [], last_sent_at: at(-DAY).toISOString() });
    expect(doneSteps(r).has(1)).toBe(true);
    expect(sendOf(planNext(r, facts(), at(DAY))).step).toBe(2);
  });
});

describe("channel emails", () => {
  it("go most open cards first; a running channel counts 0; ties keep 3, 4, 6, 7", () => {
    expect(channelOrderFor(facts())).toEqual([3, 4, 6, 7]);
    expect(channelOrderFor(facts({ cards: { reddit_organic: 3, linkedin_organic: 1, x_organic: 1, seo: 1 } }))).toEqual([6, 4, 3, 7]);
    expect(channelOrderFor(facts({ cards: { reddit_organic: 3, instagram_organic: 1 }, inFlight: ["reddit_organic"] }))).toEqual([7, 3, 4, 6]);
  });

  it("the first channel email decides and stores the order; later ones keep it", () => {
    const f = facts({ cards: { reddit_organic: 2 } });
    const first = sendOf(planNext(after([1, 10]), f, at(2 * DAY)));
    expect(first).toMatchObject({ step: 6, variant: "results", channelOrder: [6, 3, 4, 7] });
    const next = sendOf(planNext(after([1, 10, 6], { channel_order: [6, 3, 4, 7] }), facts({ cards: { instagram_organic: 9 } }), at(3 * DAY)));
    expect(next).toMatchObject({ step: 3, variant: "intro", channelOrder: null });
  });

  it("no open cards: the intro (fall back, never skip)", () => {
    expect(sendOf(planNext(after([1, 2]), facts(), at(2 * DAY)))).toMatchObject({ step: 3, variant: "intro" });
  });

  it("a channel the workspace already used is skipped and the next moves up, still one email", () => {
    const d = sendOf(planNext(after([1, 2]), facts({ used: ["seo", "geo"] }), at(2 * DAY)));
    expect(d).toMatchObject({ step: 4, variant: "intro", skip: [3] });
    expect(d.nextDue!.getTime()).toBe(T0.getTime() + 3 * DAY);
  });

  it("SEO used but GEO not: the SEO and GEO email still goes", () => {
    expect(sendOf(planNext(after([1, 2]), facts({ used: ["seo"] }), at(2 * DAY))).step).toBe(3);
  });

  it("every channel used: straight to creators, then paid ads, then over", () => {
    const used = ["seo", "geo", "linkedin_organic", "x_organic", "reddit_organic", "instagram_organic"];
    expect(sendOf(planNext(after([1, 2]), facts({ used }), at(2 * DAY)))).toMatchObject({ step: 8, skip: [3, 4, 6, 7] });
    const last = sendOf(planNext(after([1, 2, 8], { skipped_steps: [3, 4, 6, 7, 10] }), facts({ used }), at(3 * DAY)));
    expect(last).toMatchObject({ step: 9, nextDue: null });
  });

  it("the channel's onboarding run is still going and it has no cards: wait, then intro after 24h", () => {
    const f = facts({ inFlight: ["seo"] });
    expect(planNext(after([1, 2]), f, at(2 * DAY))).toMatchObject({ kind: "wait", stampWait: true });
    const late = after([1, 2], { wait_since: at(DAY).toISOString() });
    expect(sendOf(planNext(late, f, at(2 * DAY + HOUR)))).toMatchObject({ step: 3, variant: "intro" });
  });

  it("creators: the results version when a creator channel has open cards, else the intro", () => {
    const done = after([1, 2, 3, 4, 6, 7]);
    expect(sendOf(planNext(done, facts({ cards: { generated_video: 2 } }), at(6 * DAY)))).toMatchObject({ step: 8, variant: "results" });
    expect(sendOf(planNext(done, facts({ cards: { seo: 5 } }), at(6 * DAY)))).toMatchObject({ step: 8, variant: "intro" });
  });

  it("creators: waits for a still-running creator run, then the intro after 24h", () => {
    const f = facts({ inFlight: ["ugc"] });
    expect(planNext(after([1, 2, 3, 4, 6, 7]), f, at(6 * DAY))).toMatchObject({ kind: "wait", stampWait: true });
    const late = after([1, 2, 3, 4, 6, 7], { wait_since: at(5 * DAY).toISOString() });
    expect(sendOf(planNext(late, f, at(6 * DAY + HOUR)))).toMatchObject({ step: 8, variant: "intro" });
  });

  it("creators: skipped when every creator channel was used; paid ads goes instead", () => {
    const used = ["ugc", "generated_video"];
    expect(sendOf(planNext(after([1, 2, 3, 4, 6, 7]), facts({ used }), at(6 * DAY)))).toMatchObject({ step: 9, skip: [8] });
  });

  it("after 9 nothing is left: over (and never a burst of the skipped ones)", () => {
    expect(planNext(after([1, 2, 3, 4, 6, 7, 8, 9], { skipped_steps: [10] }), facts(), at(8 * DAY))).toEqual({ kind: "over", skip: [] });
  });
});

describe("one email a day", () => {
  it("nothing goes sooner than 20 hours after the last one", () => {
    const r = after([1, 2], { last_sent_at: at(-HOUR).toISOString() });
    const d = planNext(r, facts({ cards: { seo: 3 } }), T0);
    expect(d).toEqual({ kind: "wait", until: at(-HOUR + MIN_GAP_MS), stampWait: false });
  });

  it("after an outage it sends one email, then the next is a day away", () => {
    const d = sendOf(planNext(after([1]), facts(), at(6 * DAY)));
    expect(d.nextDue!.getTime()).toBe(at(6 * DAY).getTime() + MIN_GAP_MS);
  });
});

describe("people enrolled before the digest", () => {
  const legacy = (sent: number[], over: Partial<PlanRow> = {}) =>
    after(sent, { digest_until: at(30 * DAY).toISOString(), ...over });

  it("is recognised from sent_steps (2 sent, 10 neither sent nor skipped)", () => {
    expect(isLegacyRow(legacy([1, 2]))).toBe(true);
    expect(isLegacyRow(after([1, 2], { skipped_steps: [10] }))).toBe(false);
    expect(isLegacyRow(after([1, 10], { skipped_steps: [2] }))).toBe(false);
  });

  it("with cards, the digest is the next email, mid-sequence or finished", () => {
    for (const sent of [[1, 2], [1, 2, 3, 4], [1, 2, 3, 4, 6, 7, 8, 9]]) {
      const d = sendOf(planNext(legacy(sent), facts({ cards: { reddit_organic: 1 } }), at(9 * DAY)));
      expect(d.step, sent.join()).toBe(10);
      expect(d.skip).toEqual([]);
    }
  });

  it("the digest for a finished person is the last email (completes)", () => {
    const d = sendOf(planNext(legacy([1, 2, 3, 4, 6, 7, 8, 9]), facts({ cards: { seo: 1 } }), at(9 * DAY)));
    expect(d.nextDue).toBeNull();
  });

  it("without cards it never falls back: mid-sequence they get their next email", () => {
    expect(sendOf(planNext(legacy([1, 2, 3]), facts(), at(9 * DAY))).step).toBe(4);
  });

  it("without cards and nothing left, it waits until digest_until, then completes", () => {
    const done = legacy([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(planNext(done, facts(), at(9 * DAY))).toMatchObject({ kind: "wait", stampWait: false });
    expect(planNext(done, facts(), at(31 * DAY))).toEqual({ kind: "over", skip: [] });
  });

  it("a mid-sequence send keeps the row open while the digest may still go", () => {
    const d = sendOf(planNext(legacy([1, 2, 3, 4, 6, 7, 8]), facts(), at(9 * DAY)));
    expect(d.step).toBe(9);
    expect(d.nextDue).not.toBeNull();
  });

  it("never gets a second welcome or a repeat, for every backfilled last_step", () => {
    const order = SEQUENCE_STEPS.map((s) => s.step);
    for (const last of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
      const sent = order.filter((s) => s <= last);
      const r = legacy(sent, { last_step: last, last_sent_at: last ? at(-DAY).toISOString() : null });
      for (const f of [facts(), facts({ cards: { seo: 2 } })]) {
        const d = planNext(r, f, at(9 * DAY));
        if (d.kind === "send") expect(sent, `last_step ${last} -> ${d.step}`).not.toContain(d.step);
      }
    }
  });
});

describe("one results email, not two: the upgrade email already went", () => {
  const upgraded = (over: Parameters<typeof facts>[0] = {}) => facts({ ...over, upgradeEmailSent: true });

  it("day 1 with cards: Growth Strategy instead of the digest, digest recorded skipped", () => {
    const d = sendOf(planNext(after([1]), upgraded({ cards: { seo: 3 } }), at(DAY)));
    expect(d).toMatchObject({ step: 2, variant: "intro", skip: [10] });
  });

  it("day 1 with runs still going: no wait, Growth Strategy at once", () => {
    const d = sendOf(planNext(after([1]), upgraded({ inFlight: ["seo"] }), at(DAY)));
    expect(d).toMatchObject({ step: 2, variant: "intro", skip: [10] });
  });

  it("the welcome is unchanged", () => {
    expect(sendOf(planNext(row(), upgraded(), T0)).step).toBe(1);
  });

  it("the channel emails are unchanged (results version with cards)", () => {
    const d = sendOf(planNext(after([1, 2], { skipped_steps: [10] }), upgraded({ cards: { reddit_organic: 2 } }), at(2 * DAY)));
    expect(d).toMatchObject({ step: 6, variant: "results", skip: [] });
  });

  describe("people enrolled before the digest", () => {
    const legacy = (sent: number[]) => after(sent, { digest_until: at(30 * DAY).toISOString() });

    it("with cards, no digest: their next email goes and records the digest skipped", () => {
      const d = sendOf(planNext(legacy([1, 2, 3]), upgraded({ cards: { reddit_organic: 1 } }), at(9 * DAY)));
      expect(d.step).not.toBe(10);
      expect(d.step).toBe(6);
      expect(d.skip).toContain(10);
    });

    it("the last email no longer holds the row open for the digest", () => {
      const d = sendOf(planNext(legacy([1, 2, 3, 4, 6, 7, 8]), upgraded({ cards: { seo: 1 } }), at(9 * DAY)));
      expect(d).toMatchObject({ step: 9, skip: [10], nextDue: null });
    });

    it("nothing else left: completes at once, digest skipped (no wait until digest_until)", () => {
      expect(planNext(legacy([1, 2, 3, 4, 6, 7, 8, 9]), upgraded({ cards: { seo: 1 } }), at(9 * DAY))).toEqual({
        kind: "over",
        skip: [10],
      });
    });
  });
});

describe("paid workspace, upgrade re-runs still going: no digest yet", () => {
  const midUpgrade = facts({ paid: true, cards: { seo: 2 }, inFlight: ["reddit_organic"] });

  it("day 1: waits instead of sending the digest", () => {
    expect(planNext(after([1]), midUpgrade, at(DAY))).toMatchObject({ kind: "wait", stampWait: true });
  });

  it("day 1 after the 24h cap: Growth Strategy, never the digest", () => {
    const now = at(2 * DAY);
    const r = after([1], { wait_since: new Date(now.getTime() - WAIT_CAP_MS).toISOString() });
    expect(sendOf(planNext(r, midUpgrade, now))).toMatchObject({ step: 2, variant: "intro", skip: [10] });
  });

  it("a person enrolled before the digest: waits instead of the digest", () => {
    const r = after([1, 2, 3], { digest_until: at(30 * DAY).toISOString() });
    expect(planNext(r, midUpgrade, at(9 * DAY))).toMatchObject({ kind: "wait", stampWait: true });
  });

  it("all re-runs done and the upgrade email sent: no digest at all", () => {
    const d = sendOf(planNext(after([1]), facts({ paid: true, cards: { seo: 2 }, upgradeEmailSent: true }), at(DAY)));
    expect(d).toMatchObject({ step: 2, skip: [10] });
  });

  it("a FREE workspace with runs still going is unchanged: the digest goes with the cards it has", () => {
    const d = sendOf(planNext(after([1]), facts({ cards: { seo: 2 }, inFlight: ["reddit_organic"] }), at(DAY)));
    expect(d).toMatchObject({ step: 10, variant: "digest" });
  });
});
