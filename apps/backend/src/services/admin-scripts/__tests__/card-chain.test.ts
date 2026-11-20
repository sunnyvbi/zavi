import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ opsRpc: vi.fn(), tenantRpc: vi.fn(), tenantClient: vi.fn(), asTenantId: (t: string) => t }));
vi.mock("../runs", () => ({ listRecent: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { opsRpc, tenantRpc } from "@/services/tenant-client";
import { listRecent } from "../runs";
import {
  CHANNEL_PAGE,
  chainConfirmPhrase,
  chainRepeat,
  chainResumeCursor,
  chainResumeState,
  derivedTargetKey,
  isUntouched,
  layer1Pairs,
  listOpenChannels,
  previewCardChain,
  runCardChain,
  stampTargetKeys,
  type ChainDeps,
  type ChainProgress,
  type OpenCardRow,
  type OpenChannel,
} from "../card-chain";
import { getScript } from "../registry";

const T = "00000000-0000-4000-8000-00000000000a";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const at = (min: number) => new Date(NOW - (100 - min) * 60_000).toISOString();

const card = (n: number, over: Partial<OpenCardRow> = {}): OpenCardRow => ({
  id: id(n),
  run_id: `run-${n}`,
  status: "pending",
  action_type: "fix",
  title: `Card ${n}`,
  title_key: "same title",
  exec_class: null,
  exec_payload: null,
  exec_status: null,
  exec_result: null,
  edited_body: null,
  steps_done: [],
  snoozed_until: null,
  target_key: "page:/pricing",
  step_target: null,
  summary: "s",
  proposed_at: at(n),
  ...over,
});
const budget = (n: number, usd: number, over: Partial<OpenCardRow> = {}): OpenCardRow =>
  card(n, {
    action_type: "update_ad",
    exec_class: "google_ads.update_campaign_budget",
    exec_payload: { campaign_id: "1", daily_budget_usd: usd, rationale: `r${n}`, name: "Upcar Search" },
    target_key: null,
    title_key: `budget ${usd}`,
    ...over,
  });

const CH: OpenChannel = { tenant_id: T, channel_slug: "google_ads", open_count: 0, keyless_count: 0 };

function deps(rows: OpenCardRow[], over: Partial<ChainDeps> = {}): ChainDeps & { progressed: unknown[] } {
  const progressed: unknown[] = [];
  return {
    progressed,
    listChannels: vi.fn(async (after: ChainProgress["cursor"]) => (after ? [] : [CH])),
    loadOpen: vi.fn(async () => rows),
    stamp: vi.fn(async (_t: string, pairs: Array<{ id: string; target_key: string }>) => pairs.length),
    chain: vi.fn(async () => ({ ok: true, replayed: false, chained: true })),
    match: vi.fn() as unknown as ChainDeps["match"],
    progress: vi.fn(async (p: ChainProgress) => {
      progressed.push(p);
    }),
    log: vi.fn() as never,
    now: () => NOW,
    ...over,
  };
}

describe("planning", () => {
  it("derives the key a writer would stamp: exec from the payload, prose from step.target", () => {
    expect(derivedTargetKey(budget(1, 50))).toBe("campaign:upcar search");
    expect(derivedTargetKey(card(1, { target_key: null, step_target: { kind: "page", ref: "https://x.com/Pricing/" } }))).toBe("page:/pricing");
    expect(derivedTargetKey(card(1, { target_key: null, step_target: { kind: "queue", ref: "all" } }))).toBeNull();
  });

  it("Layer 1: exec twins on one object form one chain A -> B -> C, oldest link first; no model involved", () => {
    expect(layer1Pairs([budget(3, 70), budget(1, 50), budget(2, 60)], NOW)).toEqual([
      { old_id: id(1), new_id: id(2), layer: 1 },
      { old_id: id(2), new_id: id(3), layer: 1 },
    ]);
    expect(layer1Pairs([budget(1, 50), budget(2, 60, { edited_body: { x: 1 } }), budget(3, 70)], NOW)).toEqual([
      { old_id: id(1), new_id: id(2), layer: 1 },
    ]);
  });

  it("a name-only payload is NOT a Layer-1 pair", () => {
    const nameOnly = (n: number) => card(n, { exec_class: "google_ads.create_campaign", action_type: "create_ad", exec_payload: { name: "Same" }, target_key: "campaign:same" });
    expect(layer1Pairs([nameOnly(1), nameOnly(2)], NOW)).toEqual([]);
  });

  it("prose twins: same target, type and title of different runs; same run, other title or touched are not paired", () => {
    expect(layer1Pairs([card(1), card(2)], NOW)).toEqual([{ old_id: id(1), new_id: id(2), layer: 1 }]);
    expect(layer1Pairs([card(1), card(2, { run_id: "run-1" })], NOW)).toEqual([]);
    expect(layer1Pairs([card(1), card(2, { title_key: "other" })], NOW)).toEqual([]);
    expect(layer1Pairs([card(1, { steps_done: [0] }), card(2)], NOW)).toEqual([]);
  });

  it("the untouched mirror refuses edited, ticked, future-snoozed, in-flight and partial-risk cards", () => {
    expect(isUntouched(card(1), NOW)).toBe(true);
    expect(isUntouched(card(1, { status: "snoozed", snoozed_until: at(200) }), NOW)).toBe(false);
    expect(isUntouched(card(1, { status: "snoozed", snoozed_until: at(1) }), NOW)).toBe(true);
    expect(isUntouched(card(1, { edited_body: { a: 1 } }), NOW)).toBe(false);
    expect(isUntouched(card(1, { exec_status: "queued" }), NOW)).toBe(false);
    expect(isUntouched(card(1, { exec_status: "failed", exec_result: { error: "x" } }), NOW)).toBe(true);
    expect(isUntouched(card(1, { exec_status: "failed", exec_result: { code: "exec_partial" } }), NOW)).toBe(false);
    expect(isUntouched(card(1, { exec_status: "failed", exec_result: { bucket: "partial_risk" } }), NOW)).toBe(false);
  });
});

describe("runCardChain", () => {
  it("stamps missing keys, chains Layer-1 pairs with no model call, persists progress per channel", async () => {
    const d = deps([budget(1, 50), budget(2, 60), card(3)]);
    const out = await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, d);
    expect(d.stamp).toHaveBeenCalledWith(T, [
      { id: id(1), target_key: "campaign:upcar search" },
      { id: id(2), target_key: "campaign:upcar search" },
    ]);
    expect(d.chain).toHaveBeenCalledWith(T, id(1), id(2));
    expect(d.match).not.toHaveBeenCalled();
    expect(out).toMatchObject({ complete: true, channels: 1, keys_stamped: 2, chained: 1, refused: 0, model_calls: 0, cursor: { tenant: T, channel: "google_ads" } });
    expect(d.progressed.length).toBeGreaterThanOrEqual(1);
  });

  it("Layer 2 runs only with use_matcher, and counts model calls and tokens", async () => {
    const rows = [card(1, { title_key: "a" }), card(2, { title_key: "b" })];
    const match = vi.fn(async () => ({ verdicts: [{ ref: "n0", decision: "same_open" as const, match_id: id(1), changed: false, reason: "" }], input_tokens: 900, output_tokens: 40 }));
    const off = deps(rows, { match });
    await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, off);
    expect(match).not.toHaveBeenCalled();
    const on = deps(rows, { match });
    const out = await runCardChain({ cursor: null, useMatcher: true, maxChannels: 500 }, on);
    expect(match).toHaveBeenCalledTimes(1);
    expect(on.chain).toHaveBeenCalledWith(T, id(1), id(2));
    expect(out).toMatchObject({ model_calls: 1, input_tokens: 900, output_tokens: 40, chained: 1 });
  });

  it("resumes at the cursor and stops at max_channels with complete false", async () => {
    const chs = [1, 2, 3].map((n) => ({ ...CH, channel_slug: `c${n}` }));
    const listChannels = vi.fn(async (after: { tenant: string; channel: string } | null) => chs.filter((c) => !after || c.channel_slug > after.channel));
    const d = deps([], { listChannels });
    const out = await runCardChain({ cursor: { tenant: T, channel: "c1" }, useMatcher: false, maxChannels: 1 }, d);
    expect(listChannels).toHaveBeenCalledWith({ tenant: T, channel: "c1" }, CHANNEL_PAGE);
    expect(out).toMatchObject({ complete: false, channels: 1, cursor: { tenant: T, channel: "c2" } });
  });

  it("a retirement whose new card already points elsewhere is counted unlinked, not chained", async () => {
    const chain = vi.fn().mockResolvedValueOnce({ ok: true, replayed: false, chained: false }).mockResolvedValueOnce({ ok: true, replayed: true });
    const out = await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, deps([card(1), card(2), card(3)], { chain }));
    expect(out).toMatchObject({ chained: 0, unlinked: 1, refused: 0 });
  });

  it("a channel read short of its open count is truncated, recorded, and never reported complete", async () => {
    const d = deps([card(1)], { listChannels: vi.fn(async (after: ChainProgress["cursor"]) => (after ? [] : [{ ...CH, open_count: 5 }])) });
    const out = await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, d);
    expect(out).toMatchObject({ truncated: 1, complete: false, failed_count: 1 });
    expect(out.errors[0].code).toMatch(/truncated: read 1 of 5/);
    const prev = await previewCardChain({ useMatcher: false }, d);
    expect(prev.truncated).toBe(1);
  });

  it("a resumed run carries the truncated count and cannot report complete", async () => {
    const out = await runCardChain({ cursor: { tenant: T, channel: "z" }, truncated: 1, useMatcher: false, maxChannels: 500 }, deps([], { listChannels: vi.fn(async () => []) }));
    expect(out).toMatchObject({ complete: false, truncated: 1 });
    vi.mocked(listRecent).mockResolvedValueOnce([{ status: "succeeded", progress: { complete: false, truncated: 2, cursor: { tenant: T, channel: "x" } } }] as never);
    expect(await chainResumeState()).toEqual({ cursor: { tenant: T, channel: "x" }, truncated: 2 });
  });

  it("the breaker trips on the 20th failing pair inside one channel; a success in between resets it", async () => {
    let n = 0;
    const many = Array.from({ length: 30 }, (_, i) => card(i + 1));
    const chain = vi.fn(async () => {
      n++;
      throw new Error("rpc down");
    });
    await expect(runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, deps(many, { chain }))).rejects.toThrow(/20 errors in a row/);
    expect(n).toBe(20);
    let k = 0;
    const flaky = vi.fn(async () => {
      k++;
      if (k % 10 === 0) return { ok: true, replayed: false, chained: true };
      throw new Error("blip");
    });
    const out = await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, deps(many, { chain: flaky }));
    expect(out).toMatchObject({ chained: 2, failed_count: 27 });
  });

  it("pair failures count toward the 20-in-a-row breaker", async () => {
    const chs = Array.from({ length: 25 }, (_, n) => ({ ...CH, channel_slug: `c${String(n).padStart(2, "0")}` }));
    const d = deps([card(1), card(2)], {
      listChannels: vi.fn(async (after: ChainProgress["cursor"]) => (after ? [] : chs)),
      chain: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, d)).rejects.toThrow(/20 errors in a row/);
  });

  it("records errors and refusals, keeps going, and fails after 20 errors in a row with progress kept", async () => {
    const chain = vi.fn().mockResolvedValueOnce({ ok: false, code: "touched" }).mockRejectedValueOnce(new Error("rpc down"));
    const d = deps([card(1), card(2), card(3)], { chain });
    const out = await runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, d);
    expect(out).toMatchObject({ refused: 1, failed_count: 1 });
    expect(out.errors[0]).toMatchObject({ code: "rpc down" });

    const chs = Array.from({ length: 25 }, (_, n) => ({ ...CH, channel_slug: `c${String(n).padStart(2, "0")}` }));
    const bad = deps([], { listChannels: vi.fn(async (after: ChainProgress["cursor"]) => (after ? [] : chs)), loadOpen: vi.fn(async () => { throw new Error("read failed"); }) });
    await expect(runCardChain({ cursor: null, useMatcher: false, maxChannels: 500 }, bad)).rejects.toThrow(/20 errors in a row/);
    const last = bad.progressed.at(-1) as { failed_count: number; cursor: { channel: string } };
    expect(last.failed_count).toBe(20);
    expect(last.cursor.channel).toBe("c18");
  });
});

