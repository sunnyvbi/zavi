import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  holds: [] as Array<Record<string, unknown>>,
  readError: null as string | null,
  filters: [] as string[],
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  answer: "released" as string,
  launches: [] as Array<Record<string, unknown>>,
  launchFilters: [] as string[],
  claims: [] as Array<Record<string, unknown>>,
  claimsError: null as string | null,
}));

vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  const chain = (label: string) => (...a: unknown[]) => (db.filters.push(`${label}:${JSON.stringify(a)}`), q);
  for (const m of ["select", "eq", "in", "is", "lt", "order"]) q[m] = chain(m);
  q.limit = async () => (db.readError ? { data: null, error: { message: db.readError } } : { data: db.holds, error: null });
  const lq: Record<string, unknown> = {};
  lq.select = () => lq;
  lq.eq = (...a: unknown[]) => (db.launchFilters.push(JSON.stringify(a)), lq);
  lq.limit = async () => ({ data: db.launches, error: null });
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({
      from: (t: string) => {
        if (t === "ad_pending_tests") {
          const pq: Record<string, unknown> = {};
          pq.select = () => pq;
          pq.eq = () => pq;
          pq.limit = async () => (db.claimsError ? { data: null, error: { message: db.claimsError } } : { data: db.claims, error: null });
          return pq;
        }
        return t === "tiktok_ad_launches" ? lq : q;
      },
    }),
    tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
      db.rpcs.push({ name, args });
      return { data: { status: args.p_outcome === "found" ? "resolved" : db.answer }, error: null };
    },
  };
});

