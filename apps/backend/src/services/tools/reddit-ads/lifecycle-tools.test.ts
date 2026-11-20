import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), reconcile: vi.fn(), send: vi.fn(), owned: vi.fn() }));
vi.mock("@/services/connectors/reddit-ads/adapter", async (original) => ({ ...await original<typeof import("@/services/connectors/reddit-ads/adapter")>(), ownedAccount: mocks.owned }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: mocks.from }) }));
vi.mock("@/services/connectors/reddit-ads/reconcile", () => ({ reconcileRedditOperation: mocks.reconcile }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));
const room = vi.hoisted(() => ({ budget: null as null | Record<string, unknown>, recorded: [] as Array<Record<string, unknown>>, prepared: vi.fn(), rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/connectors/reddit-ads/lifecycle", () => ({ preparedCampaign: (...a: unknown[]) => room.prepared(...a) }));
vi.mock("@/services/decisions/ad-budget", async (orig) => ({ ...await orig<typeof import("@/services/decisions/ad-budget")>(), readActiveAdBudget: async () => room.budget }));
const images = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/services/connectors/reddit-ads/creative-images", () => ({ checkCreativeImage: (...a: unknown[]) => images.resolve(...a) }));
vi.mock("@/services/growth/pending-tests", async (orig) => ({ ...await orig<typeof import("@/services/growth/pending-tests")>(), readPendingTests: async () => room.rows, recordPendingTest: async (_t: string, t: Record<string, unknown>) => (room.recorded.push(t), { status: "recorded", expires_at: "2026-10-18T00:00:00.000Z" }) }));
import { redditLifecycleTools } from "./lifecycle-tools";
import type { ToolSpec } from "@/services/tools/types";
const ctx = { tenant_id: "tenant" } as Parameters<ToolSpec["execute"]>[0];
const input = { ad_account_id: "account", operation_key: "operation_123" };
const read = () => redditLifecycleTools.find((t) => t.name === "reddit_ads_read_operation")!.execute(ctx, input);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset(); mocks.owned.mockResolvedValue({ account: {} });
  const initial = { select: () => initial, eq: () => initial, order: () => initial, limit: async () => ({ data: [{ action_id: "launch", state: "unknown" }, { action_id: "prepare", state: "complete" }], error: null }) };
  const progress = { select: () => progress, eq: () => progress, order: async () => ({ data: [{ step: "enable_ad", state: "complete", result: { id: "ad" } }], error: null }) };
  mocks.from.mockReturnValueOnce(initial).mockReturnValueOnce(progress);
  mocks.reconcile.mockResolvedValue({ ids: { campaign: "campaign", group: "group", enable_ad: "ad" }, unresolved: false });
  mocks.send.mockResolvedValue({ ids: ["event"] });
});
describe("Reddit operation recovery tool", () => {
  it("reconciles and requeues the interrupted launch rather than the original preparation", async () => {
    expect(await read()).toMatchObject({ action_id: "launch", execution_state: "reconciled", external_ids: { group: "group" }, failure_reason: null });
    expect(mocks.reconcile).toHaveBeenCalledWith("tenant", "operation_123", "launch", "account", undefined);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ name: "channel-action.exec-reconcile", data: { action_id: "launch" } }));
  });
  it("retains unresolved outcomes without queuing a successful settlement", async () => {
    mocks.reconcile.mockResolvedValue({ ids: { campaign: "campaign" }, unresolved: true });
    expect(await read()).toMatchObject({ execution_state: "outcome_unknown", next_recovery_step: expect.stringContaining("Review missing or ambiguous") });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("returns recovered IDs and a concrete retry step when settlement cannot be queued", async () => {
    mocks.send.mockRejectedValue(new Error("worker unavailable"));
    expect(await read()).toMatchObject({ external_ids: { group: "group" }, failure_reason: expect.stringContaining("could not be queued"), next_recovery_step: expect.stringContaining("Read this operation again") });
  });
  it("keeps a rejected plan's correction instead of offering an unchanged retry", async () => {
    const progress = { select: () => progress, eq: () => progress, order: async () => ({ data: [{ step: "campaign", state: "complete", result: { id: "campaign" } }, { step: "group", state: "failed", result: { error: "Reddit rejected the request: start_time: must be a valid datetime.", code: "reddit_ads_invalid_request" } }], error: null }) };
    const initial = { select: () => initial, eq: () => initial, order: () => initial, limit: async () => ({ data: [{ action_id: "prepare", state: "failed" }], error: null }) };
    mocks.from.mockReset().mockReturnValueOnce(initial).mockReturnValueOnce(progress);
    mocks.reconcile.mockResolvedValue({ ids: { campaign: "campaign" }, unresolved: false });
    const r = await read();
    expect(r).toMatchObject({ execution_state: "failed", failed_step: "group", failure_reason: expect.stringContaining("start_time: must be a valid datetime"), next_recovery_step: expect.stringContaining("new operation key") });
    expect(JSON.stringify(r)).not.toContain("same operation key");
  });
  it("offers a same-key retry only for a failure that is not a plan rejection", async () => {
    const progress = { select: () => progress, eq: () => progress, order: async () => ({ data: [{ step: "group", state: "failed", result: { error: "denied", code: "reddit_ads_permission_denied" } }], error: null }) };
    const initial = { select: () => initial, eq: () => initial, order: () => initial, limit: async () => ({ data: [{ action_id: "prepare", state: "failed" }], error: null }) };
    mocks.from.mockReset().mockReturnValueOnce(initial).mockReturnValueOnce(progress);
    expect(await read()).toMatchObject({ execution_state: "failed", next_recovery_step: expect.stringContaining("approve the original action again") });
  });
});

