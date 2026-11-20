import { describe, it, expect } from "vitest";
import {
  cardNamesObject,
  cardSubjectRefs,
  channelsForAdClass,
  refsFromPayload,
  refsFromText,
  refsOfRow,
  textNamesCard,
} from "../open-advice";

const TURO_ID = "120259468814150059";

describe("subject refs", () => {
  it("an executable payload names its object ids and its name", () => {
    expect(refsFromPayload({ object_id: TURO_ID, level: "campaign", name: "40% to Turo", status: "PAUSED" })).toEqual({
      ids: [TURO_ID],
      names: ["40% to Turo"],
    });
    expect(refsFromPayload({ ad_set_id: "9", campaign_id: "123", daily_budget_usd: 20 }).ids).toEqual(["9", "123"]);
    expect(refsFromPayload(null)).toEqual({ ids: [], names: [] });
  });

  it("a one-card launch names its new campaign by campaign.name, so the unattended gate can resolve it", () => {
    const body = { campaign: { name: "Spring signups", daily_budget_usd: 20 }, ad_set: { name: "US 25-44" }, ad: { headline: "Hi" } };
    expect(refsFromPayload(body)).toEqual({ ids: [], names: ["Spring signups"] });
  });

  it("a card's own words name platform ids and quoted names; short numbers and apostrophes are not refs", () => {
    const r = refsFromText(`Rebuild “40% to Turo” (campaign ${TURO_ID}) as a conversion campaign`, "Spend was $1522 over 30 days; Turo's hosts.");
    expect(r).toEqual({ ids: [TURO_ID], names: ["40% to Turo"] });
  });

  it("stored refs, the payload and the words are merged, deduped", () => {
    const refs = cardSubjectRefs({ title: `Pause "40% to Turo"`, stepBody: `id ${TURO_ID}`, execPayload: { object_id: TURO_ID, name: "40% to Turo" } });
    expect(refs).toEqual({ ids: [TURO_ID], names: ["40% to Turo"] });
  });

  it("the Google classes belong to Google and YouTube, Meta's to Meta", () => {
    expect(channelsForAdClass("meta_ads.set_status")).toEqual(["meta_ads"]);
    expect(channelsForAdClass("google_ads.set_status")).toEqual(["google_ads", "youtube_ads"]);
    expect(channelsForAdClass("linkedin_ads.launch_campaign")).toEqual(["linkedin_ads"]);
    expect(channelsForAdClass("slack.post")).toEqual([]);
  });
});

describe("does a card name the object?", () => {
  const rebuild = refsOfRow({
    title: "Rebuild 40% to Turo as a conversion campaign",
    exec_payload: null,
    body: { step: { body: "It optimizes for reach; bookings need a conversion objective." } },
  });

  it("by name in its words, even with no id and no quotes", () => {
    expect(cardNamesObject(rebuild, { ids: [TURO_ID], name: "40% to Turo" })).toBe(true);
  });

  it("by id", () => {
    const card = refsOfRow({ title: "Pause it", exec_payload: { object_id: TURO_ID }, body: {} });
    expect(cardNamesObject(card, { ids: [TURO_ID], name: null })).toBe(true);
  });

  it("not a different object, and not on a name too short to mean anything", () => {
    expect(cardNamesObject(rebuild, { ids: ["555555555555"], name: "Upcar - All States - Awareness" })).toBe(false);
    expect(cardNamesObject(rebuild, { ids: [], name: "to" })).toBe(false);
  });

  it("a cgo intent names a card by its quoted name or its id", () => {
    const card = { refs: { ids: [TURO_ID], names: ["40% to Turo"] } };
    expect(textNamesCard("Pause 40% to Turo and Upcar - All States - Awareness: zero bookings", card)).toBe(true);
    expect(textNamesCard(`pause campaign ${TURO_ID}`, card)).toBe(true);
    expect(textNamesCard("test a $30/day ad set on the best creative", card)).toBe(false);
  });
});

