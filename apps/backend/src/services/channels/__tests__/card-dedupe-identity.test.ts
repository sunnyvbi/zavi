import { beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.fn(async (_e: Record<string, unknown>) => undefined);
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: Record<string, unknown>) => logEvent(e) }));

type Q = { table: string; ops: Array<[string, unknown[]]> };
const queries: Q[] = [];
let rowsFor: (q: Q) => { data: unknown[]; error: { message: string } | null } = () => ({ data: [], error: null });
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: (table: string) => {
      const q: Q = { table, ops: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "gte", "order", "limit"]) {
        chain[op] = (...a: unknown[]) => {
          q.ops.push([op, a]);
          return op === "limit" ? Promise.resolve(rowsFor(q)) : chain;
        };
      }
      return chain;
    },
  }),
}));

import { execCardTarget, execFamily, execLayer1Keys, execSubject, targetKeyOf } from "../exec-card-identity";
import { hasMatchCandidates, loadMatchPool, matchRunCards, normalizeRef, targetFromKey, POOL_MAX, TARGET_POOL_MAX } from "../card-matcher";
import { alertRematchExhausted, rematchDedupeKey } from "../card-rematch";

beforeEach(() => {
  queries.length = 0;
  logEvent.mockClear();
  rowsFor = () => ({ data: [], error: null });
});

