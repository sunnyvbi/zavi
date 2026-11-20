
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type FakeDb } from "./fake-supabase";

const m = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  send: vi.fn(async () => ({ ids: ["e1"] })),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/../workers/client", () => ({
  inngest: { createFunction: () => ({ id: "stub" }), send: m.send },
}));

import { asTenantId } from "@/services/tenant-client";
import {
  TWO_CLOCKS_WARNING,
  adRightsDaysFromSnapshot,
  assertPathOwnedBy,
  createLibraryAssetOnApproval,
  getLibraryAsset,
  getLibraryAssetRow,
  listLibraryAssets,
  performanceFrom,
  rightsEndFrom,
  signedDownloadUrl,
} from "../library";
import { CREATOR_AD_METRICS_MIN_CONVERSIONS } from "@zavi/shared";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUB_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLOSED_AT = "2026-09-01T00:00:00.000Z";

function seed(
  over: {
    adRightsDays?: number | null;
    addons?: unknown[];
    briefId?: string | null;
    briefTag?: string;
    briefSource?: string | null;
    assets?: Array<Record<string, unknown>>;
    status?: string;
    closedReason?: string | null;
  } = {},
): FakeDb {
  const snapshot: Record<string, unknown> = {
    kind: over.adRightsDays === null ? "audience_post" : "ugc_video",
    addons: over.addons ?? [],
  };
  if (over.adRightsDays !== null) snapshot.ad_rights_days = over.adRightsDays ?? 90;

  return makeFakeDb({
    creator_orders: [
      {
        id: ORDER_A,
        tenant_id: TENANT_A,
        human_member_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: over.status ?? "completed",
        closed_reason: over.closedReason === undefined ? "approved" : over.closedReason,
        closed_at: CLOSED_AT,
        brief_id: over.briefId ?? null,
        package_snapshot: snapshot,
      },
    ],
    creator_briefs: over.briefId
      ? [
          {
            id: over.briefId,
            tenant_id: TENANT_A,
            utm_campaign: over.briefTag ?? "zavi-brief-tag",
            source_channel: over.briefSource ?? null,
          },
        ]
      : [],
    creator_submissions: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        tenant_id: TENANT_A,
        order_id: ORDER_A,
        version: 1,
        position: 0,
        kind: "video",
        storage_path: `${TENANT_A}/${ORDER_A}/v1.mp4`,
        mime_type: "video/mp4",
        bytes: 1024,
      },
      {
        id: SUB_A,
        tenant_id: TENANT_A,
        order_id: ORDER_A,
        version: 2,
        position: 0,
        kind: "video",
        storage_path: `${TENANT_A}/${ORDER_A}/v2.mp4`,
        mime_type: "video/mp4",
        bytes: 2048,
      },
    ],
    creator_library_assets: over.assets ?? [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rights window", () => {
  it("reads ad_rights_days only from a well-formed ugc_video snapshot", () => {
    expect(adRightsDaysFromSnapshot({ kind: "ugc_video", ad_rights_days: 365 })).toBe(365);
    expect(adRightsDaysFromSnapshot({ kind: "ugc_video", ad_rights_days: 45 })).toBeNull();
    expect(adRightsDaysFromSnapshot({ kind: "audience_post", ad_rights_days: 90 })).toBeNull();
    expect(adRightsDaysFromSnapshot(null)).toBeNull();
  });

  it.each([30, 90, 365])("ends the licence exactly %i days after it starts", (days) => {
    const start = new Date("2026-09-01T00:00:00.000Z");
    const end = rightsEndFrom(start, days);
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(days);
  });
});

