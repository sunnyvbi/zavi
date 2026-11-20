import { describe, expect, it } from "vitest";
import { computeWinLine } from "../win-line";

const clicks = { metric: "clicks" };
const visitors = { metric: "visitors" };
const real = (n: number) => ({ win_line: clicks, d7: { clicks: n, delivered: 100, provider_status: "ok" } });
const carried = (n: number, from: string[], status = "disconnected") => ({ win_line: clicks, d7: { clicks: n, delivered: 100, provider_status: status, from_h1: from } });
const line = (past: Array<{ win_line: unknown; d7: unknown }>, tagged = false) => computeWinLine("t", { route: "mailchimp", listId: "L", tagged, gaConnected: tagged }, { pastResults: async () => past });

describe("Flow 56: the win line reads day-7 rates only", () => {
  it("must catch: a carried 1-hour click rate does not shift the line", async () => {
    expect(await line([carried(90, ["clicks"]), real(10), carried(95, ["clicks"], "could_not_read"), real(20), real(30)])).toEqual({ metric: "clicks", threshold: 0.2, basis: "median", n_past: 3 });
  });

  it("must catch: a real click count over a carried delivered count is not a day-7 rate", async () => {
    expect(await line([carried(90, ["delivered"]), real(10), real(20), real(30)])).toEqual({ metric: "clicks", threshold: 0.2, basis: "median", n_past: 3 });
  });

  it("must catch: carried rows do not count toward the 3 a line needs", async () => {
    expect(await line([carried(1, ["clicks"]), carried(2, ["clicks"]), real(10), real(20)])).toEqual({ metric: "clicks", threshold: null, basis: "first_sends", n_past: 2 });
  });

  it("must catch: carried rows leave the last 5 to real rates", async () => {
    const past = [carried(1, ["clicks"]), carried(1, ["clicks"]), real(5), real(6), real(7), real(8), real(9)];
    expect(await line(past)).toEqual({ metric: "clicks", threshold: 0.07, basis: "median", n_past: 5 });
  });

  it("a visitors line ignores a carried click count but not a carried delivered one", async () => {
    const row = (v: number, from: string[]) => ({ win_line: visitors, d7: { visitors: v, delivered: 100, provider_status: "disconnected", from_h1: from } });
    expect(await line([row(10, ["clicks"]), row(20, ["clicks"]), row(30, ["opens"]), row(90, ["delivered"])], true)).toEqual({ metric: "visitors", threshold: 0.2, basis: "median", n_past: 3 });
  });

  it("control: real rates keep the same line, a leftover from_h1 on an answered read counts, and a row with no d7 is passed over", async () => {
    expect(await line([real(10), carried(20, ["clicks"], "ok"), real(30), { win_line: clicks, d7: null }])).toEqual({ metric: "clicks", threshold: 0.2, basis: "median", n_past: 3 });
  });
});