describe("identical retries of a write that may have landed", () => {
  const SET = "120259468814150061";
  const dup = { ad_set_id: SET, name: "Spring (copy)" };
  const card = (exec_status: string | null, exec_result: unknown) => ({
    id: "ca-dup", run_id: "r-1", channel_slug: "meta_ads", title: 'Copy "Spring"',
    exec_class: "meta_ads.duplicate_ad_set", exec_payload: dup, exec_status, exec_result, body: {},
  });
  const probe = { object: { ids: [SET], name: "Spring" }, exclude: {}, exec: { exec_class: "meta_ads.duplicate_ad_set", exec_payload: dup } };

  it("a temporary failure (e.g. a write timeout) blocks the identical retry", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([card("failed", { bucket: "temporary" })], probe).map((c) => c.id)).toEqual(["ca-dup"]);
  });
  it("an unclassified failure blocks the identical retry (fail closed)", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([card("failed", null)], probe).map((c) => c.id)).toEqual(["ca-dup"]);
  });
  it("a partial-risk failure blocks the identical retry", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([card("failed", { bucket: "partial_risk" })], probe).map((c) => c.id)).toEqual(["ca-dup"]);
  });
  it("a DEFINITE failure lets the identical retry through (the account did not change)", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([card("failed", { bucket: "blocked_on_us" })], probe)).toEqual([]);
    expect(contradictingCards([card("failed", { bucket: "needs_founder" })], probe)).toEqual([]);
  });
  it("an identical OPEN card still agrees with itself (unchanged)", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([card(null, null)], probe)).toEqual([]);
  });
});

describe("failed cards block only their own control", () => {
  const SET = "120259468814150061";
  const failedCreative = { id: "ca-failed-ad", run_id: "r-1", channel_slug: "meta_ads", title: 'Create the ad "Spring"', exec_class: "meta_ads.create_ad", exec_payload: { ad_set_id: SET, name: "Spring" }, exec_status: "failed", exec_result: { bucket: "needs_founder" }, body: {} };
  const openCreative = { ...failedCreative, id: "ca-open-ad", exec_status: null };
  const failedBudget = { id: "ca-failed-budget", run_id: "r-2", channel_slug: "meta_ads", title: "Raise to $60", exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: SET, daily_budget_usd: 60 }, exec_status: "failed", body: {} };
  const obj = { ids: [SET], name: "Spring tests" };
  const budgetExec = { exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: SET, daily_budget_usd: 90 } };

  it("the audit case: a failed creative no longer blocks a budget raise on its ad set", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([failedCreative], { object: obj, exclude: {}, exec: budgetExec })).toEqual([]);
  });
  it("a failed creative whose outcome is unknown (temporary, or never sorted) still blocks a budget raise", async () => {
    const { contradictingCards } = await import("../open-advice");
    const temporary = { ...failedCreative, id: "ca-temp", exec_result: { bucket: "temporary" } };
    const unsorted = { ...failedCreative, id: "ca-unsorted", exec_result: undefined };
    expect(contradictingCards([temporary, unsorted], { object: obj, exclude: {}, exec: budgetExec }).map((c) => c.id)).toEqual(["ca-temp", "ca-unsorted"]);
  });
  it("a stored temporary bucket whose code sorts as a founder fix today no longer blocks other controls", async () => {
    const { contradictingCards } = await import("../open-advice");
    const resorted = { ...failedCreative, id: "ca-resorted", exec_result: { bucket: "temporary", code: "meta_ads_permission_revoked" } };
    expect(contradictingCards([resorted], { object: obj, exclude: {}, exec: budgetExec })).toEqual([]);
  });
  it("a failed budget change still blocks a different budget change (same control, genuine conflict)", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([failedBudget], { object: obj, exclude: {}, exec: budgetExec }).map((c) => c.id)).toEqual(["ca-failed-budget"]);
  });
  it("an OPEN card still blocks across controls — the founder has not decided it", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([openCreative], { object: obj, exclude: {}, exec: budgetExec }).map((c) => c.id)).toEqual(["ca-open-ad"]);
  });
  it("with no exec on the probe, a failed card keeps blocking (fail closed)", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([failedCreative], { object: obj, exclude: {} }).map((c) => c.id)).toEqual(["ca-failed-ad"]);
  });
  it("a failed card that may have landed (partial risk) still blocks every control", async () => {
    const { contradictingCards } = await import("../open-advice");
    const partial = { ...failedBudget, id: "ca-partial", exec_result: { bucket: "partial_risk" } };
    const statusExec = { exec_class: "meta_ads.set_status", exec_payload: { ad_set_id: SET, status: "ACTIVE" } };
    expect(contradictingCards([partial], { object: obj, exclude: {}, exec: statusExec }).map((c) => c.id)).toEqual(["ca-partial"]);
    expect(contradictingCards([{ ...failedBudget, exec_result: { bucket: "needs_founder" } }], { object: obj, exclude: {}, exec: statusExec })).toEqual([]);
  });
  it("controls: budget, status and targeting are distinct; creates match only their exact suffix", async () => {
    const { controlOfExecClass } = await import("../open-advice");
    expect(controlOfExecClass("meta_ads.update_ad_set_budget")).toBe("budget");
    expect(controlOfExecClass("google_ads.update_campaign_budget")).toBe("budget");
    expect(controlOfExecClass("meta_ads.set_status")).toBe("status");
    expect(controlOfExecClass("linkedin_ads.set_status")).toBe("status");
    expect(controlOfExecClass("meta_ads.replace_ad_set_geo")).toBe("targeting");
    expect(controlOfExecClass("meta_ads.create_ad")).toBe("create_ad");
    expect(controlOfExecClass("meta_ads.duplicate_ad_set")).toBe("duplicate_ad_set");
  });
});