describe("createLibraryAssetOnApproval", () => {
  it("creates the asset from the LATEST submission with the package's rights dates", async () => {
    const db = seed({ adRightsDays: 90 });
    m.serviceClient.mockReturnValue(db.client);

    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    expect(out.created).toBe(true);
    expect(out.asset?.submission_id).toBe(SUB_A);
    expect(out.asset?.rights_start_at).toBe(CLOSED_AT);
    expect(out.asset?.rights_end_at).toBe("2026-11-30T00:00:00.000Z");
    expect(out.asset?.tenant_id).toBe(TENANT_A);
  });

  it("arms the rights-expiry sleeper for the end date it stored", async () => {
    const db = seed({ adRightsDays: 30 });
    m.serviceClient.mockReturnValue(db.client);

    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    expect(m.send).toHaveBeenCalledWith({
      name: "creator/rights_expiry.scheduled",
      data: { asset_id: out.asset?.id, rights_end_at: out.asset?.rights_end_at },
    });
  });

  it("is idempotent: a second call returns the existing asset and creates nothing", async () => {
    const db = seed({ adRightsDays: 90 });
    m.serviceClient.mockReturnValue(db.client);

    const first = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    const second = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.asset?.id).toBe(first.asset?.id);
    expect(db.tables.creator_library_assets).toHaveLength(1);
  });

  it("refuses an order that was not accepted (money and rights need their trigger)", async () => {
    const db = seed({ status: "submitted", closedReason: null });
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out).toMatchObject({ created: false, skipped_reason: "order_not_accepted" });
  });

  it("never shelves a leftover audience_post job: it has no ad rights to honour", async () => {
    const db = seed({ adRightsDays: null });
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out).toMatchObject({ created: false, asset: null, skipped_reason: "no_valid_ad_rights_days" });
    expect(db.tables.creator_library_assets ?? []).toHaveLength(0);
  });

  it("skips a MALFORMED ad video", async () => {
    const db = seed({ adRightsDays: 45 });
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out).toMatchObject({ created: false, skipped_reason: "no_valid_ad_rights_days" });
  });

  it("carries the brief's tracking tag when the order came from a brief", async () => {
    const db = seed({ briefId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", briefTag: "zavi-cr-brieftag" });
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out.asset?.utm_campaign).toBe("zavi-cr-brieftag");
  });

  it("falls back to a generated tag when the brief's tag is already used", async () => {
    const db = seed({
      briefId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      briefTag: "zavi-cr-brieftag",
      assets: [
        {
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          tenant_id: TENANT_A,
          order_id: ORDER_A,
          submission_id: "99999999-9999-4999-8999-999999999999",
          utm_campaign: "zavi-cr-brieftag",
          rights_start_at: CLOSED_AT,
          rights_end_at: CLOSED_AT,
          meta_ad_id: null,
          meta_auto_paused_at: null,
        },
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out.created).toBe(true);
    expect(out.asset?.utm_campaign).not.toBe("zavi-cr-brieftag");
  });
});

describe("tenant isolation", () => {
  it("does not show tenant A's asset to tenant B", async () => {
    const db = seed({ adRightsDays: 90 });
    m.serviceClient.mockReturnValue(db.client);
    const created = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    const assetId = created.asset!.id;

    expect(await getLibraryAsset(asTenantId(TENANT_A), assetId)).not.toBeNull();
    expect(await getLibraryAsset(asTenantId(TENANT_B), assetId)).toBeNull();
    expect(await listLibraryAssets(asTenantId(TENANT_B))).toEqual([]);
    expect(await listLibraryAssets(asTenantId(TENANT_A))).toHaveLength(1);
  });

  it("refuses to sign a download for another tenant's asset id", async () => {
    const db = seed({ adRightsDays: 90 });
    m.serviceClient.mockReturnValue(db.client);
    const created = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    expect(await signedDownloadUrl(asTenantId(TENANT_B), created.asset!.id)).toBeNull();
    expect(db.signedFor).toHaveLength(0);
  });

  it("signs a download for the owning tenant, from the private bucket, under its own prefix", async () => {
    const db = seed({ adRightsDays: 90 });
    m.serviceClient.mockReturnValue(db.client);
    const created = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    const signed = await signedDownloadUrl(asTenantId(TENANT_A), created.asset!.id);

    expect(signed?.url).toContain("creator-deliverables");
    expect(db.signedFor).toHaveLength(1);
    expect(db.signedFor[0].bucket).toBe("creator-deliverables");
    expect(db.signedFor[0].path.startsWith(`${TENANT_A}/`)).toBe(true);
    expect(db.signedFor[0].ttl).toBeLessThanOrEqual(600);
  });

  it("throws rather than sign an object path outside the caller's tenant prefix", () => {
    expect(() => assertPathOwnedBy(TENANT_A, `${TENANT_B}/order/v1.mp4`)).toThrow(/does not belong/);
    expect(() => assertPathOwnedBy(TENANT_A, `${TENANT_A}/order/v1.mp4`)).not.toThrow();
  });
});

describe("two clocks", () => {
  it("warns only when the package carries a partnership ad code", async () => {
    const withCode = seed({ addons: [{ code: "partnership_ad_code", price_cents: 5000 }] });
    m.serviceClient.mockReturnValue(withCode.client);
    const a = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    const withWarning = await getLibraryAsset(asTenantId(TENANT_A), a.asset!.id);
    expect(withWarning?.two_clocks_warning).toBe(TWO_CLOCKS_WARNING);

    const plain = seed({ addons: [{ code: "raw_footage", price_cents: 2000 }] });
    m.serviceClient.mockReturnValue(plain.client);
    const b = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    const noWarning = await getLibraryAsset(asTenantId(TENANT_A), b.asset!.id);
    expect(noWarning?.two_clocks_warning).toBeNull();
  });

  it("says nothing about dashes or jargon in the warning copy", () => {
    expect(TWO_CLOCKS_WARNING).not.toMatch(/[—–]|--/);
  });
});

describe("S6: which channel the video goes back to", () => {
  it("reads source_channel through the order's brief, and null with no brief", async () => {
    const fromMeta = seed({ briefId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", briefSource: "meta_ads" });
    m.serviceClient.mockReturnValue(fromMeta.client);
    const a = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect((await getLibraryAsset(asTenantId(TENANT_A), a.asset!.id))?.source_channel).toBe("meta_ads");

    const booked = seed();
    m.serviceClient.mockReturnValue(booked.client);
    const b = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect((await getLibraryAsset(asTenantId(TENANT_A), b.asset!.id))?.source_channel).toBeNull();
  });

  it("a failed brief or order read throws instead of reading as missing", async () => {
    const db = seed({ briefId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", briefSource: "meta_ads" });
    m.serviceClient.mockReturnValue(db.client);
    const a = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);

    const failing: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "boom" } })
            : () => failing,
      },
    );
    const real = db.client as { from: (t: string) => unknown };
    m.serviceClient.mockReturnValue({
      ...real,
      from: (t: string) => (t === "creator_briefs" ? failing : real.from(t)),
    });
    await expect(getLibraryAsset(asTenantId(TENANT_A), a.asset!.id)).rejects.toThrow(/boom/);

    m.serviceClient.mockReturnValue({
      ...real,
      from: (t: string) => (t === "creator_orders" ? failing : real.from(t)),
    });
    await expect(createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A)).rejects.toThrow(/boom/);
  });
});