const meta = vi.hoisted(() => ({ pages: vi.fn() }));
const gads = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGetAllPages: (...a: unknown[]) => meta.pages(...a),
  metaAdsCreds: async () => ({ ad_account_id: "act_1" }),
}));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: (...a: unknown[]) => gads.search(...a) }));
const tt = vi.hoisted(() => ({ groups: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({ tiktokAdsAccount: async () => ({ connected_account_id: "ca1" }) }));
vi.mock("@/services/connectors/tiktok-ads/objects", () => ({ listTiktokAdGroups: (...a: unknown[]) => tt.groups(...a) }));

import { alertNoRefHold, findAdObjects, noRefHoldAlertKey, noRefHoldAlertMessage, resolveUnknownAdHolds, UNKNOWN_HOLD_MIN_AGE_MS } from "../ad-hold-resolve";

const NOW = new Date("2026-10-07T12:00:00Z");
const TAG = { kind: "meta_tag", level: "adset", campaign_id: "c1", tag: "zv0123456789" };
const hold = (over: Record<string, unknown> = {}) => ({
  id: "h1",
  idem_key: "a:create",
  platform: "meta",
  provider_ref: TAG,
  updated_at: "2026-10-02T08:00:00.000Z",
  ...over,
});

beforeEach(() => {
  db.holds = [];
  db.readError = null;
  db.filters = [];
  db.rpcs = [];
  db.answer = "released";
  db.launches = [];
  db.launchFilters = [];
  db.claims = [];
  db.claimsError = null;
});

describe("resolveUnknownAdHolds", () => {
  it("reads only this tenant's open holds with no object id, at least 2 hours since their last change", async () => {
    await resolveUnknownAdHolds("t1", NOW, { find: async () => [] });
    expect(db.filters).toContain(`eq:${JSON.stringify(["tenant_id", "t1"])}`);
    expect(db.filters).toContain(`in:${JSON.stringify(["status", ["reserved", "committed"]])}`);
    expect(db.filters).toContain(`is:${JSON.stringify(["object_id", null])}`);
    const cutoff = new Date(NOW.getTime() - UNKNOWN_HOLD_MIN_AGE_MS).toISOString();
    expect(db.filters).toContain(`lt:${JSON.stringify(["updated_at", cutoff])}`);
  });

  it("release not allowed (this hour's spend read failed): nothing on the platform is kept, a found object is still attached", async () => {
    db.holds = [hold()];
    expect(await resolveUnknownAdHolds("t1", NOW, { find: async () => [] }, { allowRelease: false })).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
    expect(db.rpcs).toEqual([]);
    expect(await resolveUnknownAdHolds("t1", NOW, { find: async () => ["as_9"] }, { allowRelease: false })).toEqual({ found: 1, released: 0, kept: 0, failed: 0 });
  });

  it("a failed provider cannot stop verified platforms recovering their holds", async () => {
    db.holds = [hold(), hold({ id: "chat", platform: "chatgpt", provider_ref: { kind: "chatgpt_campaign_name", name: "owned" } })];
    expect(await resolveUnknownAdHolds("t1", NOW, { find: async () => [] }, { allowRelease: true, platforms: ["meta"] })).toEqual({ found: 0, released: 1, kept: 1, failed: 0 });
    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0].args.p_hold_id).toBe("h1");
  });

  it("nothing on the platform: released, sending the updated_at it read", async () => {
    db.holds = [hold()];
    const out = await resolveUnknownAdHolds("t1", NOW, { find: async () => [] });
    expect(out).toEqual({ found: 0, released: 1, kept: 0, failed: 0 });
    expect(db.rpcs).toEqual([
      {
        name: "resolve_unknown_ad_hold",
        args: { p_hold_id: "h1", p_outcome: "absent", p_object_id: null, p_seen_updated_at: "2026-10-02T08:00:00.000Z" },
      },
    ]);
  });

  it("exactly one object: committed on its id", async () => {
    db.holds = [hold()];
    const find = vi.fn(async () => ["9001"]);
    const out = await resolveUnknownAdHolds("t1", NOW, { find });
    expect(find).toHaveBeenCalledWith("t1", TAG);
    expect(out.found).toBe(1);
    expect(db.rpcs[0].args).toMatchObject({ p_outcome: "found", p_object_id: "9001" });
  });

  it("kept without a write: a failed lookup, more than one match, no ref, or a ref for the other platform", async () => {
    db.holds = [
      hold({ id: "h-fail" }),
      hold({ id: "h-many", provider_ref: { ...TAG, tag: "zvmany000000" } }),
      hold({ id: "h-legacy", provider_ref: null }),
      hold({ id: "h-mixed", platform: "google" }),
      hold({ id: "h-bad", provider_ref: { kind: "meta_tag", level: "adset" } }),
    ];
    const find = async (_t: string, ref: { tag?: string }) => {
      if (ref.tag === "zvmany000000") return ["1", "2"];
      throw new Error("Meta 500");
    };
    const out = await resolveUnknownAdHolds("t1", NOW, { find: find as never });
    expect(out).toEqual({ found: 0, released: 0, kept: 5, failed: 0 });
    expect(db.rpcs).toEqual([]);
  });

  it("a hold with no usable ref alerts staff (once per hold, via the outbox) and is still kept, never released", async () => {
    db.holds = [
      hold({ id: "h-legacy", provider_ref: null, daily_delta_usd: "202.30", amount_usd: "6069.00" }),
      hold({ id: "h-mixed", platform: "google" }),
      hold({ id: "h-ok" }),
    ];
    const alerted: string[] = [];
    const out = await resolveUnknownAdHolds("t1", NOW, { find: async () => ["9"], alert: async (_t, h) => void alerted.push(h.id) });
    expect(alerted).toEqual(["h-legacy", "h-mixed"]);
    expect(out).toMatchObject({ found: 1, kept: 2 });
    expect(db.rpcs.some((r) => r.name === "resolve_unknown_ad_hold" && (r.args as { p_hold_id?: string }).p_hold_id === "h-legacy")).toBe(false);

    db.rpcs = [];
    await alertNoRefHold("t1", hold({ id: "h-legacy", provider_ref: null, daily_delta_usd: "202.30", amount_usd: "6069.00" }) as never);
    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0]).toMatchObject({ name: "enqueue_ops_alert", args: { p_dedupe_key: noRefHoldAlertKey("h-legacy"), p_source: "ad_hold_no_ref", p_tenant_id: "t1" } });
    expect(String(db.rpcs[0]!.args.p_msg)).toContain("$202.30/day, $6069.00 held");
    expect(noRefHoldAlertMessage("t1", { id: "h", idem_key: "k", platform: "meta", updated_at: "x", daily_delta_usd: null, amount_usd: undefined })).not.toContain("$");
  });

  it("the database says the hold changed since it was read: counted as kept", async () => {
    db.holds = [hold()];
    db.answer = "stale";
    expect(await resolveUnknownAdHolds("t1", NOW, { find: async () => [] })).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
  });

  it("a holds read that fails resolves nothing and never throws", async () => {
    db.readError = "timeout";
    const find = vi.fn();
    expect(await resolveUnknownAdHolds("t1", NOW, { find })).toEqual({ found: 0, released: 0, kept: 0, failed: 1 });
    expect(find).not.toHaveBeenCalled();
  });
});