describe("id-only payloads", () => {
  const TURO_SET = "120259468814150061";
  const rebuild = { id: "ca-rebuild", run_id: "r-1", channel_slug: "meta_ads", title: "Rebuild 40% to Turo as a conversion campaign", exec_class: null, exec_payload: null, body: {} };
  const otherExec = { id: "ca-exec", run_id: "r-2", channel_slug: "meta_ads", title: "Raise SF", exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "999999999999", daily_budget_usd: 45, expected_current_daily_budget_usd: 30 }, body: {} };
  const raise = { ad_set_id: TURO_SET, daily_budget_usd: 60, expected_current_daily_budget_usd: 40 };

  it("the name is read (with its campaign's) and matched against the prose card", async () => {
    const { adObjectFor, contradictingCards } = await import("../open-advice");
    const read = async (_c: string, _p: Record<string, unknown>, ids: string[]) => (ids[0] === TURO_SET ? ["Turo hosts - Traffic", "40% to Turo"] : []);
    const obj = await adObjectFor("t", "meta_ads.update_ad_set_budget", raise, read);
    expect(obj).toEqual({ ids: [TURO_SET], name: "Turo hosts - Traffic", names: ["Turo hosts - Traffic", "40% to Turo"] });
    expect(contradictingCards([rebuild, otherExec], { object: obj, exclude: {} }).map((c) => c.id)).toEqual(["ca-rebuild"]);
  });

  it("a name that cannot be read: every prose card counts (never an executable card of another object)", async () => {
    const { adObjectFor, contradictingCards } = await import("../open-advice");
    const failing = async () => {
      throw new Error("Graph 500");
    };
    const obj = await adObjectFor("t", "meta_ads.update_ad_set_budget", raise, failing);
    expect(obj).toEqual({ ids: [TURO_SET], name: null, nameUnknown: true });
    expect(contradictingCards([rebuild, otherExec], { object: obj, exclude: {} }).map((c) => c.id)).toEqual(["ca-rebuild"]);
    expect((await adObjectFor("t", "meta_ads.update_ad_set_budget", raise, async () => [])).nameUnknown).toBe(true);
  });

  it("a payload with its name is not read again; no ids and no name reads nothing", async () => {
    const { adObjectFor } = await import("../open-advice");
    let reads = 0;
    const read = async () => {
      reads++;
      return ["x"];
    };
    expect(await adObjectFor("t", "meta_ads.set_status", { object_id: TURO_SET, name: "40% to Turo" }, read)).toEqual({ ids: [TURO_SET], name: "40% to Turo" });
    expect(await adObjectFor("t", "meta_ads.set_status", {}, read)).toEqual({ ids: [], name: null });
    expect(reads).toBe(0);
  });

  it("the live reader asks Meta for the ad set and its campaign, and never sends a non-numeric id", async () => {
    const { liveAdNameReader } = await import("../open-advice");
    expect(await liveAdNameReader("t")("meta_ads.set_status", { object_id: "abc/../x" }, ["abc/../x"])).toEqual([]);
    expect(await liveAdNameReader("t")("google_ads.update_campaign_budget", { campaign_id: "1 OR 1=1" }, ["1 OR 1=1"])).toEqual([]);
  });
});

