// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FuelGauge } from "./Gauges";

afterEach(cleanup);

const gauge = (spent: number, more: { ended?: boolean; raisedOn?: string } = {}, budget = 25000) =>
  render(<FuelGauge budget={budget} spent={spent} perDay={400} runsOutDay={32} locked={false} unlockLabel="" {...more} />).container.textContent;

describe("FuelGauge", () => {
  it("says when the money runs out while some is left", () => {
    expect(gauge(20000)).toContain("the money runs out on day 32");
  });

  it("drops that line once the money is gone", () => {
    expect(gauge(27213)).not.toContain("runs out");
  });

  it("says how far over a passed limit is, not $0 left", () => {
    const t = gauge(27213);
    expect(t).toContain("$2,213");
    expect(t).toContain("over");
    expect(t).not.toContain("left");
  });

  it("a raised limit shows its date and is no longer called hard", () => {
    const t = gauge(27567, { raisedOn: "2026-10-24" }, 28400);
    expect(t).toContain("$28,400 limit since Sat 24 Oct");
    expect(t).not.toContain("hard limit");
    expect(t).toContain("$833");
    expect(t).toContain("left");
  });

  it("a finished run has no forecast", () => {
    const t = gauge(27567, { ended: true }, 28400);
    expect(t).toContain("$27,567 burned");
    expect(t).not.toContain("runs out");
    expect(t).not.toContain("this week");
  });
});
