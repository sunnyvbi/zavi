import { describe, expect, it, vi } from "vitest";
import { recordChannelExecAction } from "../exec-actions";
import { cgoApproveChannelAction } from "@/services/growth/cgo-ads";
import type { MatchPool, PoolCard } from "../card-matcher";

vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: vi.fn(async () => false) }));

const PAYLOAD = { campaign_id: "123", level: "campaign", status: "PAUSED", rationale: "r", over_cap: false };

function fakeRpc() {
  return vi.fn(async () => ({ data: { ok: true, id: "act-1", replayed: false }, error: null }));
}

describe("recordChannelExecAction card presentation", () => {
  it("adds kind, labels and steps OUTSIDE exec_payload; exec_payload is byte-identical", async () => {
    const rpc = fakeRpc();
    await recordChannelExecAction(
      {
        tenantId: "t-1",
        runId: "r-1",
        execClass: "google_ads.set_status",
        execPayload: PAYLOAD,
        actionType: "pause_ad",
        title: "Pause campaign 123",
        body: { step: { title: "Pause", body: "b" }, exact_change: { rows: [] } },
      },
      rpc as never,
    );
    const args = (rpc.mock.calls[0] as unknown[])[2] as { p_action: Record<string, unknown> };
    expect(args.p_action.exec_payload).toBe(PAYLOAD);
    expect(args.p_action.exec_payload).toEqual({ campaign_id: "123", level: "campaign", status: "PAUSED", rationale: "r", over_cap: false });
    expect(args.p_action).toMatchObject({ card_kind: "executes", primary_label: "Pause", done_label: "Done" });
    expect((args.p_action.how_to as string[])[1]).toBe("Press Pause. Zavi makes the change in Google Ads.");
    expect(args.p_action.body).toMatchObject({ intent: "improve", owner: "zavi" });
    expect(args.p_action).not.toHaveProperty("intent");
    expect(args.p_action).not.toHaveProperty("owner");
  });

  it("a budget change keeps the specific label", async () => {
    const rpc = fakeRpc();
    await recordChannelExecAction(
      {
        tenantId: "t-1",
        runId: "r-1",
        execClass: "meta_ads.update_budget",
        execPayload: { ad_set_id: "9", daily_budget: 20 },
        actionType: "update_ad",
        title: "Raise budget",
        body: { step: { title: "Raise" }, exact_change: { rows: [{ item: "Daily budget", before: "$10", after: "$20" }] } },
      },
      rpc as never,
    );
    const args = (rpc.mock.calls[0] as unknown[])[2] as { p_action: Record<string, unknown> };
    expect(args.p_action.primary_label).toBe("Adjust budget");
  });

  it("records what the card is about on the card body, never on exec_payload", async () => {
    const rpc = fakeRpc();
    const payload = { object_id: "120259468814150059", level: "campaign", name: "40% to Turo", status: "PAUSED" };
    await recordChannelExecAction(
      {
        tenantId: "t-1",
        runId: "r-1",
        execClass: "meta_ads.set_status",
        execPayload: payload,
        actionType: "pause_ad",
        title: "Pause “40% to Turo”",
        body: { step: { title: "Pause", body: "b" }, exact_change: { rows: [] } },
      },
      rpc as never,
    );
    const args = (rpc.mock.calls[0] as unknown[])[2] as { p_action: Record<string, unknown> };
    expect(args.p_action.exec_payload).toBe(payload);
    expect((args.p_action.body as Record<string, unknown>).subject_refs).toEqual({ ids: ["120259468814150059"], names: ["40% to Turo"] });
  });
});

