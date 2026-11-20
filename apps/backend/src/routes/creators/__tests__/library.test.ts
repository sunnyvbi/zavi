import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { makeFakeDb, type FakeDb } from "@/services/creators/__tests__/fake-supabase";

const m = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  send: vi.fn(async () => ({ ids: ["e1"] })),
  requireAuth: vi.fn(),
  createAd: vi.fn(),
  capability: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/../workers/client", () => ({
  inngest: { createFunction: () => ({ id: "stub" }), send: m.send },
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/tools/meta-ads/write/create_library_ad", () => ({ metaCreateLibraryAd: m.createAd }));
vi.mock("@/services/tools/meta-ads/write/_library-ad-capability", () => ({
  BLOCK_REASON_TEXT: {},
  resolveMetaAdCapability: m.capability,
}));

import {
  getCreatorLibrary,
  getCreatorLibraryAsset,
  getCreatorLibraryDownload,
  getCreatorLibraryMetaEligibility,
  postCreatorLibraryMetaAd,
} from "../library";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function seed(order: { status: string; closed_reason: string | null }, disputes: Array<Record<string, unknown>> = []): FakeDb {
  return makeFakeDb({
    creator_orders: [
      {
        id: ORDER,
        tenant_id: TENANT,
        human_member_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        closed_at: PAST,
        brief_id: null,
        package_snapshot: { kind: "ugc_video", ad_rights_days: 90, addons: [] },
        ...order,
      },
    ],
    creator_submissions: [
      {
        id: SUB,
        tenant_id: TENANT,
        order_id: ORDER,
        version: 1,
        position: 0,
        kind: "video",
        storage_path: `${TENANT}/${ORDER}/v1.mp4`,
        mime_type: "video/mp4",
        bytes: 1024,
      },
    ],
    creator_library_assets: [
      {
        id: ASSET,
        tenant_id: TENANT,
        order_id: ORDER,
        submission_id: SUB,
        human_member_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        rights_start_at: PAST,
        rights_end_at: FUTURE,
        utm_campaign: "zavi-cr-abc",
        meta_ad_account_id: null,
        meta_video_id: null,
        meta_ad_id: null,
        meta_ad_set_id: null,
        meta_auto_paused_at: null,
        metrics: null,
        metrics_read_at: null,
        youtube_video_id: null,
        created_at: PAST,
        updated_at: PAST,
      },
    ],
    creator_disputes: disputes.map((d) => ({ tenant_id: TENANT, order_id: ORDER, ...d })),
  });
}

const REFUNDED = { status: "cancelled", closed_reason: "mediation_refund" };
const AUTO_ACCEPTED = { status: "completed", closed_reason: "auto_accepted" };
const OPEN = [{ id: "dispute-1", status: "open", outcome: null }];

function mkRes() {
  const r = { statusCode: 200, body: undefined as unknown } as Record<string, unknown> & { statusCode: number; body: any };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as unknown as Response & { statusCode: number; body: any };
}

const mkReq = (body: unknown = {}) => ({ params: { asset_id: ASSET }, body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: TENANT, access_token: "t" });
  m.capability.mockResolvedValue({
    ok: true,
    ad_account_id: "act_1",
    page_id: "p1",
    page_name: "Page",
    ad_sets: [{ id: "as_1", name: "Set" }],
  });
  m.createAd.mockResolvedValue({
    ad_account_id: "act_1",
    video_id: "vid_1",
    creative_id: "cr_1",
    ad_id: "ad_1",
    status: "PAUSED",
  });
});

describe("creator library routes after a full mediation refund", () => {
  it("lists nothing, opens nothing, signs nothing and launches nothing", async () => {
    const db = seed(REFUNDED, [{ id: "dispute-1", status: "resolved", outcome: "refund" }]);
    m.serviceClient.mockReturnValue(db.client);

    const list = mkRes();
    await getCreatorLibrary(mkReq(), list);
    expect(list.body).toEqual({ assets: [] });

    const one = mkRes();
    await getCreatorLibraryAsset(mkReq(), one);
    expect(one.statusCode).toBe(404);

    const download = mkRes();
    await getCreatorLibraryDownload(mkReq(), download);
    expect(download.statusCode).toBe(404);
    expect(download.body.url).toBeUndefined();

    const eligibility = mkRes();
    await getCreatorLibraryMetaEligibility(mkReq(), eligibility);
    expect(eligibility.statusCode).toBe(404);
    expect(eligibility.body.eligible).toBeUndefined();

    const launch = mkRes();
    await postCreatorLibraryMetaAd(mkReq({ ad_set_id: "as_1" }), launch);
    expect(launch.statusCode).toBe(404);

    expect(db.signedFor).toEqual([]);
    expect(m.createAd).not.toHaveBeenCalled();
    expect(m.capability).not.toHaveBeenCalled();
    expect(db.updated).toEqual([]);
  });
});

describe("creator library routes while a buffer dispute is open", () => {
  it("refuses the download and the ad launch, and signs nothing", async () => {
    const db = seed(AUTO_ACCEPTED, OPEN);
    m.serviceClient.mockReturnValue(db.client);

    const download = mkRes();
    await getCreatorLibraryDownload(mkReq(), download);
    expect(download.statusCode).toBe(404);

    const launch = mkRes();
    await postCreatorLibraryMetaAd(mkReq({ ad_set_id: "as_1" }), launch);
    expect(launch.statusCode).toBe(404);

    expect(db.signedFor).toEqual([]);
    expect(m.createAd).not.toHaveBeenCalled();
    expect(db.updated).toEqual([]);
  });

  it("hands the video back once Zavi resolves the dispute pay in full", async () => {
    const db = seed(AUTO_ACCEPTED, OPEN);
    m.serviceClient.mockReturnValue(db.client);
    db.tables.creator_disputes[0].status = "resolved";
    db.tables.creator_disputes[0].outcome = "pay_full";
    db.tables.creator_orders[0].closed_reason = "mediation_pay_full";

    const download = mkRes();
    await getCreatorLibraryDownload(mkReq(), download);
    expect(download.statusCode).toBe(200);
    expect(download.body.url).toContain(`${TENANT}/${ORDER}/v1.mp4`);
  });
});

describe("creator library routes on an accepted job with no dispute", () => {
  it.each(["approved", "auto_accepted"])("a %s video downloads and launches as a paused ad", async (closed_reason) => {
    const db = seed({ status: "completed", closed_reason });
    m.serviceClient.mockReturnValue(db.client);

    const list = mkRes();
    await getCreatorLibrary(mkReq(), list);
    expect(list.body.assets.map((a: { id: string }) => a.id)).toEqual([ASSET]);

    const download = mkRes();
    await getCreatorLibraryDownload(mkReq(), download);
    expect(download.statusCode).toBe(200);
    expect(download.body.url).toContain("creator-deliverables");

    const eligibility = mkRes();
    await getCreatorLibraryMetaEligibility(mkReq(), eligibility);
    expect(eligibility.body.eligible).toBe(true);

    const launch = mkRes();
    await postCreatorLibraryMetaAd(mkReq({ ad_set_id: "as_1" }), launch);
    expect(launch.statusCode).toBe(200);
    expect(launch.body.ad_id).toBe("ad_1");
    expect(m.createAd).toHaveBeenCalledTimes(1);
    expect(m.createAd.mock.calls[0][1].video_url).toContain(`${TENANT}/${ORDER}/v1.mp4`);
    expect(db.tables.creator_library_assets[0].meta_ad_id).toBe("ad_1");
  });
});
