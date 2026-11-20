import { describe, expect, it } from "vitest";
import { pickToday, type Pickable } from "./pickToday";
import { amountText, runsOutAfter, runsOutNow, shiftText } from "./format";

const card = (id: string, kind: Pickable["kind"], extra: Partial<Pickable> = {}): Pickable => ({ id, kind, channel_slug: null, tone: null, ...extra });

describe("pickToday", () => {
  it("puts fixes and money first, at most 2, then one card ready to publish, then the quickest", () => {
    const open = [
      card("task", "task"),
      card("post", "post", { channel_slug: "x_organic" }),
      card("spend", "spend", { channel_slug: "google_ads" }),
      card("check", "check", { channel_slug: "linkedin_ads", tone: "danger" }),
      card("meta", "reconnect", { channel_slug: "meta_ads", tone: "warn" }),
      card("q", "question"),
    ];
    expect(pickToday(open)).toEqual(["check", "meta", "post"]);
  });

  it("gives a channel under an open 'spending by mistake?' check no other job", () => {
    const open = [
      card("check", "check", { channel_slug: "linkedin_ads", tone: "danger" }),
      card("li-post", "post", { channel_slug: "linkedin_ads" }),
      card("x-post", "post", { channel_slug: "x_organic" }),
    ];
    expect(pickToday(open)).toEqual(["check", "x-post"]);
  });

  it("fills with the quickest when nothing is urgent", () => {
    const open = [card("task", "task"), card("copy", "copy"), card("q", "question"), card("plan", "plan")];
    expect(pickToday(open)).toEqual(["copy", "q", "plan"]);
  });

  it("uses the server's minutes when it has them", () => {
    const open = [card("long", "task", { mins: 60 }), card("short", "task", { mins: 5 })];
    expect(pickToday(open, 1)).toEqual(["short"]);
  });

  it("honours a smaller count", () => {
    expect(pickToday([card("a", "task"), card("b", "question")], 1)).toEqual(["b"]);
  });
});

describe("the one ad-money forecast", () => {
  const now = new Date(2026, 9, 20);

  it("shows a card's daily change", () => {
    expect(amountText(30)).toBe("+$30/day");
    expect(amountText(-180)).toBe("−$180/day");
    expect(amountText(null)).toBeNull();
  });

  it("moves the runs-out date with the same model the page line uses", () => {
    const f = { daily_usd: 100, runs_out_on: "2026-10-30", projected_month_usd: null };
    expect(runsOutNow(f)).toEqual({ kind: "date", on: "2026-10-30" });
    const after = runsOutAfter(f, 25, null, now);
    expect(after).toEqual({ kind: "date", on: "2026-10-28" });
    expect(shiftText(runsOutNow(f), after, now)).toBe("2 days sooner");
  });

  it("uses the budget's money left over a date rounded from it, so a small raise moves nothing", () => {
    const f = { daily_usd: 100, runs_out_on: "2026-10-22", projected_month_usd: null };
    const before = runsOutNow(f, 290, now);
    const after = runsOutAfter(f, 40, 290, now);
    expect(before).toEqual({ kind: "date", on: "2026-10-22" });
    expect(after).toEqual({ kind: "date", on: "2026-10-22" });
    expect(shiftText(before, after, now)).toBe("");
  });

  it("today's line and the dialog read the same sum when the money left is known", () => {
    const f = { daily_usd: 100, runs_out_on: "2026-10-23", projected_month_usd: null };
    expect(runsOutNow(f, 290, now)).toEqual(runsOutAfter(f, 0, 290, now));
  });

  it("says the money lasts the month when a cut pushes past month end", () => {
    const f = { daily_usd: 100, runs_out_on: "2026-10-30", projected_month_usd: null };
    expect(runsOutAfter(f, -50, null, now)).toEqual({ kind: "lasts" });
  });
});