describe("recordChannelExecAction layered dedupe", () => {
  const BUDGET = { campaign_id: "1", daily_budget_usd: 80, expected_current_daily_budget_usd: 50, over_cap: false, rationale: "r", name: "Upcar Search" };
  const input = {
    tenantId: "t-1",
    runId: "r-1",
    channelSlug: "google_ads",
    execClass: "google_ads.update_campaign_budget",
    execPayload: BUDGET,
    actionType: "update_ad" as const,
    title: "Raise Upcar Search to $80/day",
    body: { step: { title: "Raise", body: "Spend is capped" }, exact_change: { rows: [] } },
  };
  const OPEN: PoolCard = { id: "11111111-1111-4111-8111-111111111111", channel: "google_ads", status: "open", title: "Raise Upcar Search to $70/day", summary: "", target: { kind: "campaign", ref: "upcar search" } };
  const OTHER: PoolCard = { id: "22222222-2222-4222-8222-222222222222", channel: "google_ads", status: "open", title: "Pause Brand", summary: "", target: { kind: "campaign", ref: "brand" } };
  const pool = (cards: PoolCard[]): MatchPool => [...cards];
  const verdict = (decision: string, match_id: string | null, changed = false) => ({
    verdicts: [{ ref: "n0", decision, match_id, changed, reason: "" }],
    input_tokens: 10,
    output_tokens: 2,
  });
  const ok = (extra: Record<string, unknown> = {}) => ({ data: { ok: true, id: "new-1", replayed: false, ...extra }, error: null });
  const rematch = { data: { ok: false, code: "rematch" }, error: null };
  const pAction = (rpc: { mock: { calls: ReadonlyArray<readonly unknown[]> } }, i = 0) => (rpc.mock.calls[i][2] as { p_action: Record<string, unknown> }).p_action;
  const quiet = { log: vi.fn(async () => undefined) as never };

  it("sends the target key, the matcher's repeat_of and the ids of the pool it judged", async () => {
    vi.mocked(cgoApproveChannelAction).mockClear();
    const rpc = vi.fn(async () => ok());
    const loadPool = vi.fn(async () => pool([OPEN, OTHER]));
    const match = vi.fn(async () => verdict("same_open", OPEN.id));
    await recordChannelExecAction(input, rpc as never, { loadPool, match: match as never, enabled: () => true, ...quiet });
    expect(loadPool).toHaveBeenCalledWith("t-1", "google_ads", expect.any(Number), ["campaign:upcar search"]);
    expect(pAction(rpc)).toMatchObject({ target_key: "campaign:upcar search", repeat_of: OPEN.id, judged_ids: [OPEN.id, OTHER.id] });
    expect(pAction(rpc).exec_payload).toBe(BUDGET);
    expect(cgoApproveChannelAction).toHaveBeenCalledWith("t-1", "new-1");
  });

  it("re-matches once on a fresh pool after a rematch", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(rematch).mockResolvedValueOnce(ok());
    const loadPool = vi.fn().mockResolvedValueOnce(pool([])).mockResolvedValueOnce(pool([OPEN]));
    const match = vi.fn(async () => verdict("same_open", OPEN.id));
    const alertExhausted = vi.fn(async () => undefined);
    const out = await recordChannelExecAction(input, rpc as never, { loadPool, match: match as never, enabled: () => true, alertExhausted, ...quiet });
    expect(out).toEqual({ id: "new-1", replayed: false });
    expect(loadPool).toHaveBeenCalledTimes(2);
    expect(pAction(rpc, 0)).toMatchObject({ judged_ids: [], repeat_of: null });
    expect(pAction(rpc, 1)).toMatchObject({ judged_ids: [OPEN.id], repeat_of: OPEN.id });
    expect(alertExhausted).not.toHaveBeenCalled();
  });

  it("after two rematches files it unjudged, with one alert keyed to the run and target", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(rematch).mockResolvedValueOnce(rematch).mockResolvedValueOnce(ok());
    const loadPool = vi.fn(async () => pool([OPEN]));
    const match = vi.fn(async () => verdict("same_open", OPEN.id));
    const alertExhausted = vi.fn(async () => undefined);
    const out = await recordChannelExecAction(input, rpc as never, { loadPool, match: match as never, enabled: () => true, alertExhausted, ...quiet });
    expect(out.id).toBe("new-1");
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(match).toHaveBeenCalledTimes(2);
    expect(pAction(rpc, 2)).toMatchObject({ judged_ids: null, repeat_of: null, target_key: "campaign:upcar search" });
    expect(alertExhausted).toHaveBeenCalledTimes(1);
    expect(alertExhausted).toHaveBeenCalledWith({ tenantId: "t-1", runId: "r-1", channelSlug: "google_ads", scope: "exec", targetKey: "campaign:upcar search" }, { rpc });
  });

  it("kept: the founder's card is returned, nothing new is approved", async () => {
    vi.mocked(cgoApproveChannelAction).mockClear();
    const rpc = vi.fn(async () => ({ data: { ok: true, id: OPEN.id, replayed: false, kept: true }, error: null }));
    const out = await recordChannelExecAction(input, rpc as never, { loadPool: vi.fn(async () => pool([])), enabled: () => true, ...quiet });
    expect(out).toEqual({ id: OPEN.id, replayed: false, kept: true });
    expect(cgoApproveChannelAction).not.toHaveBeenCalled();
  });

  it("already rejected and nothing changed: not filed, and the tool is told why", async () => {
    const rpc = vi.fn(async () => ok());
    const rejected: PoolCard = { ...OPEN, status: "rejected" };
    await expect(
      recordChannelExecAction(input, rpc as never, { loadPool: vi.fn(async () => pool([rejected])), match: vi.fn(async () => verdict("already_rejected", OPEN.id)) as never, enabled: () => true, ...quiet }),
    ).rejects.toMatchObject({ code: "channel_card_already_rejected" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("matcher off: no pool read, no model call, no snapshot, no repeat_of", async () => {
    const rpc = vi.fn(async () => ok());
    const loadPool = vi.fn();
    const match = vi.fn();
    await recordChannelExecAction(input, rpc as never, { loadPool: loadPool as never, match: match as never, enabled: () => false, ...quiet });
    expect(loadPool).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    expect(pAction(rpc)).toMatchObject({ judged_ids: null, repeat_of: null });
  });

  it("fails open: a failed pool read or a failed judge sends no snapshot", async () => {
    const failedPool = Object.assign([] as PoolCard[], { readFailed: true as const });
    const rpc1 = vi.fn(async () => ok());
    await recordChannelExecAction(input, rpc1 as never, { loadPool: vi.fn(async () => failedPool), enabled: () => true, ...quiet });
    expect(pAction(rpc1)).toMatchObject({ judged_ids: null, repeat_of: null });
    const rpc2 = vi.fn(async () => ok());
    await recordChannelExecAction(input, rpc2 as never, { loadPool: vi.fn(async () => pool([OPEN])), match: vi.fn(async () => null) as never, enabled: () => true, ...quiet });
    expect(pAction(rpc2)).toMatchObject({ judged_ids: null, repeat_of: null });
  });

  it("no candidate: no model call, but the pool is still the snapshot", async () => {
    const rpc = vi.fn(async () => ok());
    const match = vi.fn();
    await recordChannelExecAction(input, rpc as never, { loadPool: vi.fn(async () => pool([OTHER])), match: match as never, enabled: () => true, ...quiet });
    expect(match).not.toHaveBeenCalled();
    expect(pAction(rpc)).toMatchObject({ judged_ids: [OTHER.id], repeat_of: null });
  });

  it("no channel on the input: read from the run; unreadable skips the matcher", async () => {
    const rpc = vi.fn(async () => ok());
    const loadPool = vi.fn(async () => pool([]));
    const { channelSlug: _c, ...noChannel } = input;
    void _c;
    await recordChannelExecAction(noChannel, rpc as never, { loadPool, enabled: () => true, runChannel: async () => "youtube_ads", ...quiet });
    expect(loadPool).toHaveBeenCalledWith("t-1", "youtube_ads", expect.any(Number), ["campaign:upcar search"]);
    loadPool.mockClear();
    await recordChannelExecAction(noChannel, rpc as never, { loadPool, enabled: () => true, runChannel: async () => null, ...quiet });
    expect(loadPool).not.toHaveBeenCalled();
  });
});
