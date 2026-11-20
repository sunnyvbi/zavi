import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({}), tenantMarkerAt: async () => null }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
import { cardBlockerId, deriveBlockers, failedDecisionFixesOf, type BlockerSources } from "../cgo-blockers";
import { classifyExecFailure, decisionFailureFix, fixWords, verdictFor } from "@/services/channels/exec-failure";
import { deterministicBackoffs } from "../ad-spend-controller";
import { META_PERMISSION_REVOKED_MESSAGE, META_TOKEN_EXPIRED_MESSAGE } from "@/services/tools/meta-ads/error-words";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const AGO = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const META_100_33 = `Meta Ads write failed: 400 {"error":{"message":"Unsupported post request. Object with ID '120000000000000001' does not exist, cannot be loaded due to missing permissions, or does not support this operation.","type":"GraphMethodException","code":100,"error_subcode":33,"fbtrace_id":"x"}}`;
const META_100_1885097 = `Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":1885097}}`;
const META_200 = `Meta Ads write failed: 403 {"error":{"message":"Permissions error","type":"OAuthException","code":200}}`;

function sources(over: Partial<BlockerSources> = {}): BlockerSources {
  return {
    questions: [],
    failedCards: [],
    leftCards: [],
    chainRoots: new Map(),
    connectors: [],
    metaNotReady: null,
    metaAccountBlocked: null,
    runningAds: true,
    spendStaleSince: null,
    stoppedBudgets: [],
    stuck: [],
    ...over,
  };
}

describe("Meta #100/33 sorting", () => {
  it("asks the founder (permission) and keeps every other #100 ours", () => {
    expect(classifyExecFailure({ error: META_100_33 })).toEqual({ bucket: "needs_founder", fix: "permission", platform_code: "meta_100_33" });
    expect(classifyExecFailure({ error: META_100_1885097 })).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "meta_100_1885097" });
  });

  it("no longer closes the card with 'nothing for you to do'", () => {
    expect(verdictFor({ error: META_100_33 }, "meta_ads.set_status")?.note).toBeNull();
    expect(verdictFor({ error: META_100_1885097 }, "meta_ads.set_status")?.note).toMatch(/nothing for you to do/);
  });

  it("words the fix for a lost login OR a deleted ad", () => {
    const w = fixWords("permission", "Meta Ads", "meta_100_33")!;
    expect(w).toMatch(/reconnect Meta Ads/);
    expect(w).toMatch(/still exists/);
    expect(fixWords("permission", "Meta Ads", "meta_200")).toBe("give Zavi's connection access to the Meta Ads account again");
  });

  it("is one object's card, not an account-wide blocker", () => {
    expect(cardBlockerId({ bucket: "needs_founder", fix: "permission", exec_class: "meta_ads.set_status", chain_root_id: "c1", platform_code: "meta_100_33" })).toBe("card:c1");
    expect(cardBlockerId({ bucket: "needs_founder", fix: "permission", exec_class: "meta_ads.set_status", chain_root_id: "c1", platform_code: "meta_200" })).toBe("account:meta_ads");
  });
});

describe("failed approved decisions the founder can fix", () => {
  const row = (id: string, dispatch_error: string, decision_class = "meta_ads.set_status_review", hours = 2) => ({ id, decision_class, dispatched_at: AGO(hours), dispatch_error });

  it("keeps founder fixes and drops what is ours, non-ad classes and reconnected platforms", () => {
    const rows = [
      row("d33", META_100_33),
      row("dbad", META_100_1885097),
      row("dmail", META_100_33, "email_marketing.send"),
      row("dnone", ""),
      row("dbudget", "cap_refuse: ad_budget_over_month"),
    ];
    expect(failedDecisionFixesOf(rows, new Map())).toEqual([
      { id: "d33", decision_class: "meta_ads.set_status_review", since: AGO(2), fix: "permission", platform_code: "meta_100_33", cut: false },
    ]);
    expect(failedDecisionFixesOf(rows, new Map([["meta_ads", AGO(1)]]))).toEqual([]);
    expect(failedDecisionFixesOf(rows, new Map([["meta_ads", AGO(5)]]))).toHaveLength(1);
  });

  it("shows a #100/33 decision as the founder's card with the fix words, not urgent", () => {
    const [d] = failedDecisionFixesOf([row("d33", META_100_33)], new Map());
    const [b] = deriveBlockers(sources({ failedDecisionFixes: [d] }), NOW);
    expect(b).toMatchObject({ id: "card:decision:d33", kind: "card", who: "you", at_risk_now: false });
    expect(b.what).toMatch(/did not go through: reconnect Meta Ads in Settings, or check in Meta Ads that the ad still exists.*If it still exists, make the change again$/);
  });

  it("a plain permission failure joins the account blocker", () => {
    const [d] = failedDecisionFixesOf([row("d200", META_200)], new Map());
    const [b] = deriveBlockers(sources({ failedDecisionFixes: [d] }), NOW);
    expect(b).toMatchObject({ id: "account:meta_ads", kind: "account", who: "you" });
  });

  it("a failed card with #100/33 reads the same way", () => {
    const card = {
      id: "a1",
      channel_slug: "meta_ads",
      title: "Turn on the spring campaign",
      exec_class: "meta_ads.set_status",
      exec_payload: { status: "ACTIVE" },
      exec_result: { error: META_100_33, ...classifyExecFailure({ error: META_100_33 }) },
      stake: null,
      proposed_at: AGO(3),
      failed_at: AGO(2),
    };
    const [b] = deriveBlockers(sources({ failedCards: [card] }), NOW);
    expect(b).toMatchObject({ id: "card:a1", kind: "card", who: "you", action_id: "a1" });
    expect(b.what).toMatch(/^"Turn on the spring campaign" did not go through: reconnect Meta Ads/);
  });
});