describe("findAdObjects: whole reads only", () => {
  it("Meta ad set by exact name under its campaign; by tag; a Meta campaign by tag on the account", async () => {
    meta.pages.mockResolvedValue([
      { id: "1", name: "Zavi · Winners" },
      { id: "2", name: "Zavi · Winners copy · zv0123456789" },
    ]);
    expect(await findAdObjects("t1", { kind: "meta_adset_name", campaign_id: "c1", name: "Zavi · Winners" })).toEqual(["1"]);
    expect(meta.pages).toHaveBeenLastCalledWith("t1", "c1/adsets", { fields: "id,name", limit: 200 });
    expect(await findAdObjects("t1", TAG as never)).toEqual(["2"]);
    await findAdObjects("t1", { kind: "meta_tag", level: "campaign", campaign_id: "c1", tag: "zv0123456789" });
    expect(meta.pages.mock.calls.at(-1)?.[1]).toBe("act_1/campaigns");
  });

  it("Google campaign by exact name, never matching a removed one, from a complete search", async () => {
    gads.search.mockResolvedValue([{ campaign: { id: 5, name: "Zavi · Search" } }, { campaign: { id: 6, name: "Zavi · Search 2" } }]);
    expect(await findAdObjects("t1", { kind: "google_campaign_name", name: "Zavi · Search" })).toEqual(["5"]);
    const [, query, opts] = gads.search.mock.calls[0];
    expect(query).toContain("campaign.status != 'REMOVED'");
    expect(opts).toEqual({ complete: true });
  });

  it("a read that fails throws (the caller keeps the hold)", async () => {
    meta.pages.mockRejectedValue(new Error("more than 100 pages"));
    await expect(findAdObjects("t1", TAG as never)).rejects.toThrow();
  });
});

describe("a TikTok launch hold (tiktok_tag)", () => {
  const REF = { kind: "tiktok_tag", advertiser_id: "7689989546330849300", tag: "zv6f2c4d1e9a" };

  it("is looked up by its tag and committed on the one ad group found; a TikTok ref on another platform is kept", async () => {
    db.holds = [hold({ id: "h-tt", platform: "tiktok", provider_ref: REF }), hold({ id: "h-wrong", platform: "meta", provider_ref: REF })];
    const find = vi.fn(async () => ["1878696310989842"]);
    const out = await resolveUnknownAdHolds("t1", NOW, { find });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith("t1", REF);
    expect(out).toEqual({ found: 1, released: 0, kept: 1, failed: 0 });
    expect(db.rpcs[0].args).toMatchObject({ p_hold_id: "h-tt", p_outcome: "found", p_object_id: "1878696310989842" });
  });

  it("a malformed TikTok ref is no ref: kept for a person", async () => {
    db.holds = [hold({ id: "h-bad", platform: "tiktok", provider_ref: { kind: "tiktok_tag", advertiser_id: "x", tag: "nope" } })];
    expect(await resolveUnknownAdHolds("t1", NOW, { find: async () => [] })).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
  });

  it("findAdObjects reads every ad group of the advertiser and matches the tag, never a deleted one; a failed read throws", async () => {
    tt.groups.mockResolvedValue([
      { id: "1", name: "Zavi · Spring · ad group · zv6f2c4d1e9a", status: "PAUSED" },
      { id: "2", name: "Zavi · Spring · ad group · zv6f2c4d1e9a", status: "DELETED" },
      { id: "3", name: "Someone else's", status: "ACTIVE" },
    ]);
    expect(await findAdObjects("t1", REF as never)).toEqual(["1"]);
    expect(tt.groups.mock.calls[0][1]).toBe("7689989546330849300");
    expect(tt.groups.mock.calls[0]).toHaveLength(2);
    tt.groups.mockRejectedValue(new Error("more than 20 pages"));
    await expect(findAdObjects("t1", REF as never)).rejects.toThrow();
  });
});