describe("B1: a Reddit launch the shared ad budget cannot hold is kept as a pending test", () => {
  const launch = (c: Record<string, unknown>) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign")!.execute({ tenant_id: "tenant", ...c } as never, { ad_account_id: "account", operation_key: "operation_123", name: "Spring test", rationale: "first readable test" });
  beforeEach(() => {
    room.recorded = [];
    room.rows = [];
    room.prepared.mockResolvedValue({ plan: { daily_budget_usd: 30, ad_account_id: "account" }, manifest: { group: { id: "g1" } } });
  });

  it("short: refused before any card, the prepared ad group's daily budget kept as a pending test", async () => {
    room.budget = { left_usd: 200, days_left: 21, margin: 1 };
    const emit = vi.fn();
    const err = (await launch({ emit_decision: emit }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toMatchObject({ code: "reddit_ads_budget_short" });
    expect(err.message).toContain("holds $630.00 for the rest of the month");
    expect(err.message).toContain("pending Reddit test");
    expect(emit).not.toHaveBeenCalled();
    expect(room.recorded).toEqual([expect.objectContaining({ channel: "reddit_ads", daily_budget_usd: 30, hold_usd: 630, proposal: expect.objectContaining({ operation_key: "operation_123" }) })]);
  });

  it("room enough, or no active budget: the card files as before (the executor's hold is still the gate)", async () => {
    const rows = { select: () => rows, eq: () => rows, maybeSingle: async () => ({ data: { exec_status: null, exec_result: null, approved_by_source: null }, error: null }) };
    for (const setup of [() => (room.budget = { left_usd: 5000, days_left: 21, margin: 1 }), () => (room.budget = null)]) {
      setup();
      mocks.from.mockReset().mockReturnValue(rows);
      const emit = vi.fn(async () => "card-1");
      expect(await launch({ emit_decision: emit })).toMatchObject({ action_id: "card-1" });
    }
    expect(room.recorded).toEqual([]);
  });
});

it("F7: origin is the server's: a model-written founder origin is filed as specialist; a founder's own command keeps the human origin", async () => {
  room.budget = null;
  room.rows = [];
  room.prepared.mockResolvedValue({ plan: { daily_budget_usd: 30, ad_account_id: "account" }, manifest: { group: { id: "g1" } } });
  const rows = { select: () => rows, eq: () => rows, maybeSingle: async () => ({ data: { exec_status: null, exec_result: null, approved_by_source: null }, error: null }) };
  mocks.from.mockReset().mockReturnValue(rows);
  const input = { ad_account_id: "account", operation_key: "operation_123", name: "Spring test", rationale: "first readable test", origin: "user_initiated_ledger" };
  const tool = redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign")!;
  const emit = vi.fn(async (_c: string, _b: unknown) => "card-1");
  await tool.execute({ tenant_id: "tenant", emit_decision: emit, run_trigger: "a2a" } as never, input);
  expect((emit.mock.calls[0][1] as { origin: string }).origin).toBe("specialist");
  const emit2 = vi.fn(async (_c: string, _b: unknown) => "card-2");
  await tool.execute({ tenant_id: "tenant", emit_decision: emit2, run_trigger: "chat", top_action_run: true } as never, input);
  expect((emit2.mock.calls[0][1] as { origin: string }).origin).toBe("user_initiated_chat");
});

it("G-F1: room enough but a Reddit test is already waiting: refused, no card", async () => {
  room.budget = { left_usd: 5000, days_left: 21, margin: 1 };
  room.rows = [{ id: "p1", channel_slug: "reddit_ads", status: "claimed", action_id: "card-0", expires_at: "2099-01-01T00:00:00.000Z" }];
  room.prepared.mockResolvedValue({ plan: { daily_budget_usd: 30, ad_account_id: "account" }, manifest: { group: { id: "g1" } } });
  const emit = vi.fn();
  await expect(redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, { ad_account_id: "account", operation_key: "operation_123", name: "Spring test", rationale: "first readable test" })).rejects.toMatchObject({ code: "reddit_ads_test_waiting" });
  expect(emit).not.toHaveBeenCalled();
});

it("3: no active budget (or an unreadable plan) and a Reddit test already waiting: refused, no card", async () => {
  room.rows = [{ id: "p1", channel_slug: "reddit_ads", status: "pending", action_id: null, expires_at: "2099-01-01T00:00:00.000Z" }];
  const launch = (emit: () => unknown) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, { ad_account_id: "account", operation_key: "operation_123", name: "Spring test", rationale: "first readable test" });
  room.budget = null;
  room.prepared.mockResolvedValue({ plan: { daily_budget_usd: 30, ad_account_id: "account" }, manifest: { group: { id: "g1" } } });
  const emit = vi.fn();
  await expect(launch(emit)).rejects.toMatchObject({ code: "reddit_ads_test_waiting" });
  expect(emit).not.toHaveBeenCalled();
  room.rows = [];
});