describe("what the asset view says about the ad's numbers", () => {
  const metrics = {
    spend_usd: 900,
    impressions: 50000,
    clicks: 1200,
    reach: 30000,
    conversions: 120,
    purchases: 80,
    purchase_value_usd: 4000,
  };

  function assetRow(over: Record<string, unknown> = {}) {
    return {
      id: "asset-1",
      tenant_id: TENANT_A,
      order_id: ORDER_A,
      submission_id: SUB_A,
      human_member_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      rights_start_at: CLOSED_AT,
      rights_end_at: "2026-11-30T00:00:00.000Z",
      utm_campaign: "zavi-cr-abc",
      meta_ad_account_id: "act_1",
      meta_video_id: "v1",
      meta_ad_id: "777",
      meta_ad_set_id: "888",
      meta_auto_paused_at: null,
      metrics: null,
      metrics_read_at: null,
      created_at: CLOSED_AT,
      updated_at: CLOSED_AT,
      ...over,
    } as never;
  }

  it("says nothing at all before the first readback", () => {
    expect(performanceFrom(assetRow())).toBeNull();
  });

  it("ABSTAINS below the bar and shows progress instead of a total", () => {
    const perf = performanceFrom(
      assetRow({
        metrics: { ...metrics, conversions: 18 },
        metrics_read_at: "2026-09-13T00:00:00.000Z",
      }),
    );
    expect(perf?.enough_evidence).toBe(false);
    expect(perf?.progress_label).toBe(`18 of ${CREATOR_AD_METRICS_MIN_CONVERSIONS} conversions`);
    expect(perf?.numbers).toBeNull();
  });

  it("shows the absolute numbers once the bar is cleared, and no ratio", () => {
    const perf = performanceFrom(
      assetRow({ metrics, metrics_read_at: "2026-09-13T00:00:00.000Z" }),
    );
    expect(perf?.enough_evidence).toBe(true);
    expect(perf?.numbers).toEqual(metrics);
    expect(Object.keys(perf!.numbers!)).not.toContain("roas");
    expect(Object.keys(perf!.numbers!)).not.toContain("cpa_usd");
  });
});

