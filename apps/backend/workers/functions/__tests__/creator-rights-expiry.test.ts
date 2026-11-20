
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  fbGet: vi.fn(),
  fbPost: vi.fn(),
  metaSetStatus: vi.fn(async () => ({ id: "555", status: "PAUSED" as const })),
  logEvent: vi.fn(async () => {}),
  send: vi.fn(async () => ({ ids: ["e1"] })),
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({ id: "stub" }), send: m.send },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: m.fbGet, fbPost: m.fbPost }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: m.metaSetStatus }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import { ExpectedToolError } from "@/services/tools/types";
import { makeFakeDb, type FakeDb } from "@/services/creators/__tests__/fake-supabase";
import {
  pauseExpiredLibraryAd,
  runRightsExpirySweepHandler,
  type LibraryAdRow,
} from "../creator-rights-expiry";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const logger = { info: () => {}, error: () => {} };

function asset(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "asset-1",
    tenant_id: TENANT,
    meta_ad_id: "555",
    meta_auto_paused_at: null,
    rights_end_at: PAST,
    ...over,
  };
}

function db(rows: Array<Record<string, unknown>>): FakeDb {
  const fake = makeFakeDb({ creator_library_assets: rows });
  m.serviceClient.mockReturnValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.fbGet.mockReset();
  m.fbPost.mockReset();
  m.metaSetStatus.mockReset();
  m.metaSetStatus.mockResolvedValue({ id: "555", status: "PAUSED" });
});

describe("pauseExpiredLibraryAd", () => {
  it("pauses a live ad whose rights ended, and pauses it as PAUSED", async () => {
    const fake = db([asset()]);
    m.fbGet.mockResolvedValue({ id: "555", status: "PENDING_REVIEW" });

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("paused");
    expect(m.metaSetStatus).toHaveBeenCalledWith(TENANT, {
      object_id: "555",
      level: "ad",
      status: "PAUSED",
    });
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeTruthy();
  });

  it("succeeds quietly, with NO write to Meta, when the ad is already paused", async () => {
    const fake = db([asset()]);
    m.fbGet.mockResolvedValue({ id: "555", status: "PAUSED" });

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("already_paused");
    expect(m.metaSetStatus).not.toHaveBeenCalled();
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeTruthy();
  });

  it("succeeds quietly when the ad was deleted in Ads Manager", async () => {
    const fake = db([asset()]);
    m.fbGet.mockRejectedValue(
      new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 Object does not exist", {
        http_status: 400,
        graph_code: 100,
        graph_subcode: 33,
      }),
    );

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("gone");
    expect(m.metaSetStatus).not.toHaveBeenCalled();
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeTruthy();
  });

  it("is idempotent on replay: an already-stamped row does nothing at all", async () => {
    const fake = db([asset({ meta_auto_paused_at: "2026-02-01T00:00:00.000Z" })]);

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("already_paused");
    expect(m.fbGet).not.toHaveBeenCalled();
    expect(m.metaSetStatus).not.toHaveBeenCalled();
  });

  it("does nothing for an asset that was never pushed to Meta", async () => {
    const fake = db([asset({ meta_ad_id: null })]);
    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);
    expect(outcome).toBe("nothing_to_pause");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
  });

  it("NEVER records a pause it could not perform: an expired token leaves the row unstamped", async () => {
    const fake = db([asset()]);
    m.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired", "reconnect"));

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("deferred");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
    expect(m.logEvent).toHaveBeenCalled();
  });

  it("leaves the row unstamped when the pause write itself fails", async () => {
    const fake = db([asset()]);
    m.fbGet.mockResolvedValue({ id: "555", status: "PENDING_REVIEW" });
    m.metaSetStatus.mockRejectedValue(new ExpectedToolError("meta_ads_timeout", "slow"));

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);

    expect(outcome).toBe("deferred");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
  });
});