describe("the approvals page fix line", () => {
  it("is set only for an access failure on an approved Meta/Google change", () => {
    const d = { status: "dispatch_failed", decision_class: "meta_ads.set_status_review", dispatch_error: META_100_33 };
    expect(decisionFailureFix(d)?.text).toMatch(/^Reconnect Meta Ads in Settings, or check in Meta Ads that the ad still exists.*\. If it still exists, make the change again\.$/);
    expect(decisionFailureFix({ ...d, dispatch_error: META_200 })?.text).toBe("Give Zavi's connection access to the Meta Ads account again. Then make the change again.");
    expect(decisionFailureFix({ ...d, status: "acted" })).toBeNull();
    expect(decisionFailureFix({ ...d, dispatch_error: META_100_1885097 })).toBeNull();
    expect(decisionFailureFix({ ...d, decision_class: "github.open_pr" })).toBeNull();
    expect(decisionFailureFix({ ...d, dispatch_error: "cap_refuse: ad_budget_over_month" })).toBeNull();
  });
});

describe("Meta errors that keep only their words on a decision", () => {
  it("reads the login and role codes back from the stored message", () => {
    const d = { status: "dispatch_failed", decision_class: "meta_ads.set_status_review" };
    expect(decisionFailureFix({ ...d, dispatch_error: META_TOKEN_EXPIRED_MESSAGE })?.fix).toBe("reconnect");
    expect(decisionFailureFix({ ...d, dispatch_error: META_PERMISSION_REVOKED_MESSAGE })?.fix).toBe("permission");
    expect(decisionFailureFix({ ...d, decision_class: "meta_ads.replace_ad_set_geo_review", dispatch_error: `meta_ads_token_expired: ${META_TOKEN_EXPIRED_MESSAGE}` })?.fix).toBe("reconnect");
    expect(decisionFailureFix({ ...d, decision_class: "google_ads.set_status", dispatch_error: META_TOKEN_EXPIRED_MESSAGE })).toBeNull();
  });
});

describe("a failed pause on an object Meta cannot load", () => {
  it("keeps the may-be-gone words and stays urgent, instead of the cut's 'ads keep spending', for all 7 days", () => {
    const [d] = failedDecisionFixesOf([{ id: "p33", decision_class: "meta_ads.set_status", body: { level: "adset", object_id: "1", status: "PAUSED", over_cap: false }, dispatched_at: AGO(72), dispatch_error: META_100_33 }], new Map());
    expect(d.cut).toBe(true);
    const out = deriveBlockers(sources({ failedDecisionFixes: [d], failedDecisionCuts: [{ id: "p33", decision_class: "meta_ads.set_status", since: AGO(72) }] }), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "card:decision:p33", at_risk_now: true, meanwhile: "if it still exists, its ads keep spending until it is done" });
    expect(out[0].what).toMatch(/^A pause Zavi sent to Meta Ads did not go through: .*If it still exists, do it in Meta Ads yourself$/);
  });
});

describe("controller backoff", () => {
  it("backs an object off after Meta cannot load it twice, as it did when #100 was blocked_on_us", () => {
    const v = { ...classifyExecFailure({ error: META_100_33 }), error: META_100_33 };
    const fail = (h: number) => ({ body: { cgo_dwell_key: "meta:obj1" }, exec_status: "failed", exec_result: v, proposed_at: AGO(h), exec_claimed_at: AGO(h) });
    expect(deterministicBackoffs([fail(2), fail(1)], NOW).map((b) => b.dwell_key)).toEqual(["meta:obj1"]);
  });
});