describe("a launch turns on a PREPARED campaign: nothing prepared is refused before any card", () => {
  const launch = (emit: () => unknown) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_launch_campaign")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, { ad_account_id: "account", operation_key: "operation_123", name: "Spring test", rationale: "first readable test" });
  beforeEach(() => {
    room.rows = [];
    room.budget = null;
  });

  it("preparation not finished (or never approved): refused, typed, with the fix to propose the preparation first", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    room.prepared.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_prepare_incomplete", "Campaign preparation is incomplete."));
    const emit = vi.fn();
    const err = (await launch(emit).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toMatchObject({ code: "reddit_ads_prepare_incomplete" });
    expect(err.message).toContain("propose the preparation first");
    expect(emit).not.toHaveBeenCalled();
  });

  it("the prepared plan cannot be read: refused (try again), never filed on a guess", async () => {
    room.prepared.mockRejectedValueOnce(new Error("db down"));
    const emit = vi.fn();
    await expect(launch(emit)).rejects.toMatchObject({ code: "reddit_ads_prepare_unreadable" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a campaign prepared on another ad account: refused", async () => {
    room.prepared.mockResolvedValueOnce({ plan: { daily_budget_usd: 30, ad_account_id: "other" }, manifest: { group: { id: "g1" } } });
    const emit = vi.fn();
    await expect(launch(emit)).rejects.toMatchObject({ code: "reddit_ads_account_not_owned" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("authorize: one open card per account, and only for an active goal", () => {
  const GOAL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const grant = { ad_account_id: "account", name: "Reddit operating limits", rationale: "first test", daily_limit_usd: 25, campaign_lifetime_limit_usd: 300, objectives: ["CLICKS"], geolocations: ["US"], expires_at: "2099-01-01T00:00:00.000Z", goal_id: GOAL };
  const authorize = (emit: () => unknown) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_authorize_account")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, grant);
  let cards: Array<Record<string, unknown>>;
  let goal: Record<string, unknown> | null;
  beforeEach(() => {
    cards = [];
    goal = { id: GOAL, status: "active" };
    mocks.from.mockReset().mockImplementation((table: string) => {
      const q: Record<string, unknown> = {};
      Object.assign(q, { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q });
      if (table === "channel_actions") Object.assign(q, { then: (res: (v: unknown) => unknown) => Promise.resolve({ data: cards, error: null }).then(res), maybeSingle: async () => ({ data: { exec_status: null, exec_result: null, approved_by_source: null }, error: null }) });
      if (table === "autopilot_goals") Object.assign(q, { maybeSingle: async () => ({ data: goal, error: null }) });
      return q;
    });
  });

  it("files the first card", async () => {
    const emit = vi.fn(async () => "card-1");
    expect(await authorize(emit)).toMatchObject({ action_id: "card-1" });
    expect(emit).toHaveBeenCalledWith("reddit_ads.authorize_account", expect.objectContaining({ ad_account_id: "account", goal_id: GOAL }));
  });

  it("an authorization card for this account is still open: returns it, files nothing (another account's does not count)", async () => {
    cards = [
      { id: "card-other", status: "pending", exec_status: null, exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "other" } },
      { id: "card-open", status: "pending", exec_status: null, exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "account" } },
    ];
    const emit = vi.fn(async () => "card-2");
    expect(await authorize(emit)).toMatchObject({ action_id: "card-open", already_open: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("two runs raced past the check: the unique open-card index refuses the second insert, and the tool returns the card that won", async () => {
    const emit = vi.fn(async () => {
      cards = [{ id: "card-winner", status: "pending", exec_status: null, exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "account" } }];
      throw new Error('record_channel_exec_action failed: duplicate key value violates unique constraint "channel_actions_one_open_reddit_authorize"');
    });
    expect(await authorize(emit)).toMatchObject({ action_id: "card-winner", already_open: true });
  });

  it("a card whose last attempt FAILED is still pending (the index covers it): returned with re-approve or reject, never a dead end", async () => {
    cards = [{ id: "card-failed", status: "pending", exec_status: "failed", exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "account" } }];
    const emit = vi.fn(async () => "card-new");
    const r = (await authorize(emit)) as Record<string, unknown>;
    expect(r).toMatchObject({ action_id: "card-failed", already_open: true, execution_state: "failed" });
    expect(String(r.next_recovery_step)).toContain("approve that card again or reject it");
    expect(emit).not.toHaveBeenCalled();
  });

  it("the race when the winner is a failed-but-pending card: the unique violation returns it too", async () => {
    const emit = vi.fn(async () => {
      cards = [{ id: "card-failed", status: "pending", exec_status: "failed", exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "account" } }];
      throw new Error('duplicate key value violates unique constraint "channel_actions_one_open_reddit_authorize"');
    });
    expect(await authorize(emit)).toMatchObject({ action_id: "card-failed", already_open: true });
  });

  it("a snoozed card is approvable, so it counts as the open card", async () => {
    cards = [{ id: "card-snoozed", status: "snoozed", exec_status: null, exec_class: "reddit_ads.authorize_account", exec_payload: { ad_account_id: "account" } }];
    const emit = vi.fn();
    expect(await authorize(emit)).toMatchObject({ action_id: "card-snoozed", already_open: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a card write that fails for another reason, with no open card, still fails", async () => {
    const emit = vi.fn(async () => { throw new Error("db down"); });
    await expect(authorize(emit)).rejects.toThrow("db down");
  });

  it("a goal that is not active in this workspace: refused with the fix", async () => {
    goal = { id: GOAL, status: "met" };
    const emit = vi.fn();
    await expect(authorize(emit)).rejects.toMatchObject({ code: "reddit_ads_goal_invalid" });
    goal = null;
    await expect(authorize(emit)).rejects.toMatchObject({ code: "reddit_ads_goal_invalid" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("open cards cannot be read: refused, never a second card on a guess", async () => {
    mocks.from.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      Object.assign(q, { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "down" } }).then(res) });
      return q;
    });
    const emit = vi.fn();
    await expect(authorize(emit)).rejects.toMatchObject({ code: "reddit_ads_cards_unreadable" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("prepare: each image ad's picture is a Zavi image or a public link, checked before the card", () => {
  const plan = (creative: Record<string, unknown>) => ({
    ad_account_id: "account", name: "Spring test", rationale: "first test", operation_key: "operation_123", profile_id: "profile", pixel_id: "pixel", objective: "CLICKS",
    daily_budget_usd: 25, lifetime_cap_usd: 300, start_time: "2099-01-01T00:00:00Z", targeting: { geolocations: ["US"] },
    creatives: [{ name: "Ad one", headline: "A headline", destination_url: "https://shop.example.com", ...creative }],
  });
  const prepare = (emit: (c: string, b: unknown) => unknown, creative: Record<string, unknown>) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_prepare_campaign")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, plan(creative));
  beforeEach(() => {
    const rows = { select: () => rows, eq: () => rows, maybeSingle: async () => ({ data: { exec_status: null, exec_result: null, approved_by_source: null }, error: null }) };
    mocks.from.mockReset().mockReturnValue(rows);
    images.resolve.mockReset().mockResolvedValue(undefined);
  });

  it("an image_artifact_id is checked as this tenant's and filed as the id: the card carries no link", async () => {
    const emit = vi.fn(async () => "card-1");
    await prepare(emit, { image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });
    expect(images.resolve).toHaveBeenCalledWith("tenant", expect.objectContaining({ image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" }));
    const body = (emit.mock.calls[0] as unknown[])[1] as { creatives: Array<Record<string, unknown>> };
    expect(body.creatives[0]).toEqual({ name: "Ad one", headline: "A headline", destination_url: "https://shop.example.com", allow_comments: false, image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });
  });

  it("both or neither picture: refused by the schema before any check or card", async () => {
    const emit = vi.fn();
    await expect(prepare(emit, {})).rejects.toThrow();
    await expect(prepare(emit, { image_url: "https://cdn.example.com/a.jpg", image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" })).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a picture that cannot be used: the resolver's typed refusal, no card", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    images.resolve.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_image_unusable", "No JPG or PNG image"));
    const emit = vi.fn();
    await expect(prepare(emit, { image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" })).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("replace_creative: the new ad's picture is checked before the card, and the card carries the server origin", () => {
  const replacement = (creative: Record<string, unknown>) => ({
    ad_account_id: "account", name: "Spring test", rationale: "creative test", operation_key: "replacement_123", ad_group_id: "group", profile_id: "profile",
    creative: { name: "Ad two", headline: "Another headline", destination_url: "https://shop.example.com", ...creative },
  });
  const propose = (emit: (c: string, b: unknown) => unknown, creative: Record<string, unknown>) => redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_replace_creative")!.execute({ tenant_id: "tenant", emit_decision: emit } as never, replacement(creative));
  beforeEach(() => {
    const rows = { select: () => rows, eq: () => rows, maybeSingle: async () => ({ data: { exec_status: null, exec_result: null, approved_by_source: null }, error: null }) };
    mocks.from.mockReset().mockReturnValue(rows);
    images.resolve.mockReset().mockResolvedValue(undefined);
  });

  it("files the card with the checked picture and a specialist origin", async () => {
    const emit = vi.fn(async () => "card-2");
    const r = await propose(emit, { image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });
    expect(images.resolve).toHaveBeenCalledWith("tenant", expect.objectContaining({ image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" }));
    expect(emit).toHaveBeenCalledWith("reddit_ads.replace_creative", expect.objectContaining({ origin: "specialist", ad_group_id: "group", creative: expect.objectContaining({ headline: "Another headline", allow_comments: false }) }));
    expect(r).toMatchObject({ action_id: "card-2", approval_required: true });
  });

  it("a picture that cannot be used: no card", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    images.resolve.mockRejectedValueOnce(new ExpectedToolError("reddit_ads_image_unusable", "No JPG or PNG image"));
    const emit = vi.fn();
    await expect(propose(emit, { image_url: "https://cdn.example.com/a.jpg" })).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("the edit and resume proposals exist, and a resume body is typed PAUSED or ACTIVE only", async () => {
    const names = redditLifecycleTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["reddit_ads_propose_update_targeting", "reddit_ads_propose_update_ad", "reddit_ads_propose_replace_creative", "reddit_ads_propose_set_object_status"]));
    const status = redditLifecycleTools.find((t) => t.name === "reddit_ads_propose_set_object_status")!;
    const body = { ad_account_id: "account", name: "Group", rationale: "On again", level: "ad_group", object_id: "group", expected_modified_at: "snapshot" };
    expect(status.input_schema.safeParse({ ...body, status: "ACTIVE" }).success).toBe(true);
    expect(status.input_schema.safeParse({ ...body, status: "ARCHIVED" }).success).toBe(false);
  });
});
