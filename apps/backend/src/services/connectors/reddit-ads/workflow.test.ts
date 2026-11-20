import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owned: vi.fn(), get: vi.fn(), list: vi.fn(), pages: vi.fn(), create: vi.fn(), post: vi.fn(), patch: vi.fn(), ready: vi.fn(), store: vi.fn(), budget: vi.fn(), policy: vi.fn(), reserve: vi.fn(), commit: vi.fn(), drop: vi.fn(), send: vi.fn(), role: vi.fn(), getPost: vi.fn(), release: vi.fn(), left: vi.fn(), log: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: mocks.role }));
vi.mock("./adapter", async (original) => ({ ...await original<typeof import("./adapter")>(), ownedAccount: mocks.owned, getObject: mocks.get, listObjects: mocks.list, pages: mocks.pages, getPost: mocks.getPost }));
vi.mock("./writes", async (original) => ({ ...await original<typeof import("./writes")>(), createObject: mocks.create, createImagePost: mocks.post, patchObject: mocks.patch }));
const db = vi.hoisted(() => ({ operations: (): unknown[] => [] }));
vi.mock("@/services/tenant-client", () => {
  const query = (table: string) => {
    const result = () => ({ data: table === "reddit_ad_operations" ? db.operations() : [], error: null });
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "or", "range"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
    return q;
  };
  return { asTenantId: (id: string) => id, tenantClient: () => ({ from: query }) };
});
vi.mock("./monitor", () => ({ wakeRedditChange: vi.fn() }));
const lock = vi.hoisted(() => ({ locked: false }));
vi.mock("@/services/channels/lock", async (orig) => ({ ...(await orig<typeof import("@/services/channels/lock")>()), assertSpendWritesOn: async (_s: string, label: string, code: string) => { if (lock.locked) { const { ExpectedToolError } = await import("@/services/tools/types"); throw new ExpectedToolError(`${code}_write_disabled`, `${label} changes are switched off`); } } }));
vi.mock("./readiness-gates", () => ({ assertReady: mocks.ready }));
vi.mock("./operations", async (original) => ({ ...await original<typeof import("./operations")>(), operationStore: mocks.store }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: mocks.budget }));
vi.mock("@/services/growth/unattended-policy", () => ({ authorizeUnattended: mocks.policy }));
vi.mock("@/services/decisions/ad-budget", () => ({ reserveAdSpend: mocks.reserve, commitAdSpend: mocks.commit, dropAdSpendHold: mocks.drop, rebaseAdSpendForObject: vi.fn(), releaseAdSpendForObject: mocks.release, noCommittedAdSpendHold: mocks.left }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/services/decisions/ad-changes", () => ({ recordZaviAdChange: vi.fn() }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));
import { memoryStore } from "./memory-store.test-support";
import { executeRedditAction, type RedditExecRow } from "./execute";
import { prepareSchema } from "./schema";
import type { RedditObject } from "./adapter";
import { ExpectedToolError } from "@/services/tools/types";
import { writeFailure } from "./writes";
import { verdictFor } from "@/services/channels/exec-failure";
const stores = new Map<string, ReturnType<typeof memoryStore>>();
const objects = new Map<string, RedditObject>();
const posts: RedditObject[] = [];
const account = { tenant_id: "tenant", toolkit: "reddit_ads", connected_account_id: "sealed", auth_config_id: "config" };
const plan = prepareSchema.parse({ ad_account_id: "account", profile_id: "profile", pixel_id: "pixel", operation_key: "operation_123", name: "Traffic test", rationale: "Business goal: qualified visits", objective: "CLICKS", daily_budget_usd: 10, lifetime_cap_usd: 100, start_time: "2099-01-01T09:00:00-08:00", targeting: { geolocations: ["US"] }, creatives: [{ name: "First image", headline: "Plan your next trip", image_url: "https://example.com/image.jpg", destination_url: "https://example.com/trips" }] });
const action = (cls: string, body: unknown, source = "founder"): RedditExecRow => ({ id: cls.endsWith("prepare_campaign") ? "prepare_action" : "launch_action", tenant_id: "tenant", decision_class: cls, body, approved_by: source, approved_by_source: source, exec_source: "channel_actions" });
beforeEach(() => {
  vi.clearAllMocks(); stores.clear(); objects.clear(); posts.length = 0;
  db.operations = () => [...stores.entries()].flatMap(([scoped, store]) => [...store.rows.values()].filter((r) => r.state === "complete").map((r) => ({ operation_key: scoped.split(":")[1], step: r.step, result: r.result })));
  mocks.owned.mockResolvedValue({ account, details: { currency: "USD" } });
  mocks.ready.mockResolvedValue({ account, details: { currency: "USD" } });
  mocks.store.mockImplementation((tenant: string, key: string) => { const scoped = `${tenant}:${key}`; if (!stores.has(scoped)) stores.set(scoped, memoryStore()); return stores.get(scoped); });
  mocks.pages.mockImplementation(async (_a: unknown, slug: string) => slug === "LIST_POSTS" ? posts : [{ id: "profile" }]);
  mocks.getPost.mockImplementation(async (_a: unknown, id: string) => { const p = posts.find((x) => x.id === id); if (!p) throw new Error(`Missing ${id}`); return structuredClone(p); });
  mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) => [...objects.values()].filter((o) => o.test_level === level));
  mocks.get.mockImplementation(async (_a: unknown, _id: string, _level: string, id: string) => { const o = objects.get(id); if (!o) throw new Error(`Missing ${id}`); return structuredClone(o); });
  mocks.create.mockImplementation(async (_a: unknown, id: string, level: string, data: Record<string, unknown>) => { const obj: RedditObject = { id: `${level}_${objects.size}`, ad_account_id: id, is_campaign_budget_optimization: false, modified_at: "initial", effective_status: "PAUSED", test_level: level, ...data }; if (level === "ad") obj.campaign_id = "campaign_0"; objects.set(obj.id, obj); return structuredClone(obj); });
  mocks.post.mockImplementation(async (_a: unknown, profile: string, data: Record<string, unknown>) => { const obj = { id: `post_${posts.length}`, profile_id: profile, ...data }; posts.push(obj); return obj; });
  mocks.patch.mockImplementation(async (_a: unknown, _level: string, id: string, data: Record<string, unknown>) => { const prior = objects.get(id)!; objects.set(id, { ...prior, ...data, modified_at: `updated_${mocks.patch.mock.calls.length}`, effective_status: "PENDING_REVIEW" }); });
  mocks.budget.mockResolvedValue({ monthly_usd: 1000 }); mocks.policy.mockResolvedValue({ verdict: "allow", reasons: [] });
  mocks.reserve.mockResolvedValue({ status: "held", tenant_id: "tenant", idem_key: "hold", fresh: true });
  mocks.role.mockResolvedValue("owner");
  mocks.commit.mockResolvedValue(undefined); mocks.drop.mockResolvedValue(undefined); mocks.send.mockResolvedValue({ ids: [] });
  mocks.release.mockResolvedValue(true); mocks.left.mockResolvedValue(true); mocks.log.mockResolvedValue(undefined);
});
describe("complete governed Reddit workflow", () => {
  it("creates a campaign, ad group, image post and real ad paused and persists IDs", async () => {
    const r = await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "created_paused", delivery_state: "unconfirmed", external_ids: { campaign_id: "campaign_0", ad_group_id: "ad_group_1", ad_ids: ["ad_2"] } } });
    expect([...objects.values()].every((o) => o.configured_status === "PAUSED")).toBe(true);
    expect(stores.get("tenant:operation_123")?.rows.get("manifest")?.state).toBe("complete");
    expect(mocks.reserve).not.toHaveBeenCalled();
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("launches separately, reserves first and distinguishes enablement from delivery", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const r = await executeRedditAction(action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "enabled", delivery_state: "unconfirmed" } });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ platform: "reddit", object_id: "ad_group_1", daily_delta_usd: 10 }));
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.patch.mock.invocationCallOrder[0]);
    expect(mocks.patch.mock.calls.map((c) => c[2])).toEqual(["ad_2", "ad_group_1", "campaign_0"]);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });
  it("permits CGO-approved preparation only while Autopilot remains on", async () => {
    const r = await executeRedditAction(action("reddit_ads.prepare_campaign", plan, "cgo"));
    expect(r.ok).toBe(true); expect(mocks.policy).toHaveBeenCalled();
    stores.clear(); objects.clear(); posts.length = 0; mocks.create.mockClear(); mocks.budget.mockResolvedValue(null);
    expect(await executeRedditAction(action("reddit_ads.prepare_campaign", plan, "cgo"))).toMatchObject({ ok: false, held_for_founder: true, code: "reddit_ads_autopilot_off" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("holds queued work if Autopilot switches off immediately before writing", async () => {
    mocks.budget.mockResolvedValueOnce({ monthly_usd: 1000 }).mockResolvedValue(null);
    expect(await executeRedditAction(action("reddit_ads.prepare_campaign", plan, "cgo"))).toMatchObject({ ok: false, held_for_founder: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("blocks unapproved work, unsupported currency and missing tracking", async () => {
    expect((await executeRedditAction({ ...action("reddit_ads.prepare_campaign", plan), approved_by: null })).ok).toBe(false);
    mocks.owned.mockResolvedValue({ account, details: { currency: "EUR" } });
    expect(await executeRedditAction(action("reddit_ads.prepare_campaign", plan))).toMatchObject({ ok: false, code: "reddit_ads_currency_unsupported" });
    mocks.owned.mockResolvedValue({ account, details: { currency: "USD" } }); mocks.ready.mockRejectedValue(new ExpectedToolError("reddit_ads_pixel_not_owned", "Pixel not owned"));
    expect(await executeRedditAction(action("reddit_ads.prepare_campaign", plan))).toMatchObject({ ok: false, code: "reddit_ads_pixel_not_owned" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("resumes completed creation steps after a definite partial refusal", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(create).mockRejectedValueOnce(new ExpectedToolError("reddit_ads_permission_denied", "denied"));
    expect((await executeRedditAction(action("reddit_ads.prepare_campaign", plan))).ok).toBe(false);
    expect(objects.size).toBe(1);
    expect((await executeRedditAction(action("reddit_ads.prepare_campaign", plan))).ok).toBe(true);
    expect([...objects.values()].filter((o) => o.test_level === "campaign")).toHaveLength(1);
  });
  it("retains a reservation after a launch timeout without repeating the write", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.patch.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_outcome_unknown", "timeout"));
    const launch = action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" });
    expect(await executeRedditAction(launch)).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    expect(mocks.drop).not.toHaveBeenCalled();
    await executeRedditAction(launch);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("rejects insufficient budget and any founder edit before launch", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const launch = action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" });
    mocks.reserve.mockResolvedValueOnce({ status: "refused", error: "insufficient budget" });
    expect(await executeRedditAction(launch)).toMatchObject({ ok: false, code: "reddit_ads_budget_refused" });
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, modified_at: "founder_edited", configured_status: "PAUSED" });
    expect(await executeRedditAction(launch)).toMatchObject({ ok: false, code: "reddit_ads_object_drifted" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("isolates durable keys between tenants", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    expect(mocks.store("another_tenant", plan.operation_key).rows.size).toBe(0);
  });
  it("pauses a prepared ad group for the founder and releases its reservation", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const r = await executeRedditAction(action("reddit_ads.set_object_status", { ad_account_id: "account", level: "ad_group", object_id: "ad_group_1", name: "Pause group", rationale: "Founder request", status: "PAUSED", expected_modified_at: "initial" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "paused", external_ids: { ad_group_id: "ad_group_1" } } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "ad_group_1", { configured_status: "PAUSED" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("updates an approved daily budget with a reservation and read-back", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const result = await executeRedditAction(action("reddit_ads.update_budget", { ad_account_id: "account", ad_group_id: "ad_group_1", name: "Raise daily budget", rationale: "Approved increase", expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }));
    expect(result).toMatchObject({ ok: true, execution_details: { execution_state: "updated" } });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "raise", daily_delta_usd: 1 }));
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "ad_group_1", { goal_value: 11000000 });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });
  it("releases a fresh reservation if Autopilot stops before the patch", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.budget.mockResolvedValueOnce({ monthly_usd: 1000 }).mockResolvedValue(null);
    const result = await executeRedditAction(action("reddit_ads.update_budget", { ad_account_id: "account", ad_group_id: "ad_group_1", name: "Raise daily budget", rationale: "Approved increase", expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }, "cgo"));
    expect(result).toMatchObject({ ok: false, held_for_founder: true, outcome_unknown: false });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.drop).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }));
  });
});

describe("Reddit edits of live objects and replacement creatives", () => {
  const prepared = async () => { await executeRedditAction(action("reddit_ads.prepare_campaign", plan)); return objects.get("ad_2")!; };
  const card = (cls: string, body: Record<string, unknown>, source = "founder"): RedditExecRow => ({ ...action(cls, { ad_account_id: "account", name: "Edit", rationale: "Approved edit", ...body }, source), id: `${cls}_action` });
  const turnOn = (...ids: string[]) => { for (const id of ids) objects.set(id, { ...objects.get(id)!, configured_status: "ACTIVE" }); };
  it("changes an ad's tracking link after a drift check and read-back, with no reservation", async () => {
    const ad = await prepared();
    const r = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "updated", external_ids: { ad_id: "ad_2" } } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad", "ad_2", { click_url: "https://example.com/trips?utm_source=reddit" });
    expect(objects.get("ad_2")?.click_url).toBe("https://example.com/trips?utm_source=reddit");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("refuses a destination change proposed against a stale snapshot before any write", async () => {
    const ad = await prepared();
    const r = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: "stale", destination_url: "https://example.com/trips?utm_source=reddit" }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_object_drifted" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("replaces an ad group's targeting and confirms it order-insensitively", async () => {
    await prepared();
    const group = objects.get("ad_group_1")!;
    const targeting = { geolocations: ["CA", "US"], excluded_geolocations: ["GB"], communities: ["travel"], interests: [], locations: ["FEED"], expand_targeting: false };
    const r = await executeRedditAction(card("reddit_ads.update_targeting", { ad_group_id: group.id, expected_modified_at: group.modified_at, targeting }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "updated", external_ids: { ad_group_id: "ad_group_1" } } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "ad_group_1", { targeting });
    expect(objects.get("ad_group_1")?.goal_value).toBe(10000000);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("refuses targeting that both targets and excludes a place before any Reddit call", async () => {
    await prepared();
    const group = objects.get("ad_group_1")!;
    const reads = mocks.get.mock.calls.length;
    const r = await executeRedditAction(card("reddit_ads.update_targeting", { ad_group_id: group.id, expected_modified_at: group.modified_at, targeting: { geolocations: ["US"], excluded_geolocations: ["us"] } }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request" });
    expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("refuses a member-approved targeting change, takes no hold for an admin's, and keeps a CGO one with the founder", async () => {
    await prepared();
    const group = objects.get("ad_group_1")!;
    const body = { ad_group_id: group.id, expected_modified_at: group.modified_at, targeting: { geolocations: ["US", "CA"] } };
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(card("reddit_ads.update_targeting", body))).toMatchObject({ ok: false, code: "reddit_ads_admin_required", held_for_founder: true });
    expect(mocks.patch).not.toHaveBeenCalled();
    mocks.policy.mockResolvedValue({ verdict: "ask_founder", reasons: ["reddit_edit_needs_founder"] });
    expect(await executeRedditAction(card("reddit_ads.update_targeting", body, "cgo"))).toMatchObject({ ok: false, code: "reddit_ads_policy_held", held_for_founder: true });
    expect(mocks.patch).not.toHaveBeenCalled();
    mocks.role.mockResolvedValue("admin");
    expect(await executeRedditAction(card("reddit_ads.update_targeting", body))).toMatchObject({ ok: true });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("refuses a click link to a different page than the image post, with nothing written", async () => {
    const ad = await prepared();
    mocks.patch.mockClear();
    const r = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/other-page" }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("propose_replace_creative") });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("refuses when the image post cannot be read, with nothing written", async () => {
    const ad = await prepared();
    mocks.patch.mockClear();
    mocks.getPost.mockRejectedValueOnce(new Error("down"));
    expect(await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }))).toMatchObject({ ok: false, code: "reddit_ads_post_unreadable" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("lets any member approve a destination change (it cannot widen reach)", async () => {
    const ad = await prepared();
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }))).toMatchObject({ ok: true });
  });
  it("creates a paused replacement ad with a new post and leaves the existing ad untouched", async () => {
    const original = structuredClone(await prepared());
    const body = { ad_group_id: "ad_group_1", profile_id: "profile", operation_key: "replacement_123", creative: { ...plan.creatives[0], name: "Second image", headline: "Try a different trip", image_url: "https://example.com/other.jpg" } };
    const r = await executeRedditAction(card("reddit_ads.replace_creative", body));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "created_paused", external_ids: { ad_id: "ad_3", post_id: "post_1", ad_group_id: "ad_group_1", operation_key: "replacement_123" } }, created: { object_type: "ad", status: "PAUSED" } });
    expect(objects.get("ad_2")).toEqual(original);
    expect(objects.get("ad_3")).toMatchObject({ configured_status: "PAUSED", post_id: "post_1", ad_group_id: "ad_group_1", click_url: "https://example.com/trips" });
    expect(posts[1]).toMatchObject({ headline: "Try a different trip" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    await executeRedditAction(card("reddit_ads.replace_creative", body));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledTimes(4);
  });
  it("fails verification when the replacement post reads back with different copy or ownership", async () => {
    await prepared();
    mocks.getPost.mockImplementation(async (_a: unknown, id: string) => ({ ...posts.find((x) => x.id === id)!, headline: "Something Reddit changed" }));
    const r = await executeRedditAction(card("reddit_ads.replace_creative", { ad_group_id: "ad_group_1", profile_id: "profile", operation_key: "replacement_123", creative: { ...plan.creatives[0], name: "Second image", headline: "Try a different trip" } }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_verification_failed", error: expect.stringContaining("replacement post") });
    expect(mocks.getPost).toHaveBeenCalledWith(account, "post_1");
  });
  it("refuses a replacement in an archived ad group and a reused key with a different creative", async () => {
    await prepared();
    const body = { ad_group_id: "ad_group_1", profile_id: "profile", operation_key: "replacement_123", creative: { ...plan.creatives[0], name: "Second image", headline: "Try a different trip" } };
    await executeRedditAction(card("reddit_ads.replace_creative", body));
    expect(await executeRedditAction(card("reddit_ads.replace_creative", { ...body, creative: { ...body.creative, headline: "Changed words" } }))).toMatchObject({ ok: false, code: "reddit_ads_operation_conflict" });
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, configured_status: "ARCHIVED" });
    expect(await executeRedditAction(card("reddit_ads.replace_creative", { ...body, operation_key: "replacement_456" }))).toMatchObject({ ok: false, code: "reddit_ads_invalid_request" });
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
  it("turns a paused ad group back on: readiness, a resume hold before the write, then commit", async () => {
    await prepared();
    turnOn("campaign_0", "ad_2");
    const group = objects.get("ad_group_1")!;
    const r = await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad_group", object_id: group.id, status: "ACTIVE", expected_modified_at: group.modified_at }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "enabled", delivery_state: "unconfirmed", external_ids: { ad_group_id: "ad_group_1" } } });
    expect(mocks.ready).toHaveBeenCalledWith("tenant", "account", "pixel");
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "resume", object_id: "ad_group_1", daily_delta_usd: 10 }));
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.patch.mock.invocationCallOrder[0]);
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "ad_group_1", { configured_status: "ACTIVE" });
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }), "ad_group_1");
    expect(mocks.role).toHaveBeenCalledWith("founder", "tenant");
  });
  it("holds the ad's group budget when one ad is turned on, and refuses a resume the budget cannot hold", async () => {
    const ad = await prepared();
    turnOn("campaign_0", "ad_group_1");
    mocks.reserve.mockResolvedValueOnce({ status: "refused", error: "insufficient budget" });
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad", object_id: ad.id, status: "ACTIVE", expected_modified_at: ad.modified_at }))).toMatchObject({ ok: false, code: "reddit_ads_budget_refused" });
    expect(mocks.patch).not.toHaveBeenCalled();
    const r = await executeRedditAction({ ...card("reddit_ads.set_object_status", { level: "ad", object_id: ad.id, status: "ACTIVE", expected_modified_at: ad.modified_at }), id: "second_resume" });
    expect(r).toMatchObject({ ok: true });
    expect(mocks.reserve).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ op: "resume", object_id: "ad_group_1", daily_delta_usd: 10 }));
  });
  it("turns on a one-group campaign against that group's budget and refuses a multi-group campaign", async () => {
    await prepared();
    turnOn("ad_group_1", "ad_2");
    const campaign = objects.get("campaign_0")!;
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "campaign", object_id: campaign.id, status: "ACTIVE", expected_modified_at: campaign.modified_at }))).toMatchObject({ ok: true });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ object_id: "ad_group_1" }));
    objects.set("ad_group_9", { ...objects.get("ad_group_1")!, id: "ad_group_9" });
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "PAUSED", modified_at: "paused_again" });
    const r = await executeRedditAction({ ...card("reddit_ads.set_object_status", { level: "campaign", object_id: campaign.id, status: "ACTIVE", expected_modified_at: "paused_again" }), id: "multi_resume" });
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("one ad group at a time") });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("refuses to turn on anything whose parents are off: an ad under a paused group or campaign, a group under a paused campaign, a campaign with no group on", async () => {
    const ad = await prepared();
    const resume = (level: string, id: string) => executeRedditAction({ ...card("reddit_ads.set_object_status", { level, object_id: id, status: "ACTIVE", expected_modified_at: objects.get(id)!.modified_at }), id: `${level}_${id}_resume` });
    expect(await resume("ad", ad.id)).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("ad group is paused") });
    turnOn("ad_group_1");
    expect(await resume("ad", ad.id)).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("campaign is paused") });
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, configured_status: "PAUSED" });
    expect(await resume("ad_group", "ad_group_1")).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("campaign is paused") });
    expect(await resume("campaign", "campaign_0")).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("no ad group turned on") });
    turnOn("campaign_0");
    expect(await resume("ad_group", "ad_group_1")).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("no ad turned on") });
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "PAUSED" });
    turnOn("ad_group_1");
    expect(await resume("campaign", "campaign_0")).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("no ad turned on") });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("refuses to turn on an object that is already on, a member's resume, and a CGO resume", async () => {
    await prepared();
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, configured_status: "ACTIVE" });
    const group = objects.get("ad_group_1")!;
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad_group", object_id: group.id, status: "ACTIVE", expected_modified_at: group.modified_at }))).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("already on") });
    objects.set("ad_group_1", { ...group, configured_status: "PAUSED" });
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad_group", object_id: group.id, status: "ACTIVE", expected_modified_at: group.modified_at }))).toMatchObject({ ok: false, code: "reddit_ads_admin_required", held_for_founder: true });
    mocks.policy.mockResolvedValue({ verdict: "ask_founder", reasons: ["reddit_resume_needs_founder"] });
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad_group", object_id: group.id, status: "ACTIVE", expected_modified_at: group.modified_at }, "cgo"))).toMatchObject({ ok: false, code: "reddit_ads_policy_held", held_for_founder: true });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("keeps a resume hold when the patch outcome is unknown", async () => {
    await prepared();
    turnOn("campaign_0", "ad_2");
    const group = objects.get("ad_group_1")!;
    mocks.patch.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_outcome_unknown", "timeout"));
    expect(await executeRedditAction(card("reddit_ads.set_object_status", { level: "ad_group", object_id: group.id, status: "ACTIVE", expected_modified_at: group.modified_at }))).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});