describe("two budget changes that leave the account in the same state", () => {
  const CAMP = "24109304360";
  const cardRow = (payload: Record<string, unknown>, exec_class = "google_ads.update_campaign_budget_review", exec_status: string | null = null, exec_result: unknown = null) => ({
    id: "ca-card", run_id: "r-card", channel_slug: "google_ads", title: "Let the campaign that books spend the extra $10 a day",
    exec_class, exec_payload: payload, exec_status, exec_result, body: {},
  });
  const cardPayload = { campaign_id: CAMP, name: "Upcar Sales Search Campaign", daily_budget_usd: 120, expected_current_daily_budget_usd: 110, over_cap: true, decision_evidence: { headline: "x" } };
  const probe = (payload: Record<string, unknown>, exec_class = "google_ads.update_campaign_budget") => ({
    object: { ids: [CAMP], name: "Upcar Sales Search Campaign" },
    exclude: {},
    exec: { exec_class, exec_payload: payload },
  });
  const order = { campaign_id: CAMP, daily_budget_usd: 120, expected_current_daily_budget_usd: 110, rationale: "behind pace", over_cap: false, name: "Upcar Sales Search Campaign" };

  it("$110 to $120 on the card and in cgo's order is one change: no question", async () => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([cardRow(cardPayload)], probe(order))).toEqual([]);
  });

  it.each([
    ["a different amount", { ...order, daily_budget_usd: 130 }],
    ["a cut instead of a raise", { ...order, daily_budget_usd: 100 }],
    ["a different starting amount", { ...order, expected_current_daily_budget_usd: 115 }],
    ["no starting amount", { campaign_id: CAMP, daily_budget_usd: 120 }],
  ])("%s is still a conflict", async (_label, payload) => {
    const { contradictingCards } = await import("../open-advice");
    expect(contradictingCards([cardRow(cardPayload)], probe(payload)).map((c) => c.id)).toEqual(["ca-card"]);
  });

  it("a cent of rounding on either number is still the same change; two cents is not", async () => {
    const { sameBudgetMove } = await import("../open-advice");
    const c = "google_ads.update_campaign_budget";
    expect(sameBudgetMove(c, cardPayload, c, { ...order, daily_budget_usd: 120.01, expected_current_daily_budget_usd: 110.01 })).toBe(true);
    expect(sameBudgetMove(c, cardPayload, c, { ...order, daily_budget_usd: 120.02 })).toBe(false);
  });

  it("another campaign's card with the same amounts is not excused by its numbers", async () => {
    const { sameBudgetMove } = await import("../open-advice");
    expect(sameBudgetMove("google_ads.update_campaign_budget_review", { ...cardPayload, campaign_id: "999" }, "google_ads.update_campaign_budget", order)).toBe(false);
  });

  it("another platform or level never matches", async () => {
    const { sameBudgetMove } = await import("../open-advice");
    expect(sameBudgetMove("meta_ads.update_campaign_budget", cardPayload, "google_ads.update_campaign_budget", order)).toBe(false);
    expect(sameBudgetMove("meta_ads.update_ad_set_budget", { ...cardPayload, ad_set_id: CAMP }, "meta_ads.update_campaign_budget", order)).toBe(false);
  });

  it("a card whose same write may have landed still blocks", async () => {
    const { contradictingCards } = await import("../open-advice");
    const failed = cardRow(cardPayload, "google_ads.update_campaign_budget_review", "failed", { bucket: "temporary" });
    expect(contradictingCards([failed], probe(order)).map((c) => c.id)).toEqual(["ca-card"]);
  });
});

describe("a prose card about an excused same-move exec card, from its own run", () => {
  const SET = "120258729006520059";
  const order = { exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: SET, daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149 } };
  const execCard = {
    id: "ca-exec", run_id: "run-b9", channel_slug: "meta_ads", title: 'Raise "Rent a car at $35 per day" from $149 to $178.80 a day',
    exec_class: "meta_ads.update_ad_set_budget_review",
    exec_payload: { ad_set_id: SET, daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149, name: "Rent a car at $35 per day", rationale: "r" },
    exec_status: null, body: {},
  };
  const prose = {
    id: "ca-prose", run_id: "run-b9", channel_slug: "meta_ads", title: "Approve or reject the $149 to $178.80 raise on the Meta Ads tile",
    exec_class: null, exec_payload: null, exec_status: null,
    body: { step: { body: 'Decide whether the Oct 26 revert of "Rent a car at $35 per day" to $120 still applies.', target: { kind: "ad_set", ref: SET } } },
  };
  const obj = { ids: [SET], name: "Rent a car at $35 per day" };
  const check = async (rows: unknown[], exec = order) => {
    const { contradictingCards } = await import("../open-advice");
    return contradictingCards(rows as never, { object: obj, exclude: {}, exec }).map((c) => c.id);
  };

  it("the same move: the exec card and its own prose card are both excused", async () => {
    expect(await check([execCard, prose])).toEqual([]);
  });
  it("a different amount (190) is not the same move: both conflict", async () => {
    expect(await check([execCard, prose], { ...order, exec_payload: { ...order.exec_payload, daily_budget_usd: 190 } })).toEqual(["ca-exec", "ca-prose"]);
  });
  it("a prose card from another run still conflicts", async () => {
    expect(await check([execCard, { ...prose, run_id: "run-other" }])).toEqual(["ca-prose"]);
  });
  it("a prose card that says rebuild, or the other way, still conflicts", async () => {
    expect(await check([execCard, { ...prose, title: 'Rebuild "Rent a car at $35 per day" as a new campaign' }])).toEqual(["ca-prose"]);
    expect(await check([execCard, { ...prose, title: "Cut the budget back to $120" }])).toEqual(["ca-prose"]);
  });
});
