
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { labChannelCards, labRedoOf, setLabCardStoreStatus, checkLabCardStore, stagedFromProposals } from "../lab-cards";
import type { recordChannelRunActions } from "@/services/channels/channel-actions";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const RUN = "00000000-0000-4000-8000-000000000001";
const SRC = "8aa9ed42-bf07-4d17-8350-8b2971b304c1";

const step = (title: string) => ({
  title,
  body: `do ${title}`,
  blocking: false,
  effort: "minutes",
  evidence: ["e"],
  how_to: ["one", "two"],
});
const envelope = { rendered_markdown: "analysis", steps: [step("Raise budget"), step("Fix pixel")] };

const row = (id: string, title: string, run_id: string, status = "pending") => ({
  id,
  title,
  run_id,
  status,
  channel_slug: "meta_ads",
  position: 1,
  run_of: 1,
  blocking: false,
  action_type: "campaign_change",
  body: { step: step(title) },
  note: null,
  snoozed_until: null,
  impact: 3,
  impact_reason: null,
  score: 0,
  score_inputs: null,
  proposed_at: "2026-10-01T00:00:00Z",
  repeat_of: null,
  redo_of: null,
  exec_status: null,
  title_key: title.toLowerCase(),
  exec_class: null,
  exec_payload: null,
});

