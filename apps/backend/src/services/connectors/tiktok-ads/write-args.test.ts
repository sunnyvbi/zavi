import { describe, expect, it } from "vitest";
import { applyTiktokAdvertiser } from "./write-args";
import type { AdAccountsState } from "./ad-accounts";
import { ExpectedToolError } from "@/services/tools/types";

const account = (id: string, name: string) => ({ advertiser_id: id, name, currency: "USD", status: "ENABLE", timezone: "UTC", source: "business_center" as const });
const state = (over: Partial<AdAccountsState> = {}): AdAccountsState => ({
  connected: true,
  accounts: [account("111", "Main"), account("222", "Second")],
  selected_id: "111",
  needs: "nothing",
  checked_at: null,
  ...over,
});
const one = { properties: { advertiser_id: { type: "string" }, budget: { type: "number" } }, required: ["advertiser_id"] };
const run = (args: unknown, s: AdAccountsState | Error, schema: unknown = one, slug = "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET") =>
  applyTiktokAdvertiser("t", slug, args, schema as never, async () => {
    if (s instanceof Error) throw s;
    return s;
  });

describe("applyTiktokAdvertiser", () => {
  it("fills in the chosen ad account when the agent leaves it out", async () => {
    expect(await run({ budget: 50 }, state())).toEqual({ ok: true, args: { budget: 50, advertiser_id: "111" } });
  });

  it("a write may name any saved account (reachable by this login), never one outside the list", async () => {
    expect(await run({ advertiser_id: "222" }, state())).toEqual({ ok: true, args: { advertiser_id: "222" } });
    expect(await run({ advertiser_id: "111" }, state())).toEqual({ ok: true, args: { advertiser_id: "111" } });
    expect(await run({ advertiser_id: "222" }, state({ selected_id: null, needs: "pick" }))).toEqual({ ok: true, args: { advertiser_id: "222" } });
    const r = await run({ advertiser_id: "999" }, state());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_unknown_account" });
    expect(!r.ok && r.message).toContain("Main (111), Second (222)");
  });

  it("a read may name any saved account but never one the founder does not have", async () => {
    const read = (args: unknown) => run(args, state(), one, "TIKTOK_ADS_GET_CREATIVE_ASSETS");
    expect(await read({ advertiser_id: "222" })).toEqual({ ok: true, args: { advertiser_id: "222" } });
    expect(await read({ advertiser_id: "999" })).toMatchObject({ ok: false, code: "tiktok_ads_unknown_account" });
  });

  it("asks the founder to choose when none is chosen yet", async () => {
    expect(await run({}, state({ selected_id: null, needs: "pick" }))).toMatchObject({ ok: false, code: "tiktok_ads_account_not_chosen" });
    expect(await run({}, state({ accounts: [], selected_id: null, needs: "paste" }))).toMatchObject({ ok: false, code: "tiktok_ads_account_not_chosen" });
  });

  it("checks every id in an advertiser_ids list and fills a required one", async () => {
    const many = { properties: { advertiser_ids: { type: "array" } }, required: ["advertiser_ids"] };
    expect(await run({ advertiser_ids: ["111", "222"] }, state(), many)).toEqual({ ok: true, args: { advertiser_ids: ["111", "222"] } });
    expect(await run({ advertiser_ids: ["111", "999"] }, state(), many)).toMatchObject({ ok: false, code: "tiktok_ads_unknown_account" });
    expect(await run({}, state(), many)).toEqual({ ok: true, args: { advertiser_ids: ["111"] } });
    expect(await run({}, state({ selected_id: null, needs: "pick" }), many)).toMatchObject({ ok: false, code: "tiktok_ads_account_not_chosen" });
    expect(await run({ advertiser_ids: [] }, state({ selected_id: null, needs: "pick" }), many)).toMatchObject({ ok: false, code: "tiktok_ads_account_not_chosen" });
    expect(await run({ advertiser_ids: [] }, state(), many)).toEqual({ ok: true, args: { advertiser_ids: ["111"] } });
    expect(await run({ advertiser_ids: "222" }, state(), many)).toMatchObject({ ok: false, code: "tiktok_ads_bad_account_id" });
    expect(await run({}, state(), many, "TIKTOK_ADS_GET_ADVERTISER_ACCOUNTS")).toEqual({ ok: true, args: { advertiser_ids: ["111", "222"] } });
  });

  it("leaves other toolkits, account-less tools and disconnected tenants alone", async () => {
    const loader = async () => { throw new Error("should not load"); };
    expect(await applyTiktokAdvertiser("t", "GMAIL_SEND_EMAIL", { to: "a" }, one as never, loader)).toEqual({ ok: true, args: { to: "a" } });
    expect(await applyTiktokAdvertiser("t", "TIKTOK_ADS_LIST_BUSINESS_CENTERS", {}, { properties: {} } as never, loader)).toEqual({ ok: true, args: {} });
    expect(await run({ budget: 1 }, state({ connected: false, accounts: [], selected_id: null }))).toEqual({ ok: true, args: { budget: 1 } });
  });

  it("fails closed when the saved accounts cannot be read", async () => {
    expect(await run({}, new Error("db down"))).toMatchObject({ ok: false, code: "tiktok_ads_accounts_unavailable" });
    expect(await run({}, new ExpectedToolError("tiktok_ads_token_revoked", "x"))).toMatchObject({ ok: false, code: "tiktok_ads_token_revoked" });
  });
});
