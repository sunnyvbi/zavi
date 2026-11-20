import { describe, it, expect } from "vitest";
import { joinChannelStates } from "@/services/channels/state";
import { assembleChannels, pinLiveBetsHigh, readStrategyFit, type LatestRun } from "../list";

const base = {
  linked: new Set<string>(),
  latestRun: new Map<string, LatestRun>(),
  runsAvailable: true,
  now: Date.parse("2026-09-24T02:00:00.000Z"),
  staleMs: 2 * 3_600_000,
};

const note = (strategy: unknown) => async () => ({
  id: "n1",
  title: "Growth strategy",
  body_markdown: "",
  tags: [],
  metadata: { strategy },
});

describe("readStrategyFit", () => {
  it("reads valid ratings and drops malformed ones", async () => {
    const r = await readStrategyFit(
      "t",
      note({
        channel_fit: [
          { channel_slug: "seo", value: "high", line: "Buyers search by name" },
          { channel_slug: "sms", value: "meh", line: "bad value" },
          { channel_slug: "x_organic", value: "low", line: "  " },
        ],
      }) as never,
    );
    expect(r.has_strategy).toBe(true);
    expect([...r.fits.entries()]).toEqual([["seo", { value: "high", line: "Buyers search by name" }]]);
  });

  it("a strategy drafted before ratings existed: has_strategy, no fits", async () => {
    const r = await readStrategyFit("t", note({ constraint: {} }) as never);
    expect(r).toMatchObject({ has_strategy: true });
    expect(r.fits.size).toBe(0);
  });

  it("no note, or a read that throws: no strategy, never a throw", async () => {
    expect((await readStrategyFit("t", (async () => null) as never)).has_strategy).toBe(false);
    const boom = (async () => {
      throw new Error("down");
    }) as never;
    expect((await readStrategyFit("t", boom)).has_strategy).toBe(false);
  });
});

describe("assembleChannels carries the rating", () => {
  it("a rated channel has its fit, an unrated one is null", () => {
    const out = assembleChannels({
      ...base,
      states: joinChannelStates([{ channel_slug: "seo" }, { channel_slug: "sms" }]),
      fits: new Map([["seo", { value: "low" as const, line: "Your buyers never search for this" }]]),
    });
    expect(out.find((c) => c.channel_slug === "seo")!.fit).toEqual({ value: "low", line: "Your buyers never search for this" });
    expect(out.find((c) => c.channel_slug === "sms")!.fit).toBeNull();
  });
});

describe("pinLiveBetsHigh", () => {
  it("a live-plan bet is High with its own reason, even if a newer draft rated it low", () => {
    const out = pinLiveBetsHigh(
      new Map([["seo", { value: "low" as const, line: "draft says no" }], ["sms", { value: "low" as const, line: "no" }]]),
      new Map([["seo", { intent: "Publish comparison pages", rationale: "buyers search by name" }]]),
    );
    expect(out.get("seo")).toEqual({ value: "high", line: "buyers search by name" });
    expect(out.get("sms")).toEqual({ value: "low", line: "no" });
  });

  it("a rejected or superseded bet is not pinned: the strategy's own rating stands", () => {
    const out = pinLiveBetsHigh(
      new Map([["seo", { value: "low" as const, line: "the founder stopped this" }]]),
      new Map([["seo", { intent: "x", rationale: "y", status: "rejected" }]]),
    );
    expect(out.get("seo")).toEqual({ value: "low", line: "the founder stopped this" });
  });
});