describe("previewCardChain + doors + registry", () => {
  it("the dry run counts keys missing and Layer-1 pairs, estimates model calls, changes nothing; the token tracks the rows", async () => {
    const d = deps([budget(1, 50), budget(2, 60), card(3, { title_key: "x" }), card(4, { title_key: "y" })]);
    const p = await previewCardChain({ useMatcher: true }, d);
    expect(p).toMatchObject({ channels: 1, keys_missing: 2, pairs: 1, model_calls_estimate: 1 });
    expect(chainConfirmPhrase(p, true)).toBe("CHAIN 1 JUDGE 1");
    expect(chainConfirmPhrase(p, false)).toBe("CHAIN 1");
    const otherCandidates = await previewCardChain({ useMatcher: true }, deps([budget(1, 50), budget(2, 60), card(3, { title_key: "x" }), card(6, { title_key: "y" })]));
    expect(otherCandidates.preview_token).not.toBe(p.preview_token);
    expect(d.stamp).not.toHaveBeenCalled();
    expect(d.chain).not.toHaveBeenCalled();
    const again = await previewCardChain({ useMatcher: true }, deps([budget(1, 50), budget(5, 60)]));
    expect(again.preview_token).not.toBe(p.preview_token);
    const done = await previewCardChain({ useMatcher: false }, deps([card(1, { title_key: "a" }), budget(2, 60, { target_key: "campaign:upcar search" })]));
    expect(done).toMatchObject({ keys_missing: 0, pairs: 0 });
  });

  it("doors: list via opsRpc, stamp and chain via tenantRpc with the tenant injected", async () => {
    vi.mocked(opsRpc).mockResolvedValueOnce({ data: [CH], error: null } as never);
    expect(await listOpenChannels({ tenant: T, channel: "a" }, 10)).toEqual([CH]);
    expect(opsRpc).toHaveBeenCalledWith("list_open_card_channels", { p_after_tenant: T, p_after_channel: "a", p_limit: 10 });
    vi.mocked(tenantRpc).mockResolvedValueOnce({ data: 3, error: null } as never);
    expect(await stampTargetKeys(T, [{ id: id(1), target_key: "k" }])).toBe(3);
    expect(tenantRpc).toHaveBeenLastCalledWith(T, "stamp_channel_action_target_keys", { p_pairs: [{ id: id(1), target_key: "k" }] });
    vi.mocked(tenantRpc).mockResolvedValueOnce({ data: { ok: false, code: "touched" }, error: null } as never);
    expect(await chainRepeat(T, id(1), id(2))).toEqual({ ok: false, code: "touched" });
    vi.mocked(tenantRpc).mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    await expect(chainRepeat(T, id(1), id(2))).rejects.toThrow(/boom/);
  });

  it("resume cursor: from a failed or unfinished run only", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce([{ status: "succeeded", progress: { complete: true, cursor: { tenant: T, channel: "x" } } }] as never);
    expect(await chainResumeCursor()).toBeNull();
    vi.mocked(listRecent).mockResolvedValueOnce([{ status: "succeeded", progress: { complete: false, cursor: { tenant: T, channel: "x" } } }] as never);
    expect(await chainResumeCursor()).toEqual({ tenant: T, channel: "x" });
    vi.mocked(listRecent).mockResolvedValueOnce([{ status: "failed", progress: { cursor: { tenant: "not-a-uuid", channel: "x" } } }] as never);
    expect(await chainResumeCursor()).toBeNull();
  });

  it("is registered: Channel cards group, one run at a time, CHAIN <pairs>, sane defaults", () => {
    const s = getScript("channel-card-chain")!;
    expect(s).toMatchObject({ group: "Channel cards", applies: true, longRunning: true, confirmHint: "CHAIN <pairs> (with the matcher: CHAIN <pairs> JUDGE <targets>)" });
    expect(s.lockKey({})).toBe("*");
    expect(s.schema.parse({})).toEqual({ use_matcher: false, max_channels: 500, resume: false });
    expect(s.schema.parse({ use_matcher: "true", max_channels: "20", resume: "on" })).toEqual({ use_matcher: true, max_channels: 20, resume: true });
  });
});