describe("Reddit approver role (F1: spend-raising approvals are owner/admin only)", () => {
  const launchBody = { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" };
  const budget = (to: number) => ({ ad_account_id: "account", ad_group_id: "ad_group_1", name: "Change daily budget", rationale: "Approved change", expected_current_daily_budget_usd: 10, daily_budget_usd: to });
  it("refuses a member-approved launch before any reservation or write", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.role.mockResolvedValue("member");
    const r = await executeRedditAction(action("reddit_ads.launch_campaign", launchBody));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_admin_required", held_for_founder: true, outcome_unknown: false });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.role).toHaveBeenCalledWith("founder", "tenant");
  });
  it("refuses a member-approved budget raise and authority grant", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(action("reddit_ads.update_budget", budget(11)))).toMatchObject({ ok: false, code: "reddit_ads_admin_required" });
    const grant = { ad_account_id: "account", name: "Authority", rationale: "Grant", daily_limit_usd: 50, campaign_lifetime_limit_usd: 500, objectives: ["CLICKS"], geolocations: ["US"], expires_at: "2099-01-01T00:00:00.000Z", goal_id: "11111111-1111-4111-8111-111111111111" };
    expect(await executeRedditAction(action("reddit_ads.authorize_account", grant))).toMatchObject({ ok: false, code: "reddit_ads_admin_required" });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("refuses when the approver's role cannot be read", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.role.mockRejectedValue(new Error("db down"));
    expect(await executeRedditAction(action("reddit_ads.launch_campaign", launchBody))).toMatchObject({ ok: false });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("lets a member cut a budget or pause (the safe direction)", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(action("reddit_ads.update_budget", budget(5)))).toMatchObject({ ok: true });
    const pause = await executeRedditAction({ ...action("reddit_ads.set_object_status", { ad_account_id: "account", level: "ad_group", object_id: "ad_group_1", name: "Pause group", rationale: "Member request", status: "PAUSED", expected_modified_at: objects.get("ad_group_1")!.modified_at }), id: "pause_action" });
    expect(pause).toMatchObject({ ok: true });
  });
  it("lets an admin launch", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.role.mockResolvedValue("admin");
    expect(await executeRedditAction(action("reddit_ads.launch_campaign", launchBody))).toMatchObject({ ok: true });
  });
});
describe("Reddit launch verify after enablement (F2)", () => {
  it("keeps the reservation when the final read-back fails after every object was enabled", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.getPost.mockRejectedValue(new ExpectedToolError("reddit_ads_rate_limited", "Reddit Ads is limiting requests."));
    const r = await executeRedditAction(action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" }));
    expect(objects.get("campaign_0")?.configured_status).toBe("ACTIVE");
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
describe("Reddit preparation schedule, rejections and retained objects", () => {
  const prepare = (body: unknown = plan) => executeRedditAction(action("reddit_ads.prepare_campaign", body));
  const startTimeRejected = () => writeFailure(200, 'Error: 400 Client Error: Bad Request {"error": {"code": 400, "fields": [{"field": "start_time", "message": "must be a valid datetime"}]}}');
  const failNext = (level: string, error: Error) => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (a: unknown, id: string, l: string, data: Record<string, unknown>) => { if (l === level) throw error; return create(a, id, l, data); });
    return () => mocks.create.mockImplementation(create);
  };
  it("requires a timezone-explicit start_time", () => {
    expect(prepareSchema.safeParse({ ...plan, start_time: "2099-01-01T09:00:00" }).success).toBe(false);
    expect(prepareSchema.safeParse({ ...plan, start_time: "next monday" }).success).toBe(false);
    expect(prepareSchema.safeParse({ ...plan, start_time: "2099-01-01T17:00:00Z" }).success).toBe(true);
  });
  it("refuses a lifetime cap below Reddit's $100 minimum before creating anything", async () => {
    expect(prepareSchema.safeParse({ ...plan, lifetime_cap_usd: 99.99 }).error?.issues[0]?.message).toBe("Reddit requires a campaign lifetime cap of at least $100");
    expect(await prepare({ ...plan, lifetime_cap_usd: 10 })).toMatchObject({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("sends the approved start_time to the ad group and accepts Reddit's equivalent UTC form", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (a: unknown, id: string, level: string, data: Record<string, unknown>) => create(a, id, level, level === "ad_group" ? { ...data, start_time: "2099-01-01T17:00:00+00:00" } : data));
    expect(await prepare()).toMatchObject({ ok: true });
    expect(mocks.create).toHaveBeenCalledWith(account, "account", "ad_group", expect.objectContaining({ start_time: "2099-01-01T09:00:00-08:00" }));
    expect(mocks.create.mock.calls.find((c) => c[2] === "ad_group")?.[3]).not.toHaveProperty("view_through_conversion_type");
  });
  it("fails verification when Reddit saved a different start time", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (a: unknown, id: string, level: string, data: Record<string, unknown>) => create(a, id, level, level === "ad_group" ? { ...data, start_time: "2099-01-02T09:00:00-08:00" } : data));
    expect(await prepare()).toMatchObject({ ok: false, code: "reddit_ads_verification_failed", error: expect.stringContaining("start time") });
    expect(stores.get("tenant:operation_123")?.rows.get("manifest")).toBeUndefined();
  });
  it("fails verification when Reddit saved exclusions the plan did not approve", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (a: unknown, id: string, level: string, data: Record<string, unknown>) => create(a, id, level, level === "ad_group" ? { ...data, targeting: { ...(data.targeting as object), excluded_geolocations: ["GB"] } } : data));
    expect(await prepare()).toMatchObject({ ok: false, code: "reddit_ads_verification_failed", error: expect.stringContaining("targeting") });
    expect(stores.get("tenant:operation_123")?.rows.get("manifest")).toBeUndefined();
  });
  it("refuses a start time that has passed before creating anything", async () => {
    const r = await prepare({ ...plan, start_time: "2020-01-01T00:00:00Z" });
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("Nothing was created in Reddit.") });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("reconciles an uncertain ad group instead of calling it rejected once its start time has passed", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (a: unknown, id: string, level: string, data: Record<string, unknown>) => { const obj = await create(a, id, level, data); if (level === "ad_group") throw new ExpectedToolError("reddit_ads_outcome_unknown", "lost response"); return obj; });
    expect(await prepare()).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
    try {
      const r = await prepare();
      expect(r.code).not.toBe("reddit_ads_invalid_request");
      expect(stores.get("tenant:operation_123")?.rows.get("group")?.state).toBe("complete");
      expect([...objects.values()].filter((o) => o.test_level === "ad_group")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it("refuses an approval stored before start_time existed with a clear correction, before any Reddit call", async () => {
    const { start_time: _omit, ...legacy } = plan;
    const r = await prepare(legacy);
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("start_time"), execution_details: { next_recovery_step: expect.stringContaining("new operation key") } });
    expect(mocks.owned).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses to launch a campaign whose stored plan predates the schedule rule", async () => {
    await prepare();
    const row = stores.get("tenant:operation_123")!.rows.get("plan")!;
    const { start_time: _omit, ...legacy } = plan;
    stores.get("tenant:operation_123")!.rows.set("plan", { ...row, result: legacy });
    const r = await executeRedditAction(action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("new operation key") });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("reports a Reddit 400 after the campaign as a partial creation that needs the founder, not a temporary failure", async () => {
    failNext("ad_group", startTimeRejected());
    const r = await prepare();
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", outcome_unknown: false,
      execution_details: { execution_state: "failed", external_ids: { campaign: "campaign_0" }, failed_step: "group", next_recovery_step: expect.stringContaining("new operation key") } });
    expect(r.error).toBe("Reddit rejected the request: start_time: must be a valid datetime. Created before it stopped: campaign campaign_0. Failed step: ad group.");
    expect(verdictFor(r, "reddit_ads.prepare_campaign")).toMatchObject({ bucket: "needs_founder", note: null });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("lists every retained object and the failed step when the ad is rejected", async () => {
    failNext("ad", writeFailure(400, { error: { code: 400, fields: [{ field: "click_url", message: "Invalid value" }] } }));
    const r = await prepare();
    expect(r.error).toContain("Created before it stopped: campaign campaign_0, ad group ad_group_1, image post 1 post_0. Failed step: ad 1.");
    expect(r.execution_details).toMatchObject({ external_ids: { campaign: "campaign_0", group: "ad_group_1", post_0: "post_0" }, failed_step: "ad_0" });
  });
  it("resumes an unchanged retry from the retained paused campaign without a duplicate", async () => {
    const restore = failNext("ad_group", startTimeRejected());
    await prepare();
    restore();
    expect(await prepare()).toMatchObject({ ok: true, execution_details: { external_ids: { campaign_id: "campaign_0" } } });
    expect([...objects.values()].filter((o) => o.test_level === "campaign")).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledWith(account, "account", "campaign", "campaign_0");
  });
  it("never reuses or replaces a retained campaign that was archived in Reddit", async () => {
    const restore = failNext("ad_group", startTimeRejected());
    await prepare();
    restore();
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "ARCHIVED" });
    const r = await prepare();
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_retained_object_archived", error: expect.stringContaining("Campaign campaign_0 from this operation is archived"), execution_details: { next_recovery_step: expect.stringContaining("new operation key") } });
    expect(verdictFor(r, "reddit_ads.prepare_campaign")?.bucket).toBe("needs_founder");
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("verifies a new post by direct read even when the profile post list has not caught up", async () => {
    mocks.pages.mockImplementation(async (_a: unknown, slug: string) => slug === "LIST_POSTS" ? [] : [{ id: "profile" }]);
    expect(await prepare()).toMatchObject({ ok: true, execution_details: { execution_state: "created_paused" } });
    expect(mocks.getPost).toHaveBeenCalledWith(account, "post_0");
  });
  it("does not adopt an archived campaign while reconciling an unconfirmed create", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(async (a: unknown, id: string, level: string, data: Record<string, unknown>) => { await create(a, id, level, data); throw new ExpectedToolError("reddit_ads_outcome_unknown", "timeout"); });
    expect(await prepare()).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "ARCHIVED" });
    expect(await prepare()).toMatchObject({ ok: false, code: "reddit_ads_retained_object_archived" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("tells a rejected budget change to correct the request, not to use an operation key it does not have", async () => {
    await prepare();
    mocks.patch.mockRejectedValueOnce(writeFailure(400, { error: { code: 400, message: "goal_value is invalid" } }));
    const r = await executeRedditAction(action("reddit_ads.update_budget", { ad_account_id: "account", ad_group_id: "ad_group_1", name: "Raise daily budget", rationale: "Approved increase", expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", outcome_unknown: false });
    expect(r.execution_details.next_recovery_step).not.toContain("operation key");
    expect(mocks.drop).toHaveBeenCalled();
  });
});
describe("Reddit rename, archive and delete", () => {
  const prepared = async () => { await executeRedditAction(action("reddit_ads.prepare_campaign", plan)); };
  const card = (cls: string, body: Record<string, unknown>, source = "founder"): RedditExecRow => ({ ...action(cls, { ad_account_id: "account", name: "Edit", rationale: "Founder asked", ...body }, source), id: `${cls}_action` });
  it("renames a campaign and keeps Zavi's tag, so the prepared campaign is not lost", async () => {
    await prepared();
    const campaign = objects.get("campaign_0")!;
    const r = await executeRedditAction(card("reddit_ads.rename_object", { level: "campaign", object_id: campaign.id, expected_modified_at: campaign.modified_at, new_name: "Spring traffic" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "updated" } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "campaign", "campaign_0", { name: "Spring traffic [prax:operation_123:campaign]" });
  });
  it("archives only a paused object, and releases its budget holds", async () => {
    await prepared();
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "ACTIVE" });
    const live = objects.get("campaign_0")!;
    expect(await executeRedditAction(card("reddit_ads.remove_object", { level: "campaign", object_id: live.id, expected_modified_at: live.modified_at, mode: "archive" }))).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("Pause it first") });
    expect(mocks.patch).not.toHaveBeenCalled();
    objects.set("campaign_0", { ...live, configured_status: "PAUSED" });
    const r = await executeRedditAction(card("reddit_ads.remove_object", { level: "campaign", object_id: live.id, expected_modified_at: live.modified_at, mode: "archive" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "archived" } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "campaign", "campaign_0", { configured_status: "ARCHIVED" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("tenant", "reddit", "campaign_0");
    expect(mocks.release).toHaveBeenCalledWith("tenant", "reddit", "ad_group_1");
    expect(mocks.left).toHaveBeenCalledWith("tenant", "reddit", "ad_group_1");
    expect(r.notice).not.toContain("may still count");
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it("an archive whose budget hold release fails is never released blindly again, says so and raises an alert", async () => {
    await prepared();
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "PAUSED" });
    const live = objects.get("campaign_0")!;
    mocks.release.mockImplementation(async (_t: string, _p: string, id: string) => id !== "ad_group_1");
    const r = await executeRedditAction(card("reddit_ads.remove_object", { level: "campaign", object_id: live.id, expected_modified_at: live.modified_at, mode: "archive" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "archived", external_ids: { budget_hold: "release_unconfirmed" } } });
    expect(r.notice).toContain("may still count against your ad budget");
    expect(mocks.release.mock.calls.filter((c) => c[2] === "ad_group_1")).toHaveLength(1);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "reddit_ads.hold_release_unconfirmed", tenant_id: "tenant" }));
  });
  it("re-reads a failed hold read-back without releasing again, and a hold still left is flagged", async () => {
    await prepared();
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "PAUSED" });
    const live = objects.get("campaign_0")!;
    mocks.left.mockResolvedValueOnce(null).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = await executeRedditAction(card("reddit_ads.remove_object", { level: "campaign", object_id: live.id, expected_modified_at: live.modified_at, mode: "archive" }));
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.left).toHaveBeenCalledTimes(3);
    expect(r.notice).toContain("may still count");
  });
  it("a delete whose ad group list cannot be read still reports the delete, and flags the hold", async () => {
    await prepared();
    objects.set("campaign_0", { ...objects.get("campaign_0")!, configured_status: "ARCHIVED" });
    const live = objects.get("campaign_0")!;
    mocks.list.mockRejectedValue(new Error("Reddit 503"));
    const r = await executeRedditAction(card("reddit_ads.remove_object", { level: "campaign", object_id: live.id, expected_modified_at: live.modified_at, mode: "delete" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "deleted" } });
    expect(r.notice).toContain("may still count");
    expect(mocks.log).toHaveBeenCalled();
  });
  it("deletes only an archived object", async () => {
    await prepared();
    const ad = objects.get("ad_2")!;
    expect(await executeRedditAction(card("reddit_ads.remove_object", { level: "ad", object_id: ad.id, expected_modified_at: ad.modified_at, mode: "delete" }))).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("Archive it first") });
    objects.set("ad_2", { ...ad, configured_status: "ARCHIVED" });
    const r = await executeRedditAction(card("reddit_ads.remove_object", { level: "ad", object_id: ad.id, expected_modified_at: ad.modified_at, mode: "delete" }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "deleted" } });
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad", "ad_2", { configured_status: "DELETED" });
  });
  it("never lets Autopilot rename, archive or delete, and needs an owner or admin to archive", async () => {
    await prepared();
    const campaign = objects.get("campaign_0")!;
    const body = { level: "campaign", object_id: campaign.id, expected_modified_at: campaign.modified_at, mode: "archive" };
    expect(await executeRedditAction(card("reddit_ads.remove_object", body, "cgo"))).toMatchObject({ ok: false, held_for_founder: true });
    expect(await executeRedditAction(card("reddit_ads.rename_object", { level: "campaign", object_id: campaign.id, expected_modified_at: campaign.modified_at, new_name: "New name" }, "cgo"))).toMatchObject({ ok: false, held_for_founder: true });
    mocks.role.mockResolvedValue("member");
    expect(await executeRedditAction(card("reddit_ads.remove_object", body))).toMatchObject({ ok: false, code: "reddit_ads_admin_required" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("refuses a stale snapshot before any write", async () => {
    await prepared();
    const r = await executeRedditAction(card("reddit_ads.rename_object", { level: "ad_group", object_id: "ad_group_1", expected_modified_at: "stale", new_name: "New name" }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_object_drifted" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
describe("an approved edit on a prepared campaign keeps it launchable", () => {
  const launch = () => executeRedditAction(action("reddit_ads.launch_campaign", { ad_account_id: "account", operation_key: plan.operation_key, name: plan.name, rationale: "Launch approved test" }));
  const card = (cls: string, body: Record<string, unknown>): RedditExecRow => ({ ...action(cls, { ad_account_id: "account", name: "Edit", rationale: "Approved edit", ...body }), id: `${cls}_action` });
  it("a budget change is carried into the plan, and the launch reserves the new budget", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const r = await executeRedditAction(card("reddit_ads.update_budget", { ad_group_id: "ad_group_1", expected_current_daily_budget_usd: 10, daily_budget_usd: 12 }));
    expect(r).toMatchObject({ ok: true, notice: expect.stringContaining("now carries this change") });
    mocks.reserve.mockClear();
    expect(await launch()).toMatchObject({ ok: true, execution_details: { execution_state: "enabled" } });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ object_id: "ad_group_1", daily_delta_usd: 12 }));
  });
  it("a tracking link change is kept in the plan beside the post's own link, and the launch checks both", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const ad = objects.get("ad_2")!;
    const r = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }));
    expect(r).toMatchObject({ ok: true, notice: expect.stringContaining("now carries this change") });
    const saved = (stores.get("tenant:operation_123")!.rows.get("manifest")!.result as { plan: typeof plan }).plan.creatives[0];
    expect(saved).toMatchObject({ destination_url: "https://example.com/trips", click_url: "https://example.com/trips?utm_source=reddit" });
    expect(await launch()).toMatchObject({ ok: true });
  });
  it("a targeting change and a rename keep it launchable", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const group = objects.get("ad_group_1")!;
    await executeRedditAction(card("reddit_ads.update_targeting", { ad_group_id: group.id, expected_modified_at: group.modified_at, targeting: { geolocations: ["US", "CA"] } }));
    const campaign = objects.get("campaign_0")!;
    expect(await executeRedditAction(card("reddit_ads.rename_object", { level: "campaign", object_id: campaign.id, expected_modified_at: campaign.modified_at, new_name: "Spring traffic" }))).toMatchObject({ ok: true, notice: expect.stringContaining("now carries this change") });
    expect(await launch()).toMatchObject({ ok: true });
  });
  it("refuses a budget that would break the prepared plan before anything is written", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    mocks.patch.mockClear(); mocks.reserve.mockClear();
    const r = await executeRedditAction(card("reddit_ads.update_budget", { ad_group_id: "ad_group_1", expected_current_daily_budget_usd: 10, daily_budget_usd: 150 }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("Nothing was changed in Reddit") });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("an ad group already on is held to its live limits, not the prepared plan", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, configured_status: "ACTIVE" });
    const r = await executeRedditAction(card("reddit_ads.update_budget", { ad_group_id: "ad_group_1", expected_current_daily_budget_usd: 10, daily_budget_usd: 150 }));
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "updated" } });
    expect(r.notice).not.toContain("prepared campaign");
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "ad_group_1", { goal_value: 150000000 });
  });
  it("an edit on an object whose status is not paused or on changes nothing and reserves nothing", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, configured_status: undefined });
    mocks.patch.mockClear(); mocks.reserve.mockClear();
    const r = await executeRedditAction(card("reddit_ads.update_budget", { ad_group_id: "ad_group_1", expected_current_daily_budget_usd: 10, daily_budget_usd: 150 }));
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_invalid_request", error: expect.stringContaining("unreadable") });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("says why when the ad's image post cannot be read for a reason a retry will not fix", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    const ad = objects.get("ad_2")!;
    mocks.getPost.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_permission_denied", "403", { status: 403 }));
    const denied = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }));
    expect(denied).toMatchObject({ ok: false, code: "reddit_ads_post_unreadable", error: expect.stringContaining("refused Zavi permission") });
    expect(denied.error).not.toContain("in a minute");
    mocks.getPost.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_rate_limited", "slow", { status: 429 }));
    const slow = await executeRedditAction(card("reddit_ads.update_ad", { ad_id: ad.id, expected_modified_at: ad.modified_at, destination_url: "https://example.com/trips?utm_source=reddit" }));
    expect(slow.error).toContain("in a minute");
  });
  it("a launch whose live budget is not the plan's reserves nothing and turns nothing on", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    objects.set("ad_group_1", { ...objects.get("ad_group_1")!, goal_value: 20000000 });
    mocks.patch.mockClear(); mocks.reserve.mockClear();
    expect(await launch()).toMatchObject({ ok: false, code: "reddit_ads_object_drifted" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("the launch reads the plan saved with the manifest, never an older plan row", async () => {
    await executeRedditAction(action("reddit_ads.prepare_campaign", plan));
    await executeRedditAction(card("reddit_ads.update_budget", { ad_group_id: "ad_group_1", expected_current_daily_budget_usd: 10, daily_budget_usd: 12 }));
    const store = stores.get("tenant:operation_123")!;
    store.rows.set("plan", { ...store.rows.get("plan")!, result: plan });
    mocks.reserve.mockClear();
    expect(await launch()).toMatchObject({ ok: true });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ daily_delta_usd: 12 }));
  });
});
