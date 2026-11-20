import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const inSlugs = vi.fn();
const firstEq = vi.fn(() => ({ in: inSlugs }));
const select = vi.fn(() => ({ eq: firstEq }));
const from = vi.fn(() => ({ select }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc, from }),
}));

import {
  channelNeedsLiveRead,
  channelRequiresReconnect,
  readAdConnectorStates,
  PERF_DASH_SCHEMA,
  resolvePerfMarketerDashboard,
  type ChannelReads,
} from "../dashboard";

const AUTH = { tenant_id: "t-1", access_token: "tok" };
const PAYLOAD = { kpis: { spend_usd: 42 }, campaigns: [] };
const freshIso = () => new Date().toISOString();
const staleIso = () =>
  new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
const noStates = async () => ({});

type ReadPatch = { connected?: boolean; error?: { code: string; message: string }; tag?: string };
function reads(meta: ReadPatch = {}, google: ReadPatch = {}): ChannelReads {
  const base = (p: ReadPatch) => ({
    connected: p.connected ?? true,
    rows: p.tag ? [{ campaign_id: p.tag } as never] : [],
    read_at: freshIso(),
    daily: null,
    ...(p.error ? { error: p.error } : {}),
  });
  return {
    meta: { ...base(meta), placements: [], pixel_status: null },
    google: { ...base(google), networks: [] },
  };
}

function build(r: ChannelReads = reads()) {
  return vi.fn(async (_a, _s, _w, reuse: Partial<ChannelReads> = {}) => ({
    payload: { ...PAYLOAD },
    reads: { ...r, ...reuse },
  }));
}

function snapshotRow(payload: Record<string, unknown>, r: ChannelReads | null, fetched_at: string) {
  return {
    payload: r ? { ...payload, channel_reads: r } : payload,
    schema_version: PERF_DASH_SCHEMA,
    fetched_at,
  };
}

function withSnapshot(row: unknown) {
  rpc.mockImplementation((fn: string) => {
    if (fn === "get_perf_dashboard_snapshot") return { data: row ? [row] : [], error: null };
    if (fn === "upsert_perf_dashboard_snapshot") return { data: freshIso(), error: null };
    return { data: null, error: null };
  });
}

const upserted = () =>
  rpc.mock.calls.find(([fn]) => fn === "upsert_perf_dashboard_snapshot")?.[1] as
    | { p_payload: Record<string, unknown> & { channel_reads: ChannelReads } }
    | undefined;