describe("a multi-video package puts every accepted video on the shelf", () => {
  const SUB_A2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const SUB_A3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  function seedThree(): FakeDb {
    const db = seed({ adRightsDays: 90 });
    for (const [id, position] of [
      [SUB_A2, 1],
      [SUB_A3, 2],
    ] as const) {
      db.tables.creator_submissions.push({
        id,
        tenant_id: TENANT_A,
        order_id: ORDER_A,
        version: 2,
        position,
        kind: "video",
        storage_path: `${TENANT_A}/${ORDER_A}/v2-${position}.mp4`,
        mime_type: "video/mp4",
        bytes: 2048,
      });
    }
    return db;
  }

  it("creates one asset per video of the accepted version, none from the earlier cut", async () => {
    const db = seedThree();
    m.serviceClient.mockReturnValue(db.client);
    const out = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(out.created).toBe(true);
    expect(out.asset?.submission_id).toBe(SUB_A);
    const ids = db.tables.creator_library_assets.map((a) => a.submission_id).sort();
    expect(ids).toEqual([SUB_A, SUB_A2, SUB_A3].sort());
    expect(m.send).toHaveBeenCalledTimes(3);
  });

  it("is idempotent across all of them", async () => {
    const db = seedThree();
    m.serviceClient.mockReturnValue(db.client);
    await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    const again = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(again.created).toBe(false);
    expect(db.tables.creator_library_assets).toHaveLength(3);
  });
});

