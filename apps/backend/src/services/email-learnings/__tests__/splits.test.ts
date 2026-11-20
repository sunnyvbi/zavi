import { describe, expect, it } from "vitest";
import { computeTopics, evaluate, localParts, MIN_SIDE, phrase, sideOf, type Observation } from "../splits";

const TZ = "America/New_York";
let n = 0;
const obs = (over: Partial<Observation> = {}): Observation => ({
  key: `k${n++}`,
  account_key: "mailchimp:acct-1",
  route: "mailchimp",
  list_id: "L1",
  list_name: "Newsletter",
  window: "lifetime",
  metric: "clicks",
  subject: "Product update",
  sent_at: "2026-09-01T14:00:00Z",
  exact_time: true,
  delivered: 1000,
  hits: 20,
  ...over,
});
const stratum = { account_key: "mailchimp:acct-1", route: "mailchimp" as const, list_id: "L1", list_name: "Newsletter", metric: "clicks" as const, window: "lifetime" as const };

describe("sides", () => {
  it("subject digit and length; empty subject applies to neither", () => {
    expect(sideOf("subject_digit", obs({ subject: "3 ways to save" }), TZ)).toBe("a");
    expect(sideOf("subject_digit", obs({ subject: "Ways to save" }), TZ)).toBe("b");
    expect(sideOf("subject_length", obs({ subject: "x".repeat(40) }), TZ)).toBe("a");
    expect(sideOf("subject_length", obs({ subject: "x".repeat(41) }), TZ)).toBe("b");
    expect(sideOf("subject_digit", obs({ subject: "  " }), TZ)).toBeNull();
  });

  it("time splits read the workspace's time zone, and skip a stamp that is not the send time", () => {
    expect(localParts("2026-09-05T03:00:00Z", TZ)).toEqual({ hour: 23, weekday: 5 });
    expect(sideOf("weekend", obs({ sent_at: "2026-09-05T03:00:00Z" }), TZ)).toBe("b");
    expect(sideOf("weekend", obs({ sent_at: "2026-09-05T15:00:00Z" }), TZ)).toBe("a");
    expect(sideOf("morning", obs({ sent_at: "2026-09-01T14:00:00Z" }), TZ)).toBe("a");
    expect(sideOf("morning", obs({ sent_at: "2026-09-01T18:00:00Z" }), TZ)).toBe("b");
    expect(sideOf("morning", obs({ exact_time: false }), TZ)).toBeNull();
    expect(sideOf("weekend", obs({ exact_time: false }), TZ)).toBeNull();
  });
});

describe("evaluate", () => {
  const digits = (rates: number[]) => rates.map((r) => obs({ subject: "5 new templates", hits: Math.round(r * 1000) }));
  const plain = (rates: number[]) => rates.map((r) => obs({ subject: "New templates", hits: Math.round(r * 1000) }));

  it("must catch: a split that holds on every row, each side >= 3, survives leave-one-out", () => {
    const t = evaluate("subject_digit", [...digits([0.04, 0.05, 0.045]), ...plain([0.02, 0.025, 0.02])], TZ, stratum)!;
    expect(t.holds).toBe(true);
    expect(t.stats).toMatchObject({ n_a: 3, n_b: 3, side: "a" });
    expect(t.strength).toBe("early");
    expect(t.text).toBe('Emails to "Newsletter" with a number in the subject got more clicks (4.5% vs 2.2% clicks per delivered email, 6 emails).');
  });

  it("a topic carries its side and a fingerprint of the evidence: same rows = same print, one count changed = a new one", () => {
    const rows = [...digits([0.04, 0.05, 0.045]), ...plain([0.02, 0.025, 0.02])];
    const t1 = evaluate("subject_digit", rows, TZ, stratum)!;
    const t2 = evaluate("subject_digit", [...rows].reverse(), TZ, stratum)!;
    expect(t1.side).toBe("a");
    expect(t1.fingerprint).toBe(t2.fingerprint);
    const changed = rows.map((r, i) => (i === 0 ? { ...r, hits: r.hits + 1 } : r));
    expect(evaluate("subject_digit", changed, TZ, stratum)!.fingerprint).not.toBe(t1.fingerprint);
  });

  it("fewer than 3 on a side: not evaluable at all", () => {
    expect(MIN_SIDE).toBe(3);
    expect(evaluate("subject_digit", [...digits([0.04, 0.05]), ...plain([0.02, 0.02, 0.02])], TZ, stratum)).toBeNull();
  });

  it("one outlier carrying the difference: leave-one-out fails, it does not hold", () => {
    const t = evaluate("subject_digit", [...digits([0.2, 0.01, 0.01]), ...plain([0.02, 0.02, 0.02])], TZ, stratum)!;
    expect(t.holds).toBe(false);
    expect(t.text).toBe("");
  });

  it("under the practical floor (a 5% lift): does not hold", () => {
    const t = evaluate("subject_digit", [...digits([0.021, 0.021, 0.021]), ...plain([0.02, 0.02, 0.02])], TZ, stratum)!;
    expect(t.holds).toBe(false);
  });

  it("firm needs 5 a side and a 50% lift", () => {
    const t = evaluate("subject_digit", [...digits([0.05, 0.05, 0.05, 0.05, 0.05]), ...plain([0.02, 0.02, 0.02, 0.02, 0.02])], TZ, stratum)!;
    expect(t.strength).toBe("firm");
    expect(t.rank).toBeGreaterThan(0);
  });

  it("the sentence is a fixed template per split and side, never free text", () => {
    const r = { rate_a: 0.01, rate_b: 0.03, n_a: 3, n_b: 3 };
    expect(phrase("morning", "b", "visitors", null, r)).toBe("Emails sent from noon on got more website visits than morning sends (3.0% vs 1.0% website visits per delivered email, 6 emails).");
    expect(phrase("list", "a", "clicks", "VIP customers", { ...r, rate_a: 0.03, rate_b: 0.01 })).toContain('Emails to "VIP customers" got more clicks than to your other lists');
  });
});

describe("computeTopics never pools strata", () => {
  it("two accounts, two metrics and two windows are separate; the list split compares lists of one account", () => {
    const rows: Observation[] = [];
    for (const account_key of ["mailchimp:acct-1", "mailchimp:acct-2"]) {
      for (const list of ["L1", "L2"]) {
        for (let i = 0; i < 3; i++) {
          rows.push(obs({ account_key, list_id: list, list_name: list, subject: `${i} things`, hits: list === "L1" ? 50 : 10 }));
          rows.push(obs({ account_key, list_id: list, list_name: list, subject: "Things", hits: list === "L1" ? 20 : 10 }));
        }
      }
    }
    rows.push(obs({ metric: "visitors", subject: "9 things", hits: 999 }));
    const topics = computeTopics(rows, TZ);
    const keys = new Set(topics.map((t) => `${t.account_key}|${t.metric}|${t.obs_window}|${t.list_id}|${t.split}`));
    expect([...keys].every((k) => !k.includes("visitors"))).toBe(true);
    const digitL1 = topics.filter((t) => t.split === "subject_digit" && t.list_id === "L1");
    expect(digitL1.map((t) => t.account_key).sort()).toEqual(["mailchimp:acct-1", "mailchimp:acct-2"]);
    expect(digitL1.every((t) => t.stats.n_a === 3 && t.stats.n_b === 3)).toBe(true);
    const listSplit = topics.find((t) => t.split === "list" && t.list_id === "L1" && t.account_key === "mailchimp:acct-1")!;
    expect(listSplit.holds).toBe(true);
    expect(listSplit.stats).toMatchObject({ n_a: 6, n_b: 6, side: "a" });
  });
});