beforeEach(() => {
  rpc.mockReset();
  from.mockClear();
  select.mockClear();
  firstEq.mockClear();
  inSlugs.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("readAdConnectorStates — one metadata read for both ad connectors", () => {
  it("maps slugs to channels and parses the timestamps", async () => {
    inSlugs.mockResolvedValue({
      data: [
        { slug: "meta_ads", token_expires_at: "2026-07-29T06:00:00.000Z", connected_at: "2026-06-01T00:00:00.000Z" },
        { slug: "google_ads", token_expires_at: null, connected_at: "2026-07-01T00:00:00.000Z" },
        { slug: "slack", token_expires_at: null, connected_at: null },
      ],
      error: null,
    });
    const out = await readAdConnectorStates(AUTH);
    expect(from).toHaveBeenCalledWith("connector_metadata");
    expect(firstEq).toHaveBeenCalledWith("tenant_id", AUTH.tenant_id);
    expect(inSlugs).toHaveBeenCalledWith("slug", ["meta_ads", "google_ads"]);
    expect(out).toEqual({
      meta: {
        token_expires_at_ms: Date.parse("2026-07-29T06:00:00.000Z"),
        connected_at_ms: Date.parse("2026-06-01T00:00:00.000Z"),
      },
      google: { token_expires_at_ms: null, connected_at_ms: Date.parse("2026-07-01T00:00:00.000Z") },
    });
  });

  it("fails open (no states) when the metadata read errors", async () => {
    inSlugs.mockRejectedValue(new Error("metadata unavailable"));
    await expect(readAdConnectorStates(AUTH)).resolves.toEqual({});
  });
});

describe("channelNeedsLiveRead", () => {
  const now = Date.parse("2026-07-29T07:00:00.000Z");
  const snap = now - 60_000;

  it("true for a persisted expiry at or before now", () => {
    expect(channelNeedsLiveRead({ token_expires_at_ms: now - 1, connected_at_ms: null }, snap, now)).toBe(true);
  });

  it("false for a future expiry or no state", () => {
    expect(channelNeedsLiveRead({ token_expires_at_ms: now + 1, connected_at_ms: null }, snap, now)).toBe(false);
    expect(channelNeedsLiveRead(undefined, snap, now)).toBe(false);
  });

  it("true when the connector was (re)connected after the snapshot was taken", () => {
    expect(channelNeedsLiveRead({ token_expires_at_ms: null, connected_at_ms: snap + 1 }, snap, now)).toBe(true);
    expect(channelNeedsLiveRead({ token_expires_at_ms: null, connected_at_ms: snap - 1 }, snap, now)).toBe(false);
  });
});

describe("channelRequiresReconnect", () => {
  it.each(["meta_ads_token_expired", "meta_ads_permission_revoked", "google_ads_token_revoked"])(
    "%s requires reconnect",
    (code) => expect(channelRequiresReconnect(code)).toBe(true),
  );
  it.each(["meta_ads_timeout", "google_ads_query_failed", "google_ads_read_timeout", undefined])(
    "%s is transient",
    (code) => expect(channelRequiresReconnect(code)).toBe(false),
  );
});

describe("resolvePerfMarketerDashboard — snapshot cache", () => {
  it("cold (no snapshot) → live build + upsert WITH the per-channel reads, cached:false", async () => {
    withSnapshot(null);
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b).toHaveBeenCalledOnce();
    expect(b.mock.calls[0][3]).toEqual({});
    expect(out.cached).toBe(false);
    expect(out.stale).toBe(false);
    expect(out.adData).toEqual(PAYLOAD);
    expect(rpc).toHaveBeenCalledWith(
      "upsert_perf_dashboard_snapshot",
      expect.objectContaining({ p_tenant_id: "t-1", p_window: "last_7d", p_schema_version: PERF_DASH_SCHEMA }),
    );
    expect(upserted()?.p_payload.channel_reads.meta.connected).toBe(true);
  });

  it("warm & fresh (<3h) & no refresh → served from cache, NO live build, reads stripped", async () => {
    const ts = freshIso();
    withSnapshot(snapshotRow(PAYLOAD, reads(), ts));
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
    expect(out.stale).toBe(false);
    expect(out.servedLastGood).toBe(false);
    expect(out.fetchedAt).toBe(ts);
    expect(out.adData).toEqual(PAYLOAD);
    expect(out.adData).not.toHaveProperty("channel_reads");
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("warm & STALE (>3h) & no refresh → cached:true stale:true, still no live build (client drives SWR)", async () => {
    withSnapshot(snapshotRow(PAYLOAD, reads(), staleIso()));
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
    expect(out.stale).toBe(true);
  });

  it("refresh=1 → full live build (nothing reused) + upsert even with a fresh snapshot present", async () => {
    withSnapshot(snapshotRow(PAYLOAD, reads(), freshIso()));
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", true, b, noStates);
    expect(b).toHaveBeenCalledOnce();
    expect(b.mock.calls[0][3]).toEqual({});
    expect(out.cached).toBe(false);
    expect(out.servedLastGood).toBe(false);
    expect(upserted()).toBeDefined();
  });

  it("schema_version mismatch → treated as a miss, live rebuild", async () => {
    withSnapshot({ payload: PAYLOAD, schema_version: 99, fetched_at: freshIso() });
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b).toHaveBeenCalledOnce();
    expect(out.cached).toBe(false);
  });

  it("cache READ throws → best-effort fall through to a live build (never blanks)", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "get_perf_dashboard_snapshot") throw new Error("rpc down");
      if (fn === "upsert_perf_dashboard_snapshot") return { data: freshIso(), error: null };
      return { data: null, error: null };
    });
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b).toHaveBeenCalledOnce();
    expect(out.cached).toBe(false);
  });

  it("cache WRITE throws → still returns freshly built data (best-effort)", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "get_perf_dashboard_snapshot") return { data: [], error: null };
      if (fn === "upsert_perf_dashboard_snapshot") throw new Error("write down");
      return { data: null, error: null };
    });
    const b = build();
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(out.cached).toBe(false);
    expect(out.adData).toMatchObject(PAYLOAD);
  });
});

