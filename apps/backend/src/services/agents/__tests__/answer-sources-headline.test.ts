import { describe, it, expect, beforeEach } from "vitest";
import { clearFigures, pullsForFigure, recordFiguresFromPull } from "@/services/agents/engine/figure-ledger";
import { buildAnswerSources, claimFigures } from "@/services/agents/answer-sources";
import type { AccessNote } from "@/services/data-gateway/types";

const RUN = "33333333-3333-4333-8333-333333333333";
const note = (log_id: string, tables: string[]): AccessNote => ({ log_id, mode: "direct", tables, rows: 1, result: "allowed" });
const LOG = (n: number) => `aaaaaaaa-1111-4111-8111-11111111111${n}`;

beforeEach(() => clearFigures(RUN));

describe("headline figures", () => {
  it("a bold headline count under 100 is a figure, and it leads the list", () => {
    expect(claimFigures("Last month 1,250 visits. **312 bookings this week.**")).toEqual(["312", "1,250"]);
    expect(claimFigures("**69 active listings right now.** 36 more are paused.")).toEqual(["69"]);
  });

  it("a proposed target in the headline is never a sourced claim", () => {
    expect(claimFigures("**Cut Google to $50/day.** Spend was $50 yesterday? No, $120.")).not.toContain("$50/day");
    expect(claimFigures("**Raise the budget to $80 per day.** Last week it was $1,240.")).toEqual(["$1,240"]);
  });

  it("a small count outside the headline is still not a figure", () => {
    expect(claimFigures("We have 69 listings. **Top pick:** the blue one.")).toEqual([]);
  });

  it("sources the headline count and names it in the header", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ rows: [{ _id: { status: "Active" }, n: 69 }] }), "operator_db__query", [note(LOG(1), ["items"])]);
    const r = buildAnswerSources(RUN, "**69 active listings right now.** 36 more are paused.");
    const header = r.block!.split("\n").find((l) => l.startsWith("**Sources.**"));
    expect(header).toBe("**Sources.** The number 69 came straight from data pulled in this run.");
    expect(r.block).toContain("on items");
  });

  it("names every figure when there are a few", () => {
    recordFiguresFromPull(RUN, '{"rows":[{"n":5344},{"m":1287}]}', "operator_db__query", [note(LOG(1), ["items"])]);
    const r = buildAnswerSources(RUN, "5,344 trips and 1,287 hosts.");
    expect(r.block).toContain("**Sources.** All 2 numbers (5,344, 1,287) came straight from data pulled in this run.");
  });
});

describe("which queries a figure credits", () => {
  it("keeps the most recent primary pulls when a figure fills its 3 slots", () => {
    for (let i = 1; i <= 4; i++) {
      recordFiguresFromPull(RUN, JSON.stringify({ rows: [{ n: 69, i }] }), "operator_db__query", [note(LOG(i), ["items"])]);
    }
    expect(pullsForFigure(RUN, "69").map((p) => p.nth)).toEqual([2, 3, 4]);
  });
});
