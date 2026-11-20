import { describe, it, expect } from "vitest";
import { joinChannelStates } from "@/services/channels/state";
import { assembleChannels, type LatestRun } from "../list";

const NOW = Date.parse("2026-09-22T02:00:00.000Z");

const base = {
  linked: new Set<string>(),
  latestRun: new Map<string, LatestRun>(),
  runsAvailable: true,
  now: NOW,
  staleMs: 2 * 3_600_000,
};

const statesFrom = (...rows: Array<Record<string, unknown> & { channel_slug: string }>) =>
  joinChannelStates(rows);

const bets = (m: Record<string, { intent: string | null; rationale: string | null }>) =>
  new Map(Object.entries(m));

describe("assembleChannels — the plan's intent reaches the channel row", () => {
  it("a channel the plan bet on carries its intent and rationale", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "reddit_organic" }),
      planBets: bets({
        reddit_organic: { intent: "Answer buyer questions", rationale: "Buyers research there" },
      }),
    });
    const row = out.find((c) => c.channel_slug === "reddit_organic")!;
    expect(row.plan_intent).toBe("Answer buyer questions");
    expect(row.plan_rationale).toBe("Buyers research there");
  });

  it("a channel the plan did NOT bet on stays null, so it renders the generic state", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "reddit_organic" }, { channel_slug: "seo" }),
      planBets: bets({ reddit_organic: { intent: "Answer buyer questions", rationale: null } }),
    });
    const seo = out.find((c) => c.channel_slug === "seo")!;
    expect(seo.plan_intent).toBeNull();
    expect(seo.plan_rationale).toBeNull();
  });

  it("no live plan ⇒ every channel is null (the unchanged path)", () => {
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "seo" }) });
    expect(out.every((c) => c.plan_intent === null)).toBe(true);
    expect(out.every((c) => c.plan_rationale === null)).toBe(true);
  });

  it("intent without rationale survives as intent + null", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo" }),
      planBets: bets({ seo: { intent: "Fix the pages buyers land on", rationale: null } }),
    });
    const seo = out.find((c) => c.channel_slug === "seo")!;
    expect(seo.plan_intent).toBe("Fix the pages buyers land on");
    expect(seo.plan_rationale).toBeNull();
  });

  it("a bet on an unknown slug adds no channel", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo" }),
      planBets: bets({ not_a_channel: { intent: "x", rationale: "y" } }),
    });
    expect(out.find((c) => c.channel_slug === "not_a_channel")).toBeUndefined();
  });
});