describe("resolvePerfMarketerDashboard — one channel's failure never blocks or stales the other", () => {
  const GOOGLE_DOWN = { code: "google_ads_query_failed", message: "503" };

  it("Google fails transiently, Meta is fresh → Google served from ITS last-good, Meta kept fresh, merged snapshot persisted", async () => {
    const snap = reads({ tag: "meta-old" }, { tag: "google-old" });
    withSnapshot(snapshotRow(PAYLOAD, snap, freshIso()));
    const live = reads({ tag: "meta-fresh" }, { error: GOOGLE_DOWN });
    const b = build(live);

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", true, b, noStates);

    expect(b).toHaveBeenCalledTimes(2);
    const reassembled = b.mock.calls[1][3] as ChannelReads;
    expect(reassembled.meta.rows).toEqual([{ campaign_id: "meta-fresh" }]);
    expect(reassembled.google.rows).toEqual([{ campaign_id: "google-old" }]);
    expect(reassembled.google.error).toBeUndefined();
    expect(out.servedLastGood).toBe(true);
    expect(out.cached).toBe(false);
    expect(out.servedLastGoodChannels).toEqual(["google"]);
    expect(out.channelErrors).toEqual({ google: GOOGLE_DOWN });
    const persisted = upserted()?.p_payload.channel_reads;
    expect(persisted?.meta.rows).toEqual([{ campaign_id: "meta-fresh" }]);
    expect(persisted?.google.rows).toEqual([{ campaign_id: "google-old" }]);
  });

  it("Meta fails transiently, Google is fresh → the mirror image", async () => {
    const snap = reads({ tag: "meta-old" }, { tag: "google-old" });
    withSnapshot(snapshotRow(PAYLOAD, snap, freshIso()));
    const META_DOWN = { code: "meta_ads_timeout", message: "15s" };
    const b = build(reads({ error: META_DOWN }, { tag: "google-fresh" }));

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", true, b, noStates);

    const reassembled = b.mock.calls[1][3] as ChannelReads;
    expect(reassembled.meta.rows).toEqual([{ campaign_id: "meta-old" }]);
    expect(reassembled.google.rows).toEqual([{ campaign_id: "google-fresh" }]);
    expect(out.servedLastGood).toBe(true);
    expect(out.channelErrors).toEqual({ meta: META_DOWN });
    expect(out.servedLastGoodChannels).toEqual(["meta"]);
  });

  it.each([
    ["meta", "meta_ads_token_expired"],
    ["meta", "meta_ads_permission_revoked"],
    ["google", "google_ads_token_revoked"],
  ] as const)("%s %s → NEVER served from last-good; the reconnect state is returned live", async (channel, code) => {
    withSnapshot(snapshotRow(PAYLOAD, reads({ tag: "meta-old" }, { tag: "google-old" }), freshIso()));
    const err = { code, message: `Reconnect ${channel} Ads` };
    const live = channel === "meta" ? reads({ error: err }, { tag: "google-fresh" }) : reads({ tag: "meta-fresh" }, { error: err });
    const b = build(live);

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", true, b, noStates);

    expect(b).toHaveBeenCalledOnce();
    expect(out.servedLastGood).toBe(false);
    expect(out.cached).toBe(false);
    expect(out.channelErrors).toEqual({ [channel]: err });
    const persisted = upserted()?.p_payload.channel_reads;
    expect(persisted?.[channel].error).toEqual(err);
    expect(persisted?.[channel === "meta" ? "google" : "meta"].rows).toHaveLength(1);
  });

  it("transient failure with NO last-good for that channel → fresh payload returned, error read persisted (never good rows overwritten)", async () => {
    withSnapshot(null);
    const b = build(reads({ tag: "meta-fresh" }, { error: GOOGLE_DOWN }));
    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", true, b, noStates);
    expect(b).toHaveBeenCalledOnce();
    expect(out.servedLastGood).toBe(false);
    expect(out.channelErrors).toEqual({ google: GOOGLE_DOWN });
    expect(upserted()?.p_payload.channel_reads.google.error).toEqual(GOOGLE_DOWN);
  });

  it("a snapshot whose Google read is an error → ONLY Google is re-read on the next load; fresh Meta is reused, not refetched", async () => {
    const snap = reads({ tag: "meta-cached" }, { error: GOOGLE_DOWN });
    withSnapshot(snapshotRow(PAYLOAD, snap, freshIso()));
    const b = build(reads({ tag: "meta-live" }, { tag: "google-recovered" }));

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);

    expect(b).toHaveBeenCalledOnce();
    const reuse = b.mock.calls[0][3] as Partial<ChannelReads>;
    expect(reuse.meta?.rows).toEqual([{ campaign_id: "meta-cached" }]);
    expect(reuse.google).toBeUndefined();
    expect(out.cached).toBe(false);
    expect(out.channelErrors).toEqual({});
  });

  it("a persisted Google token expiry → Google is re-read live, fresh Meta is reused (no Meta fan-out per page load)", async () => {
    withSnapshot(snapshotRow(PAYLOAD, reads({ tag: "meta-cached" }, { tag: "google-cached" }), freshIso()));
    const states = async () => ({
      google: { token_expires_at_ms: Date.now() - 1000, connected_at_ms: null },
    });
    const b = build(reads({ tag: "meta-live" }, { error: { code: "google_ads_token_revoked", message: "x" } }));

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, states);

    expect(b).toHaveBeenCalledOnce();
    const reuse = b.mock.calls[0][3] as Partial<ChannelReads>;
    expect(reuse.meta?.rows).toEqual([{ campaign_id: "meta-cached" }]);
    expect(reuse.google).toBeUndefined();
    expect(out.channelErrors?.google?.code).toBe("google_ads_token_revoked");
  });

  it("a connector wired AFTER the snapshot → that channel is re-read even though the snapshot is fresh", async () => {
    const ts = new Date(Date.now() - 10 * 60_000).toISOString();
    withSnapshot(snapshotRow(PAYLOAD, reads({ tag: "meta-cached" }, { connected: false }), ts));
    const states = async () => ({
      google: { token_expires_at_ms: null, connected_at_ms: Date.now() - 60_000 },
    });
    const b = build(reads({ tag: "meta-live" }, { tag: "google-first-read" }));

    const out = await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, states);

    expect(b).toHaveBeenCalledOnce();
    const reuse = b.mock.calls[0][3] as Partial<ChannelReads>;
    expect(reuse.meta?.rows).toEqual([{ campaign_id: "meta-cached" }]);
    expect(reuse.google).toBeUndefined();
    expect(out.cached).toBe(false);
    expect(upserted()?.p_payload.channel_reads.google.rows).toEqual([{ campaign_id: "google-first-read" }]);
  });

  it("a STALE snapshot reuses nothing even when only one channel must be re-read", async () => {
    withSnapshot(snapshotRow(PAYLOAD, reads({ tag: "meta-cached" }, { error: GOOGLE_DOWN }), staleIso()));
    const b = build();
    await resolvePerfMarketerDashboard(AUTH, "performance-marketer", "last_7d", false, b, noStates);
    expect(b.mock.calls[0][3]).toEqual({});
  });
});