describe("execCardTarget: what an executable card touches", () => {
  it.each([
    ["google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 50, name: "Upcar Search" }, { kind: "campaign", ref: "Upcar Search" }],
    ["google_ads.set_status_review", { campaign_id: "1", level: "campaign", status: "PAUSED", name: "Upcar Search" }, { kind: "campaign", ref: "Upcar Search" }],
    ["google_ads.set_status", { campaign_id: "1", level: "ad_group", ad_group_id: "22", status: "PAUSED", name: "Bay Area" }, { kind: "ad_set", ref: "Bay Area" }],
    ["google_ads.set_status", { campaign_id: "1", level: "ad", ad_group_id: "22", ad_id: "333", status: "PAUSED" }, { kind: "ad", ref: "333" }],
    ["google_ads.create_campaign", { name: "YT Bay Area", channel_type: "DEMAND_GEN" }, { kind: "campaign", ref: "YT Bay Area" }],
    ["google_ads.create_ad_group", { campaign_id: "1", name: "Group A" }, { kind: "ad_set", ref: "Group A" }],
    ["google_ads.create_ad", { ad_group_id: "22", ad: { kind: "responsive_search" } }, { kind: "ad_set", ref: "22" }],
    ["google_ads.add_keywords", { level: "campaign", campaign_id: "1", negative: true, keywords: [], name: "Upcar Search" }, { kind: "campaign", ref: "Upcar Search" }],
    ["google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "22", criterion_id: "9", keyword_text: "car rental" }, { kind: "keyword", ref: "car rental" }],
    ["meta_ads.update_ad_set_budget", { ad_set_id: "777", daily_budget_usd: 20 }, { kind: "ad_set", ref: "777" }],
    ["meta_ads.set_status", { object_id: "555", level: "adset", status: "PAUSED", name: "Retarget" }, { kind: "ad_set", ref: "Retarget" }],
    ["meta_ads.set_status", { object_id: "555", level: "campaign", status: "PAUSED", name: "40% to Turo" }, { kind: "campaign", ref: "40% to Turo" }],
    ["meta_ads.create_ad_set", { campaign_id: "1", name: "Lookalike 1%" }, { kind: "ad_set", ref: "Lookalike 1%" }],
    ["google_ads.update_conversion", { conversion_action_name: "sign_up_complete" }, { kind: "tracking", ref: "sign_up_complete" }],
  ])("%s %j", (cls, payload, want) => {
    expect(execCardTarget(cls, payload)).toEqual(want);
  });

  it("an id-only campaign has no target (its identity is Layer 1's)", () => {
    expect(execCardTarget("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 50 })).toBeNull();
    expect(execCardTarget("meta_ads.set_status", { object_id: "555", level: "campaign", status: "PAUSED" })).toBeNull();
  });

  it("a generated video is its own script, so two different scripts are never the same work", () => {
    expect(execCardTarget("generated_video.render.v1", { intake: { script: "Order a day ahead." }, format: "explainer" }))
      .toEqual({ kind: "post", ref: "ai video explainer Order a day ahead." });
    expect(execCardTarget("generated_video.render.v1", { intake: {}, format: "hook" })).toBeNull();
  });

  it("targetKeyOf: normalized, clamped to the column, null for a queue or nothing", () => {
    expect(targetKeyOf({ kind: "campaign", ref: "Upcar Search (US)" })).toBe("campaign:upcar search us");
    expect(targetKeyOf({ kind: "queue", ref: "approvals" })).toBeNull();
    expect(targetKeyOf(null)).toBeNull();
    expect(targetKeyOf({ kind: "campaign", ref: "x".repeat(400) })!.length).toBe(300);
  });

  it("targetFromKey inverts targetKeyOf, so an exec pool card meets a prose card on the same key", () => {
    const key = targetKeyOf({ kind: "campaign", ref: "Upcar.ai | Search" })!;
    expect(normalizeRef(targetFromKey(key)!)).toBe(key);
    expect(targetFromKey("nocolon")).toBeNull();
    expect(targetFromKey(":x")).toBeNull();
    expect(targetFromKey(null)).toBeNull();
  });
});

describe("execLayer1Keys mirrors record_channel_exec_action", () => {
  it("the _review variant is the same family", () => {
    expect(execFamily("google_ads.set_status_review")).toBe("google_ads.set_status");
  });

  it("same object, same family: shared subject key whatever the new value", () => {
    const a = execLayer1Keys("google_ads.update_campaign_budget", "update_ad", { campaign_id: "1", daily_budget_usd: 50, rationale: "a" });
    const b = execLayer1Keys("google_ads.update_campaign_budget_review", "update_ad", { campaign_id: "1", daily_budget_usd: 80, rationale: "b" });
    expect(a.filter((k) => b.includes(k))).toEqual(["google_ads.update_campaign_budget|subject:1"]);
  });

  it("subject is level|parent|most specific id, nulls skipped like concat_ws, numbers as digits", () => {
    expect(execSubject("pause_ad", { level: "keyword", parent_id: "22", criterion_id: "9", campaign_id: "1" })).toBe("keyword|22|9");
    expect(execSubject("update_ad", { ad_set_id: 777 })).toBe("777");
    expect(execSubject("create_ad", { campaign_id: "1" })).toBeNull();
    expect(execSubject("update_ad", { name: "x" })).toBeNull();
  });

  it("identical payload minus free text matches even for a create; key order does not matter", () => {
    const a = execLayer1Keys("google_ads.create_campaign", "create_ad", { name: "YT", channel_type: "DEMAND_GEN", daily_budget_usd: 20, rationale: "r1", about: "x" });
    const b = execLayer1Keys("google_ads.create_campaign", "create_ad", { daily_budget_usd: 20, channel_type: "DEMAND_GEN", name: "YT", rationale: "r2", decision_evidence: { e: 1 } });
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("a name alone is never an identity", () => {
    expect(execLayer1Keys("google_ads.create_campaign", "create_ad", { name: "A" })).toEqual([]);
    expect(execLayer1Keys("google_ads.create_campaign", "create_ad", { campaign_name: "A", rationale: "r" })).toEqual([]);
    const a = execLayer1Keys("google_ads.create_campaign", "create_ad", { name: "A", daily_budget_usd: 10 });
    const b = execLayer1Keys("google_ads.create_campaign", "create_ad", { name: "A", daily_budget_usd: 20 });
    expect(a.filter((k) => b.includes(k))).toEqual([]);
  });

  it("different families never share a key", () => {
    const a = execLayer1Keys("google_ads.set_status", "pause_ad", { campaign_id: "1", level: "campaign", status: "PAUSED" });
    const b = execLayer1Keys("google_ads.remove_resource", "pause_ad", { campaign_id: "1", level: "campaign" });
    expect(a.filter((k) => b.includes(k))).toEqual([]);
  });
});

describe("loadMatchPool: every open card on the fresh cards' targets", () => {
  it("issues the indexed same-target read and merges it, deduped by id", async () => {
    rowsFor = (q) => {
      const inTarget = q.ops.some(([op, a]) => op === "in" && a[0] === "target_key");
      if (inTarget) return { data: [{ id: "old-yt", channel_slug: "youtube_ads", status: "pending", title: "Old", target_key: "campaign:yt" }, { id: "new-1", channel_slug: "youtube_ads", status: "pending", title: "New" }], error: null };
      const open = q.ops.some(([op, a]) => op === "in" && Array.isArray(a[1]) && (a[1] as string[]).includes("pending"));
      return { data: open ? [{ id: "new-1", channel_slug: "youtube_ads", status: "pending", title: "New" }] : [], error: null };
    };
    const pool = await loadMatchPool("t" as never, "youtube_ads", 0, ["campaign:yt", "campaign:yt"]);
    expect(queries).toHaveLength(3);
    const target = queries.find((q) => q.ops.some(([op, a]) => op === "in" && a[0] === "target_key"))!;
    expect(target.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["channel_slug", "youtube_ads"]],
        ["in", ["status", ["pending", "snoozed"]]],
        ["in", ["target_key", ["campaign:yt"]]],
        ["limit", [TARGET_POOL_MAX]],
      ]),
    );
    expect(pool.map((p) => p.id)).toEqual(["new-1", "old-yt"]);
    expect(pool.find((p) => p.id === "old-yt")!.target).toEqual({ kind: "campaign", ref: "yt" });
    expect(pool.readFailed).toBeUndefined();
  });

  it("no target keys: the two bounded reads only", async () => {
    await loadMatchPool("t" as never, "seo", 0);
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q.ops.some(([op, a]) => op === "limit" && a[0] === POOL_MAX / 2))).toBe(true);
  });

  it("a failed read is an empty pool marked readFailed (no snapshot to defend)", async () => {
    rowsFor = () => ({ data: [], error: { message: "boom" } });
    const pool = await loadMatchPool("t" as never, "seo", 0, ["page:/x"]);
    expect(pool).toHaveLength(0);
    expect(pool.readFailed).toBe(true);
  });
});

describe("matcher failure posture", () => {
  const fresh = [{ ref: "n0", title: "Raise budget", summary: "", target: { kind: "campaign", ref: "a" } }];
  const pool = [{ id: "o1", channel: "google_ads", status: "open" as const, title: "Raise it", summary: "", target: { kind: "campaign", ref: "a" } }];

  it("hasMatchCandidates tells nothing-to-judge from a judge that failed", () => {
    expect(hasMatchCandidates(fresh, pool)).toBe(true);
    expect(hasMatchCandidates(fresh, [{ ...pool[0], target: { kind: "campaign", ref: "b" } }])).toBe(false);
    expect(hasMatchCandidates([...fresh, { ...fresh[0], ref: "n1" }], [])).toBe(true);
  });

  it("a thrown or unparseable judge fails open and logs a warn with token usage", async () => {
    expect(await matchRunCards("google_ads", fresh, pool, { call: vi.fn(async () => { throw new Error("timeout"); }) as never })).toBeNull();
    expect(await matchRunCards("google_ads", fresh, pool, { call: vi.fn(async () => ({ text: "no json", usage: { input_tokens: 7, output_tokens: 2 } })) as never })).toBeNull();
    const warns = logEvent.mock.calls.map((c) => c[0]).filter((e) => e.code === "channel.card_match_failed");
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatchObject({ level: "warn", source: "channel_actions.match" });
    expect(warns[1]).toMatchObject({ meta: { input_tokens: 7, output_tokens: 2 } });
  });
});

describe("alertRematchExhausted", () => {
  it("one durable alert keyed per run (and hashed target), ids only; nudges only a new row", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const nudge = vi.fn();
    const log = vi.fn(async () => undefined);
    await alertRematchExhausted({ tenantId: "t", runId: "r", channelSlug: "google_ads", scope: "exec", targetKey: "campaign:secret name" }, { rpc: rpc as never, nudge, log: log as never });
    const args = (rpc.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect((rpc.mock.calls[0] as unknown[])[1]).toBe("enqueue_ops_alert");
    expect(args.p_dedupe_key).toMatch(/^rematch:r:[0-9a-f]{16}$/);
    expect(args.p_code).toBe("rematch_exhausted");
    expect(JSON.stringify(args)).not.toContain("secret");
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "channel.card_rematch_exhausted" }));
    expect(rematchDedupeKey({ tenantId: "t", runId: "r", channelSlug: "x", scope: "run" })).toBe("rematch:r");
  });

  it("a duplicate key does not nudge; an enqueue failure never throws", async () => {
    const nudge = vi.fn();
    await alertRematchExhausted({ tenantId: "t", runId: "r", channelSlug: "x", scope: "run" }, { rpc: vi.fn(async () => ({ data: false, error: null })) as never, nudge, log: vi.fn(async () => undefined) as never });
    await alertRematchExhausted({ tenantId: "t", runId: "r", channelSlug: "x", scope: "run" }, { rpc: vi.fn(async () => ({ data: null, error: { message: "down" } })) as never, nudge, log: vi.fn(async () => undefined) as never });
    expect(nudge).not.toHaveBeenCalled();
  });
});
