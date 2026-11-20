import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ adopt: vi.fn(), owned: vi.fn(), list: vi.fn(), get: vi.fn(), pages: vi.fn(), store: vi.fn(), rows: vi.fn(), settle: vi.fn(), commit: vi.fn(), release: vi.fn(), left: vi.fn(), rebase: vi.fn(), wake: vi.fn(), getPost: vi.fn() }));
vi.mock("./adapter", async (original) => ({ ...await original<typeof import("./adapter")>(), ownedAccount: mocks.owned, listObjects: mocks.list, getObject: mocks.get, getPost: mocks.getPost, pages: mocks.pages }));
vi.mock("./operations", async (original) => ({ ...await original<typeof import("./operations")>(), operationStore: mocks.store }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: mocks.rows }) }) }) }) }));
vi.mock("@/services/channels/exec-actions", () => ({ reconcileChannelActionExec: mocks.settle }));
vi.mock("@/services/decisions/ad-budget", () => ({ commitAdSpend: mocks.commit, releaseAdSpendForObject: mocks.release, noCommittedAdSpendHold: mocks.left, rebaseAdSpendForObject: mocks.rebase }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("./monitor", () => ({ wakeRedditChange: mocks.wake }));
vi.mock("./prepared-edits", async (original) => ({ ...await original<typeof import("./prepared-edits")>(), adoptPreparedEdit: mocks.adopt }));
import { memoryStore } from "./memory-store.test-support";
import { matchesRequest, reconcileRedditAction, reconcileRedditOperation } from "./reconcile";
let store: ReturnType<typeof memoryStore>;
beforeEach(() => { vi.clearAllMocks(); store = memoryStore(); mocks.store.mockReturnValue(store); mocks.owned.mockResolvedValue({ account: {} }); mocks.rows.mockImplementation(async () => ({ data: [...store.rows.values()], error: null })); mocks.get.mockImplementation(async (_a: unknown, _account: string, _level: string, id: string) => ({ id, name: "stable", configured_status: "PAUSED", ad_account_id: "account" })); mocks.list.mockResolvedValue([{ id: "c1", name: "stable" }]); mocks.settle.mockResolvedValue({ ok: true }); mocks.release.mockResolvedValue(true); mocks.left.mockResolvedValue(true); });
describe("read-only Reddit reconciliation", () => {
  it("confirms equivalent targeting order without accepting unapproved advanced audiences", () => {
    const expected = { targeting: { geolocations: ["US", "CA"], communities: [], interests: [], locations: ["FEED"], expand_targeting: false } };
    const live = { targeting: { ...expected.targeting, geolocations: ["CA", "US"] } };
    expect(matchesRequest(live, expected)).toBe(true);
    expect(matchesRequest({ targeting: { ...live.targeting, custom_audience_ids: ["unapproved"] } }, expected)).toBe(false);
  });
  it("treats omitted exclusions as none and never adopts a group with unapproved exclusions", () => {
    const expected = { targeting: { geolocations: ["US"], communities: [], interests: [], locations: ["FEED"], expand_targeting: false } };
    expect(matchesRequest({ targeting: { ...expected.targeting, excluded_geolocations: [] } }, expected)).toBe(true);
    expect(matchesRequest({ targeting: { ...expected.targeting, excluded_geolocations: ["GB"] } }, expected)).toBe(false);
    const excluding = { targeting: { ...expected.targeting, excluded_geolocations: ["GB", "CA"] } };
    expect(matchesRequest({ targeting: { ...expected.targeting, excluded_geolocations: ["CA", "GB"] } }, excluding)).toBe(true);
    expect(matchesRequest({ targeting: expected.targeting }, excluding)).toBe(false);
  });
  it("recovers a timed-out create without issuing another create", async () => {
    await store.claim("campaign", { name: "stable", configured_status: "PAUSED" });
    await store.save("campaign", "unknown", { error: "timeout" });
    const r = await reconcileRedditOperation("tenant", "operation_key", "action", "account");
    expect(r).toMatchObject({ unresolved: false, ids: { campaign: "c1" } });
    expect(store.rows.get("campaign")?.state).toBe("complete");
    expect(mocks.owned).toHaveBeenCalledWith("tenant", "account");
  });
  it("retains uncertainty when no object or multiple objects match", async () => {
    await store.claim("group", { name: "stable" });
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "g1", name: "stable" }, { id: "g2", name: "stable" }]);
    expect((await reconcileRedditOperation("tenant", "operation_key", "action", "account")).unresolved).toBe(true);
    expect((await reconcileRedditOperation("tenant", "operation_key", "action", "account")).unresolved).toBe(true);
    expect(store.rows.get("group")?.state).toBe("running");
  });
  it("does not settle a healthy or still-running execution", async () => {
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.update_budget", exec_status: "dispatching", exec_result: null, exec_payload: {}, exec_progress: null, approved_by_source: "cgo", lease_expired: false };
    expect(await reconcileRedditAction("action", target)).toEqual({ done: false, outcome: "in_flight" });
    expect(await reconcileRedditAction("action", { ...target, exec_status: "executed" })).toEqual({ done: true, outcome: "nothing_to_do" });
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("recovers a crashed update through the same ledger RPC and honours refusal", async () => {
    await store.claim("patch", { id: "group", configured_status: "PAUSED" });
    await store.save("patch", "unknown", { error: "lost response" });
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.set_object_status", exec_status: "failed", exec_result: { code: "exec_partial" }, exec_payload: { ad_account_id: "account", object_id: "group", level: "ad_group", name: "Pause group", rationale: "Founder request", status: "PAUSED", expected_modified_at: "old" }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    mocks.settle.mockResolvedValueOnce({ ok: false, code: "not_unknown" });
    expect(await reconcileRedditAction("action", target)).toEqual({ done: false, outcome: "could_not_read" });
    expect(await reconcileRedditAction("action", target)).toEqual({ done: true, outcome: "confirmed" });
    expect(mocks.settle).toHaveBeenLastCalledWith("tenant", expect.objectContaining({ actionId: "action", execClass: target.exec_class, ok: true }));
    expect(mocks.release).toHaveBeenCalledWith("tenant", "reddit", "group");
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
  it("a recovered pause whose budget hold cannot be confirmed released says so", async () => {
    await store.claim("patch", { id: "group", configured_status: "PAUSED" });
    await store.save("patch", "unknown", { error: "lost response" });
    mocks.left.mockResolvedValue(false);
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.set_object_status", exec_status: "failed", exec_result: { code: "exec_partial" }, exec_payload: { ad_account_id: "account", object_id: "group", level: "ad_group", name: "Pause group", rationale: "Founder request", status: "PAUSED", expected_modified_at: "old" }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    expect(await reconcileRedditAction("action", target)).toEqual({ done: true, outcome: "confirmed" });
    expect(mocks.release).toHaveBeenCalledTimes(1);
    const settled = mocks.settle.mock.calls.at(-1)?.[1] as { result: { notice: string; execution_details: { external_ids: Record<string, unknown> } } };
    expect(settled.result.notice).toContain("may still count against your ad budget");
    expect(settled.result.execution_details.external_ids).toMatchObject({ budget_hold: "release_unconfirmed" });
  });
  it("rebases reservations after read-confirmed recovery of a budget cut", async () => {
    await store.claim("patch", { id: "group", goal_value: 5000000 });
    await store.save("patch", "unknown", { error: "timeout" });
    mocks.get.mockResolvedValue({ id: "group", ad_account_id: "account", goal_value: 5000000 });
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.update_budget", exec_status: "failed", exec_result: { code: "exec_outcome_unknown" }, exec_payload: { ad_account_id: "account", ad_group_id: "group", name: "Cut budget", rationale: "Founder request", expected_current_daily_budget_usd: 10, daily_budget_usd: 5 }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    expect(await reconcileRedditAction("action", target)).toEqual({ done: true, outcome: "confirmed" });
    expect(mocks.rebase).toHaveBeenCalledWith("tenant", "reddit", "group", 5, "action:rebase", 5);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.adopt).toHaveBeenCalledWith("tenant", {}, { kind: "budget", ad_group_id: "group", daily_budget_usd: 5 });
  });
  it("tells the founder when a recovered edit could not update the prepared plan", async () => {
    await store.claim("patch", { id: "group", goal_value: 5000000 });
    await store.save("patch", "unknown", { error: "timeout" });
    mocks.get.mockResolvedValue({ id: "group", ad_account_id: "account", goal_value: 5000000 });
    mocks.adopt.mockRejectedValueOnce(new Error("verification failed"));
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.update_budget", exec_status: "failed", exec_result: { code: "exec_outcome_unknown" }, exec_payload: { ad_account_id: "account", ad_group_id: "group", name: "Cut budget", rationale: "Founder request", expected_current_daily_budget_usd: 10, daily_budget_usd: 5 }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    expect(await reconcileRedditAction("action", target)).toEqual({ done: true, outcome: "confirmed" });
    const settled = mocks.settle.mock.calls[0][1] as { result: { notice: string; plan_warning: string; execution_details: { next_recovery_step: string } } };
    expect(settled.result.notice).toContain("could not update the prepared campaign's plan");
    expect(settled.result.plan_warning).toContain("check_readiness");
    expect(settled.result.execution_details.next_recovery_step).toContain("check_readiness");
    expect(mocks.wake).toHaveBeenCalledWith("tenant", expect.any(String), [expect.stringContaining("could not update the prepared campaign's plan")], { quiet_ok: false });
  });
  it("confirms a recovered replacement only after its post reads back as approved", async () => {
    const creative = { name: "Second", headline: "New words", destination_url: "https://shop.example.com", image_url: "https://cdn.example.com/a.jpg" };
    const ad = { id: "ad_9", ad_group_id: "group", post_id: "post_9", click_url: creative.destination_url, configured_status: "PAUSED" };
    await store.claim("replacement_ad", { ad_group_id: "group", post_id: "post_9", click_url: creative.destination_url, configured_status: "PAUSED" });
    await store.save("replacement_ad", "complete", ad);
    mocks.get.mockResolvedValue({ ...ad, ad_account_id: "account" });
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.replace_creative", exec_status: "failed", exec_result: { code: "exec_outcome_unknown" }, exec_payload: { ad_account_id: "account", ad_group_id: "group", profile_id: "profile", operation_key: "replacement_123", name: "Replace", rationale: "why", creative }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    const post = { profile_id: "profile", headline: "New words", type: "IMAGE", allow_comments: false, content: [{ destination_url: creative.destination_url }] };
    mocks.getPost.mockResolvedValueOnce({ ...post, headline: "Something else" });
    expect(await reconcileRedditAction("action", target)).toEqual({ done: false, outcome: "could_not_read" });
    expect(mocks.settle).not.toHaveBeenCalled();
    mocks.getPost.mockResolvedValueOnce(post);
    expect(await reconcileRedditAction("action", target)).toEqual({ done: true, outcome: "confirmed" });
    expect(mocks.getPost).toHaveBeenLastCalledWith({}, "post_9");
  });
  it("retains uncertainty when a completed patch was subsequently changed", async () => {
    await store.claim("patch", { id: "group", goal_value: 5000000 });
    await store.save("patch", "complete", { id: "group", goal_value: 5000000 });
    mocks.get.mockResolvedValue({ id: "group", ad_account_id: "account", goal_value: 20000000 });
    const target = { tenant_id: "tenant", exec_class: "reddit_ads.update_budget", exec_status: "failed", exec_result: { code: "exec_outcome_unknown" }, exec_payload: { ad_account_id: "account", ad_group_id: "group", name: "Cut budget", rationale: "Founder request", expected_current_daily_budget_usd: 10, daily_budget_usd: 5 }, exec_progress: null, approved_by_source: "founder", lease_expired: true };
    expect(await reconcileRedditAction("action", target)).toEqual({ done: false, outcome: "could_not_read" });
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.rebase).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.adopt).not.toHaveBeenCalled();
  });
});