describe("a Meta failure that is not 'the ad is gone' never stamps the licence as handled", () => {
  const econnreset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  const graph = (code: string, meta: Record<string, unknown>) => new ExpectedToolError(code, `Meta failed ${JSON.stringify(meta)}`, meta);

  const READ_FAILURES: Array<[string, () => unknown]> = [
    ["a Meta 500", () => graph("meta_ads_query_failed", { http_status: 500 })],
    ["a Meta 503 with graph code 2", () => graph("meta_ads_query_failed", { http_status: 503, graph_code: 2 })],
    ["a 429", () => graph("meta_ads_query_failed", { http_status: 429 })],
    ["app rate limit code 4", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 4 })],
    ["user rate limit code 17", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 17 })],
    ["calls-per-second code 613", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 613 })],
    ["unknown code 1", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 1 })],
    ["is_transient", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 190, is_transient: true })],
    ["ECONNRESET", econnreset],
    ["a bare Error", () => new Error("boom")],
    ["code 100 without subcode 33", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 100 })],
    ["subcode 33 without code 100", () => graph("meta_ads_query_failed", { http_status: 400, graph_code: 2, graph_subcode: 33 })],
    ["an unclassified query failure", () => new ExpectedToolError("meta_ads_query_failed", "Object does not exist")],
  ];

  it.each(READ_FAILURES)("%s on the read: deferred, unstamped, retried and paused on the next sweep", async (_name, err) => {
    const fake = db([asset({ id: "due" })]);
    m.fbGet.mockRejectedValueOnce(err()).mockResolvedValueOnce({ id: "555", status: "ACTIVE" });

    const first = await runRightsExpirySweepHandler(logger);
    expect(first).toEqual({ claimed: 1, paused: 0, quiet: 0, deferred: 1 });
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
    expect(m.metaSetStatus).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "pause_deferred", tenant_id: TENANT }));

    const second = await runRightsExpirySweepHandler(logger);
    expect(second).toEqual({ claimed: 1, paused: 1, quiet: 0, deferred: 0 });
    expect(m.metaSetStatus).toHaveBeenCalledTimes(1);
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeTruthy();
  });

  it.each([
    ["a write 500", () => graph("meta_ads_write_failed", { http_status: 500 })],
    ["a write rate limit 17", () => graph("meta_ads_write_failed", { http_status: 400, graph_code: 17 })],
    ["ECONNRESET on the write", econnreset],
  ])("%s on the pause: deferred and unstamped", async (_name, err) => {
    const fake = db([asset()]);
    m.fbGet.mockResolvedValue({ id: "555", status: "ACTIVE" });
    m.metaSetStatus.mockRejectedValueOnce(err());

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);
    expect(outcome).toBe("deferred");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
  });

  it("success:false from the real pause write is deferred, not stamped as paused or gone", async () => {
    const actual = await vi.importActual<typeof import("@/services/tools/meta-ads/write/set_status")>(
      "@/services/tools/meta-ads/write/set_status",
    );
    m.metaSetStatus.mockImplementationOnce(actual.metaSetStatus as never);
    m.fbPost.mockResolvedValueOnce({ success: false });
    const fake = db([asset()]);
    m.fbGet.mockResolvedValue({ id: "555", status: "ACTIVE" });

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);
    expect(m.fbPost).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("deferred");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeNull();
  });

  it.each([
    ["the read", "meta_ads_query_failed", { graph_subcode: 33 }],
    ["the read (subcode key)", "meta_ads_query_failed", { subcode: 33 }],
    ["the pause write", "meta_ads_write_failed", { graph_subcode: 33 }],
  ])("graph code 100 / subcode 33 on %s is gone and stamped", async (where, code, sub) => {
    const fake = db([asset()]);
    const err = graph(code, { http_status: 400, graph_code: 100, ...sub });
    if (where.startsWith("the read")) m.fbGet.mockRejectedValue(err);
    else {
      m.fbGet.mockResolvedValue({ id: "555", status: "ACTIVE" });
      m.metaSetStatus.mockRejectedValueOnce(err);
    }

    const outcome = await pauseExpiredLibraryAd(fake.tables.creator_library_assets[0] as LibraryAdRow);
    expect(outcome).toBe("gone");
    expect(fake.tables.creator_library_assets[0].meta_auto_paused_at).toBeTruthy();
  });
});

describe("the */15 sweep", () => {
  it("claims only rows that are due, have an ad, and are not already stamped", async () => {
    const fake = db([
      asset({ id: "due", rights_end_at: PAST }),
      asset({ id: "not-due", rights_end_at: FUTURE }),
      asset({ id: "no-ad", meta_ad_id: null }),
      asset({ id: "done", meta_auto_paused_at: "2026-02-01T00:00:00.000Z" }),
    ]);
    m.fbGet.mockResolvedValue({ id: "555", status: "PENDING_REVIEW" });

    const out = await runRightsExpirySweepHandler(logger);

    expect(out.claimed).toBe(1);
    expect(out.paused).toBe(1);
    const byId = Object.fromEntries(
      fake.tables.creator_library_assets.map((r) => [r.id, r.meta_auto_paused_at]),
    );
    expect(byId.due).toBeTruthy();
    expect(byId["not-due"]).toBeNull();
    expect(byId["no-ad"]).toBeNull();
  });

  it("running the sweep twice pauses once and then goes quiet", async () => {
    db([asset({ id: "due" })]);
    m.fbGet.mockResolvedValue({ id: "555", status: "PENDING_REVIEW" });

    const first = await runRightsExpirySweepHandler(logger);
    const second = await runRightsExpirySweepHandler(logger);

    expect(first.paused).toBe(1);
    expect(second.claimed).toBe(0);
    expect(m.metaSetStatus).toHaveBeenCalledTimes(1);
  });
});