describe("a refunded or disputed job takes its video off the shelf", () => {
  const DISPUTE = "abababab-abab-4bab-8bab-abababababab";

  async function shelved(closedReason: string) {
    const db = seed({ adRightsDays: 90, closedReason });
    m.serviceClient.mockReturnValue(db.client);
    const created = await createLibraryAssetOnApproval(asTenantId(TENANT_A), ORDER_A);
    expect(created.created).toBe(true);
    return { db, assetId: created.asset!.id };
  }

  function openDispute(db: FakeDb, tenant_id = TENANT_A) {
    db.tables.creator_disputes = [
      ...(db.tables.creator_disputes ?? []),
      { id: DISPUTE, tenant_id, order_id: ORDER_A, status: "open", outcome: null },
    ];
  }

  it.each(["approved", "auto_accepted", "mediation_pay_full", "mediation_pay_part"])(
    "keeps listing, opening and signing a %s video with no dispute",
    async (closedReason) => {
      const { db, assetId } = await shelved(closedReason);
      expect((await listLibraryAssets(asTenantId(TENANT_A))).map((a) => a.id)).toEqual([assetId]);
      expect(await getLibraryAsset(asTenantId(TENANT_A), assetId)).not.toBeNull();
      expect(await getLibraryAssetRow(asTenantId(TENANT_A), assetId)).not.toBeNull();
      expect(await signedDownloadUrl(asTenantId(TENANT_A), assetId)).not.toBeNull();
      expect(db.signedFor).toHaveLength(1);
    },
  );

  it("after a full mediation refund the asset is not listed, not opened, and never signed", async () => {
    const { db, assetId } = await shelved("auto_accepted");
    db.tables.creator_disputes = [
      { id: DISPUTE, tenant_id: TENANT_A, order_id: ORDER_A, status: "resolved", outcome: "refund" },
    ];
    db.tables.creator_orders[0].status = "cancelled";
    db.tables.creator_orders[0].closed_reason = "mediation_refund";

    expect(await listLibraryAssets(asTenantId(TENANT_A))).toEqual([]);
    expect(await getLibraryAsset(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(await getLibraryAssetRow(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(await signedDownloadUrl(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(db.signedFor).toEqual([]);
    expect(db.tables.creator_library_assets).toHaveLength(1);
  });

  it("hides only the refunded job's video and keeps the paid one on the same shelf", async () => {
    const { db, assetId } = await shelved("approved");
    const ORDER_B = "acacacac-acac-4cac-8cac-acacacacacac";
    db.tables.creator_orders.push({
      ...db.tables.creator_orders[0],
      id: ORDER_B,
      status: "cancelled",
      closed_reason: "mediation_refund",
    });
    db.tables.creator_library_assets.push({
      ...db.tables.creator_library_assets[0],
      id: "refunded-asset",
      order_id: ORDER_B,
      submission_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      utm_campaign: "zavi-cr-refunded",
    });
    expect((await listLibraryAssets(asTenantId(TENANT_A))).map((a) => a.id)).toEqual([assetId]);
    expect(await signedDownloadUrl(asTenantId(TENANT_A), "refunded-asset")).toBeNull();
    expect(db.signedFor).toEqual([]);
  });

  it("refuses to sign or open the video while a buffer dispute is open, and gives it back on pay in full", async () => {
    const { db, assetId } = await shelved("auto_accepted");
    openDispute(db);

    expect(await listLibraryAssets(asTenantId(TENANT_A))).toEqual([]);
    expect(await getLibraryAsset(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(await getLibraryAssetRow(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(await signedDownloadUrl(asTenantId(TENANT_A), assetId)).toBeNull();
    expect(db.signedFor).toEqual([]);

    db.tables.creator_disputes[0].status = "resolved";
    db.tables.creator_disputes[0].outcome = "pay_full";
    db.tables.creator_orders[0].closed_reason = "mediation_pay_full";

    expect((await listLibraryAssets(asTenantId(TENANT_A))).map((a) => a.id)).toEqual([assetId]);
    expect(await signedDownloadUrl(asTenantId(TENANT_A), assetId)).not.toBeNull();
    expect(db.signedFor).toHaveLength(1);
  });

  it("another tenant's dispute row on the same order id does not lock this tenant's video", async () => {
    const { db, assetId } = await shelved("auto_accepted");
    openDispute(db, TENANT_B);
    expect(await signedDownloadUrl(asTenantId(TENANT_A), assetId)).not.toBeNull();
    expect((await listLibraryAssets(asTenantId(TENANT_A))).map((a) => a.id)).toEqual([assetId]);
  });

  it("a failed order or dispute read throws instead of handing out the video", async () => {
    const { db, assetId } = await shelved("auto_accepted");
    const failing: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "gate down" } })
            : () => failing,
      },
    );
    const real = db.client as { from: (t: string) => unknown };
    for (const table of ["creator_orders", "creator_disputes"]) {
      m.serviceClient.mockReturnValue({ ...real, from: (t: string) => (t === table ? failing : real.from(t)) });
      await expect(signedDownloadUrl(asTenantId(TENANT_A), assetId)).rejects.toThrow(/gate down/);
      await expect(listLibraryAssets(asTenantId(TENANT_A))).rejects.toThrow(/gate down/);
    }
    expect(db.signedFor).toEqual([]);
  });
});