describe("F4: a renamed TikTok ad group keeps its hold", () => {
  const REF = { kind: "tiktok_tag", advertiser_id: "7689989546330849300", tag: "zv6f2c4d1e9a" };
  it("no name carries the tag, but the saved ad group is still there (renamed, running): found, never released", async () => {
    tt.groups.mockResolvedValue([{ id: "1878696310989842", name: "Founder renamed it", status: "ACTIVE" }]);
    db.launches = [{ adgroup_id: "1878696310989842" }];
    expect(await findAdObjects("t1", REF as never)).toEqual(["1878696310989842"]);
    expect(db.launchFilters).toContain(JSON.stringify(["tag", "zv6f2c4d1e9a"]));
    db.holds = [hold({ id: "h-tt", platform: "tiktok", provider_ref: REF })];
    const out = await resolveUnknownAdHolds("t1", NOW);
    expect(out).toMatchObject({ found: 1, released: 0 });
  });
  it("released on zero matches only when no id was saved, or the saved one is gone or deleted", async () => {
    tt.groups.mockResolvedValue([{ id: "9", name: "Other", status: "ACTIVE" }, { id: "5", name: "x", status: "DELETED" }]);
    db.launches = [];
    expect(await findAdObjects("t1", REF as never)).toEqual([]);
    db.launches = [{ adgroup_id: "1878696310989842" }];
    expect(await findAdObjects("t1", REF as never)).toEqual([]);
    db.launches = [{ adgroup_id: "5" }];
    expect(await findAdObjects("t1", REF as never)).toEqual([]);
  });
});

describe("a claimed pending new-channel test's hold (pending-test-claim.ts)", () => {
  it("is never resolved, released or alerted: no object and no ref is its normal state until approval", async () => {
    db.holds = [hold({ id: "claim", idem_key: "card-1:create", platform: "tiktok", provider_ref: null }), hold({ id: "other" })];
    db.claims = [{ hold_idem_key: "card-1:create" }];
    const alert = vi.fn();
    const find = vi.fn(async () => []);
    const out = await resolveUnknownAdHolds("t1", NOW, { find, alert });
    expect(alert).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledTimes(1);
    expect(db.rpcs.map((r) => r.args.p_hold_id)).toEqual(["other"]);
    expect(out.kept).toBe(1);
  });

  it("claims that cannot be read: nothing is resolved or alerted this hour", async () => {
    db.holds = [hold({ id: "claim", idem_key: "card-1:create", platform: "tiktok", provider_ref: null }), hold({ id: "other" })];
    db.claimsError = "db down";
    const alert = vi.fn();
    const out = await resolveUnknownAdHolds("t1", NOW, { find: async () => [], alert });
    expect(alert).not.toHaveBeenCalled();
    expect(db.rpcs).toEqual([]);
    expect(out).toMatchObject({ kept: 2, failed: 1 });
  });
});