function fakeSb(open: { before: unknown[]; after: unknown[] }, fail: Record<string, string> = {}) {
  const calls: string[] = [];
  let opens = 0;
  const sb = {
    rpc: vi.fn(async (name: string) => {
      calls.push(name);
      if (fail[name]) return { data: null, error: { message: fail[name] } };
      if (name === "lab_open_channel_actions") return { data: opens++ === 0 ? open.before : open.after, error: null };
      if (name === "lab_card_seed") return { data: { cards: open.before.length, metrics: 0 }, error: null };
      if (name === "lab_record_channel_run_actions") return { data: { inserted: 1, ids: [] }, error: null };
      return { data: null, error: null };
    }),
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const ctx = async () => ({ channel_in_plan: true, goal_metric_keys: new Set<string>(), rejected_title_keys: new Set<string>(), rejected_ids: new Set<string>() });

beforeEach(() => setLabCardStoreStatus({ ok: true, problems: [] }));

describe("labChannelCards", () => {
  it("runs the real writer against the lab copy and returns the ranked panel, new cards marked", async () => {
    const before = [row("old-1", "Old card", SRC), row("old-2", "Pause ad set", SRC)];
    const after = [row("old-2", "Pause ad set", SRC), row("new-1", "Raise budget", RUN)];
    const { sb, calls } = fakeSb({ before, after });
    let seen: Parameters<typeof recordChannelRunActions>[1] | undefined;
    const record = vi.fn(async (_a: unknown, deps: Parameters<typeof recordChannelRunActions>[1]) => {
      seen = deps;
      await deps!.rpc!(T as never, "record_channel_run_actions", { p_run_id: RUN, p_actions: [], p_metrics: [], p_stale: [] });
      return {} as never;
    }) as unknown as typeof recordChannelRunActions;

    const out = await labChannelCards(
      sb,
      { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope },
      { record, loadScoreContext: ctx },
    );

    expect(out.ok ? "ok" : out.reason).toBe("ok");
    if (!out.ok) return;
    expect(out.value.store).toBe("channel_actions");
    expect(out.value.cards.map((c) => [c.title, c.new])).toEqual(
      expect.arrayContaining([
        ["Raise budget", true],
        ["Pause ad set", false],
      ]),
    );
    expect(out.value.retired).toEqual(["Old card"]);
    expect(out.value.open_before).toBe(2);
    expect(calls).toEqual([
      "lab_card_seed",
      "lab_open_channel_actions",
      "lab_record_channel_run_actions",
      "lab_open_channel_actions",
      "lab_card_clear",
    ]);
    expect(await seen!.displace!(T as never, "meta_ads", RUN, null)).toBe(0);
    expect(seen!.siteBuilder).toBeUndefined();
    expect(out.value.writer).toMatchObject({ inserted: 0, kept: 0, metrics_dropped: 0 });
    expect(out.value.displaced).toEqual([]);
  });

  it("reports what the real writer said: filed, kept, coerced, metrics dropped", async () => {
    const { sb } = fakeSb({ before: [], after: [row("new-1", "Raise budget", RUN)] });
    const record = vi.fn(async () => ({
      inserted: 1, metrics: 2, metrics_dropped: 3, stale_accepted: 1, stale_dropped: 0, coerced: 1,
      ids: [{ position: 1, id: "new-1" }], kept: [{ position: 2, id: "x" }], redone: false, displaced: 0,
    })) as unknown as typeof recordChannelRunActions;
    const out = await labChannelCards(sb, { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope }, { record, loadScoreContext: ctx });
    expect(out.ok && out.value.writer).toEqual({ inserted: 1, kept: 1, coerced: 1, metrics: 2, metrics_dropped: 3, stale_accepted: 1, stale_dropped: 0 });
  });

  it("a redo run replaces one card: the writer gets the redo target and the old card leaves the lab panel", async () => {
    const before = [row("old-1", "Old card", SRC)];
    const after = [row("old-1", "Old card", SRC), row("new-1", "Raise budget", RUN)];
    const { sb } = fakeSb({ before, after });
    let got: unknown;
    const record = vi.fn(async (a: { redo: unknown }) => {
      got = a.redo;
      return {} as never;
    }) as unknown as typeof recordChannelRunActions;
    const out = await labChannelCards(
      sb,
      { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope, payload: { redo: { redo_of_action_id: "old-1", note: "shorter" } } },
      { record, loadScoreContext: ctx },
    );
    expect(got).toEqual({ redo_of_action_id: "old-1", origin_position: null, origin_of: null, note: "shorter" });
    expect(out.ok && out.value.cards.map((c) => c.title)).toEqual(["Raise budget"]);
    expect(out.ok && out.value.retired).toEqual(["Old card"]);
  });

  it("labRedoOf reads only a well-formed redo target", () => {
    expect(labRedoOf({ redo: { redo_of_action_id: "a", origin_position: 2, origin_of: 5 } })).toEqual({ redo_of_action_id: "a", origin_position: 2, origin_of: 5, note: null });
    expect(labRedoOf({ redo: { redo_of_decision_id: "legacy" } })).toBeNull();
    expect(labRedoOf({})).toBeNull();
    expect(labRedoOf(null)).toBeNull();
  });

  it("any other RPC the writer makes is answered with an error and never sent", async () => {
    const { sb, calls } = fakeSb({ before: [], after: [] });
    let other: { error: { message: string } | null } | undefined;
    const record = vi.fn(async (_a: unknown, deps: Parameters<typeof recordChannelRunActions>[1]) => {
      other = (await deps!.rpc!(T as never, "mark_channel_action_redone", {})) as never;
      await deps!.rpc!(T as never, "enqueue_ops_alert", {});
      return {} as never;
    }) as unknown as typeof recordChannelRunActions;
    await labChannelCards(sb, { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope }, { record, loadScoreContext: ctx });
    expect(other?.error?.message).toMatch(/not run/);
    expect(calls).not.toContain("mark_channel_action_redone");
    expect(calls).not.toContain("enqueue_ops_alert");
  });

  it("clears the lab even when the writer throws, and says why", async () => {
    const { sb, calls } = fakeSb({ before: [], after: [] });
    const record = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof recordChannelRunActions;
    const out = await labChannelCards(sb, { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope }, { record, loadScoreContext: ctx });
    expect(out).toEqual({ ok: false, reason: "lab card step failed: boom" });
    expect(calls.at(-1)).toBe("lab_card_clear");
  });

  it("refuses the card step while the lab copy does not match prod", async () => {
    setLabCardStoreStatus({ ok: false, problems: ["channel_actions columns differ: new_col"] });
    const { sb, calls } = fakeSb({ before: [], after: [] });
    const out = await labChannelCards(sb, { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC, envelope });
    expect(out).toEqual({ ok: false, reason: "lab_store_out_of_date: channel_actions columns differ: new_col" });
    expect(calls).toEqual([]);
  });

  it("a run with no steps, or an envelope that fails the schema, has no cards and says why", async () => {
    const { sb } = fakeSb({ before: [], after: [] });
    const args = { tenantId: T, channelSlug: "meta_ads", runId: RUN, sourceRunId: SRC };
    expect(await labChannelCards(sb, { ...args, envelope: { rendered_markdown: "x", steps: [] } })).toEqual({ ok: false, reason: "no_steps" });
    const bad = await labChannelCards(sb, { ...args, envelope: { steps: "nope" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/^schema_invalid: /);
  });

  it("a channel on the legacy decisions store shows its step cards, with no lab writes", async () => {
    const { sb, calls } = fakeSb({ before: [], after: [] });
    const out = await labChannelCards(sb, { tenantId: T, channelSlug: "not_a_channel", runId: RUN, sourceRunId: SRC, envelope });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.store).toBe("decisions");
      expect(out.value.cards.map((c) => c.title)).toEqual(["Raise budget", "Fix pixel"]);
      expect(out.value.cards[0]).toMatchObject({ body: "do Raise budget", how_to: ["one", "two"] });
    }
    expect(calls).toEqual([]);
  });
});

describe("checkLabCardStore", () => {
  it("is ready only on ok with no problems; a failed call is not ready", async () => {
    const sb = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;
    expect(await checkLabCardStore(sb({ ok: true, problems: [] }))).toEqual({ ok: true, problems: [] });
    expect(await checkLabCardStore(sb({ ok: false, problems: ["x"] }))).toEqual({ ok: false, problems: ["x"] });
    expect((await checkLabCardStore(sb(null, { message: "function lab_card_parity does not exist" }))).ok).toBe(false);
  });
});

describe("stagedFromProposals", () => {
  it("a blocked post proposal is the run's staged post; other blocked writes are not", () => {
    expect(
      stagedFromProposals([
        { tool: "social__propose_post", input: '{"channel":"x_image","text":"  Launch day  ","image_path":"a.png"}' },
        { tool: "meta_ads__update_adset_budget", input: '{"channel":"x","text":"no"}' },
      ]),
    ).toEqual([{ channel: "x_image", text: "Launch day" }]);
  });

  it("a preview cut mid-JSON still yields the channel and the opening words", () => {
    expect(stagedFromProposals([{ tool: "social__propose_post", input: '{"channel":"x_video","text":"Watch us build it in 60 sec' }])).toEqual([
      { channel: "x_video", text: "Watch us build it in 60 sec" },
    ]);
  });
});
