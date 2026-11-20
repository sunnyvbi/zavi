
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({
  fbGet: vi.fn(),
  fbPost: vi.fn(),
  metaAdsCreds: vi.fn(),
}));

vi.mock("../../_client", () => ({
  fbGet: m.fbGet,
  fbPost: m.fbPost,
  metaAdsCreds: m.metaAdsCreds,
}));

import { ExpectedToolError } from "@/services/tools/types";
import {
  LIBRARY_AD_STATUS,
  pickThumbnailUri,
  readVideoProcessingState,
  shapeLibraryAdCreativeRequest,
  shapeLibraryAdRequest,
  shapeUploadLibraryVideoRequest,
} from "../_library-ad-shapers";
import { resolveMetaAdCapability } from "../_library-ad-capability";
import { metaCreateLibraryAd } from "../create_library_ad";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "act_1234567890";

beforeEach(() => {
  vi.clearAllMocks();
  m.metaAdsCreds.mockResolvedValue({ access_token: "tok", ad_account_id: ACCOUNT });
});

describe("shapers", () => {
  it("uploads by https URL to the account's advideos edge", () => {
    const r = shapeUploadLibraryVideoRequest({
      ad_account_id: ACCOUNT,
      file_url: "https://signed.example/v.mp4",
      name: "Zavi creator zavi-cr-abc",
    });
    expect(r.path).toBe(`${ACCOUNT}/advideos`);
    expect(r.params.file_url).toBe("https://signed.example/v.mp4");
    expect(r.params.title).toBe("Zavi creator zavi-cr-abc");
  });

  it("refuses a non-https video URL", () => {
    expect(() =>
      shapeUploadLibraryVideoRequest({
        ad_account_id: ACCOUNT,
        file_url: "http://signed.example/v.mp4",
        name: "x",
      }),
    ).toThrow(ExpectedToolError);
  });

  it("builds a video creative with the page, the video and a thumbnail", () => {
    const r = shapeLibraryAdCreativeRequest({
      ad_account_id: ACCOUNT,
      page_id: "9988",
      video_id: "777",
      thumbnail_url: "https://thumb.example/t.jpg",
      name: "Zavi creator",
      message: "Try it",
      tracking_tag: "zavi-cr-abc123",
    });
    expect(r.path).toBe(`${ACCOUNT}/adcreatives`);
    expect(JSON.parse(r.params.object_story_spec)).toEqual({
      page_id: "9988",
      video_data: { video_id: "777", image_url: "https://thumb.example/t.jpg", message: "Try it" },
    });
    expect(r.params.url_tags).toContain("utm_campaign=zavi-cr-abc123");
  });

  it("refuses a creative with no page and with no thumbnail", () => {
    const base = {
      ad_account_id: ACCOUNT,
      video_id: "777",
      thumbnail_url: "https://thumb.example/t.jpg",
      name: "n",
    };
    expect(() => shapeLibraryAdCreativeRequest({ ...base, page_id: "" })).toThrow(ExpectedToolError);
    expect(() =>
      shapeLibraryAdCreativeRequest({ ...base, page_id: "9988", thumbnail_url: "" }),
    ).toThrow(ExpectedToolError);
  });

  it("ALWAYS shapes the ad as PAUSED and never as anything else", () => {
    const r = shapeLibraryAdRequest({
      ad_account_id: ACCOUNT,
      ad_set_id: "6543",
      creative_id: "321",
      name: "Zavi creator",
    });
    expect(r.path).toBe(`${ACCOUNT}/ads`);
    expect(r.params.status).toBe("PAUSED");
    expect(r.params.status).not.toBe("ACTIVE");
    expect(r.params.adset_id).toBe("6543");
    expect(JSON.parse(r.params.creative)).toEqual({ creative_id: "321" });
    expect(LIBRARY_AD_STATUS).toBe("PAUSED");
  });

  it("refuses to create an ad without an ad set (so it can never make a budget)", () => {
    expect(() =>
      shapeLibraryAdRequest({ ad_account_id: ACCOUNT, ad_set_id: "  ", creative_id: "321", name: "n" }),
    ).toThrow(ExpectedToolError);
  });

  it("reads the video processing state and picks the preferred thumbnail", () => {
    expect(readVideoProcessingState({ status: { video_status: "ready" } })).toBe("ready");
    expect(readVideoProcessingState({ status: { video_status: "processing" } })).toBe("processing");
    expect(readVideoProcessingState({})).toBe("unknown");
    expect(
      pickThumbnailUri({ data: [{ uri: "a" }, { uri: "b", is_preferred: true }] }),
    ).toBe("b");
    expect(pickThumbnailUri({ data: [] })).toBeNull();
    expect(pickThumbnailUri(null)).toBeNull();
  });
});

function graphOk(over: Partial<Record<string, unknown>> = {}) {
  m.fbGet.mockImplementation(async (_t: string, path: string) => {
    if (path === ACCOUNT) return over.account ?? { account_status: 1, user_tasks: ["MANAGE"] };
    if (path === "me/permissions") {
      return (
        over.permissions ?? {
          data: [
            { permission: "ads_management", status: "granted" },
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_manage_ads", status: "granted" },
          ],
        }
      );
    }
    if (path === `${ACCOUNT}/promote_pages`) {
      return over.pages ?? { data: [{ id: "9988", name: "Acme" }] };
    }
    if (path === `${ACCOUNT}/adsets`) {
      return over.adsets ?? { data: [{ id: "6543", name: "Prospecting", status: "PAUSED" }] };
    }
    return {};
  });
}

describe("resolveMetaAdCapability", () => {
  it("resolves the page and the ad sets when everything is in place", async () => {
    graphOk();
    const cap = await resolveMetaAdCapability(TENANT);
    expect(cap).toMatchObject({ ok: true, page_id: "9988", ad_account_id: ACCOUNT });
    if (cap.ok) expect(cap.ad_sets).toEqual([{ id: "6543", name: "Prospecting", status: "PAUSED" }]);
  });

  it("blocks with connector_missing when Meta is not connected", async () => {
    m.metaAdsCreds.mockRejectedValue(new ExpectedToolError("meta_ads_not_connected", "nope"));
    const cap = await resolveMetaAdCapability(TENANT);
    expect(cap).toMatchObject({ ok: false, reason_code: "connector_missing" });
  });

  it("blocks with account_not_writable on a disabled account", async () => {
    graphOk({ account: { account_status: 2, user_tasks: ["MANAGE"] } });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({
      ok: false,
      reason_code: "account_not_writable",
    });
  });

  it("blocks with account_not_writable when the login only has read tasks", async () => {
    graphOk({ account: { account_status: 1, user_tasks: ["ANALYZE"] } });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({
      ok: false,
      reason_code: "account_not_writable",
    });
  });

  it("a permission error on an ad-account read is account_not_writable, not a Page problem", async () => {
    const revoked = () => new ExpectedToolError("meta_ads_permission_revoked", "role gone");
    graphOk();
    const base = m.fbGet.getMockImplementation()!;
    m.fbGet.mockImplementation(async (t: string, path: string, q?: unknown) => {
      if (path === ACCOUNT) throw revoked();
      return base(t, path, q);
    });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "account_not_writable" });

    m.fbGet.mockImplementation(async (t: string, path: string, q?: unknown) => {
      if (path === `${ACCOUNT}/adsets`) throw revoked();
      return base(t, path, q);
    });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "account_not_writable" });

    m.fbGet.mockImplementation(async (t: string, path: string, q?: unknown) => {
      if (path === `${ACCOUNT}/promote_pages`) throw revoked();
      return base(t, path, q);
    });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "page_permission_missing" });
  });

  it("blocks with page_permission_missing when the Page scope is not granted", async () => {
    graphOk({
      permissions: {
        data: [
          { permission: "ads_management", status: "granted" },
          { permission: "pages_show_list", status: "declined" },
        ],
      },
    });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({
      ok: false,
      reason_code: "page_permission_missing",
    });
  });

  it("blocks with no_page when the account can promote none", async () => {
    graphOk({ pages: { data: [] } });
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "no_page" });
  });

  it("never throws: a Graph outage is a block, not an exception", async () => {
    m.fbGet.mockRejectedValue(new Error("graph exploded"));
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({
      ok: false,
      reason_code: "lookup_failed",
    });
  });

  it("an expired token and a rate limit each name themselves, not lookup_failed", async () => {
    m.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired", "expired"));
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "token_expired" });
    m.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_busy", "busy"));
    expect(await resolveMetaAdCapability(TENANT)).toMatchObject({ ok: false, reason_code: "meta_busy" });
  });

  it("gives every block reason an honest sentence with no dashes", async () => {
    const { BLOCK_REASON_TEXT } = await import("../_library-ad-capability");
    for (const [code, text] of Object.entries(BLOCK_REASON_TEXT)) {
      expect(text.length, code).toBeGreaterThan(30);
      expect(text, code).not.toMatch(/[—–]|--/);
    }
  });
});

function graphWriteOk() {
  m.fbGet.mockImplementation(async (_t: string, path: string) => {
    if (path === ACCOUNT) return { account_status: 1, user_tasks: ["MANAGE"] };
    if (path === "me/permissions") {
      return {
        data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "pages_manage_ads", status: "granted" },
        ],
      };
    }
    if (path === `${ACCOUNT}/promote_pages`) return { data: [{ id: "9988", name: "Acme" }] };
    if (path === `${ACCOUNT}/adsets`) return { data: [{ id: "6543", name: "Prospecting" }] };
    if (path === "777") return { status: { video_status: "ready" } };
    if (path === "777/thumbnails") return { data: [{ uri: "https://t/1.jpg", is_preferred: true }] };
    return {};
  });
  m.fbPost.mockImplementation(async (_t: string, path: string) => {
    if (path.endsWith("/advideos")) return { id: "777" };
    if (path.endsWith("/adcreatives")) return { id: "321" };
    if (path.endsWith("/ads")) return { id: "555" };
    return {};
  });
}

describe("metaCreateLibraryAd", () => {
  const input = {
    ad_set_id: "6543",
    video_url: "https://signed.example/v.mp4",
    name: "Zavi creator zavi-cr-abc",
    tracking_tag: "zavi-cr-abc",
  };

  it("creates the ad PAUSED and passes that exact status to Graph", async () => {
    graphWriteOk();
    const out = await metaCreateLibraryAd(TENANT, input, { sleep: async () => {} });

    expect(out).toMatchObject({ video_id: "777", creative_id: "321", ad_id: "555", status: "PAUSED" });

    const adCall = m.fbPost.mock.calls.find((c) => String(c[1]).endsWith("/ads"));
    expect(adCall).toBeTruthy();
    const params = adCall![2] as Record<string, string>;
    expect(params.status).toBe("PAUSED");
    expect(params.status).not.toBe("ACTIVE");
    expect(m.fbPost.mock.calls.map((c) => String(c[1]))).not.toContain(`${ACCOUNT}/campaigns`);
    expect(m.fbPost.mock.calls.map((c) => String(c[1]))).not.toContain(`${ACCOUNT}/adsets`);
  });

  it("tells the caller the video id as soon as Meta returns one, before the encode wait", async () => {
    graphWriteOk();
    const seen: string[] = [];
    await metaCreateLibraryAd(TENANT, input, {
      sleep: async () => {},
      onVideoUploaded: async (id) => {
        seen.push(id);
      },
    });
    expect(seen).toEqual(["777"]);
  });

  it("reuses an already-uploaded video instead of uploading it twice", async () => {
    graphWriteOk();
    await metaCreateLibraryAd(TENANT, { ...input, resume_video_id: "777" }, { sleep: async () => {} });
    expect(m.fbPost.mock.calls.filter((c) => String(c[1]).endsWith("/advideos"))).toHaveLength(0);
  });

  it("refuses and writes NOTHING when the connector is missing", async () => {
    m.metaAdsCreds.mockRejectedValue(new ExpectedToolError("meta_ads_not_connected", "nope"));
    await expect(metaCreateLibraryAd(TENANT, input, { sleep: async () => {} })).rejects.toThrow(
      /meta|connect/i,
    );
    expect(m.fbPost).not.toHaveBeenCalled();
  });

  it("refuses and writes NOTHING when no Page resolves", async () => {
    graphWriteOk();
    m.fbGet.mockImplementation(async (_t: string, path: string) => {
      if (path === ACCOUNT) return { account_status: 1, user_tasks: ["MANAGE"] };
      if (path === "me/permissions") {
        return {
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_manage_ads", status: "granted" },
          ],
        };
      }
      if (path === `${ACCOUNT}/promote_pages`) return { data: [] };
      return {};
    });
    await expect(
      metaCreateLibraryAd(TENANT, input, { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "meta_ads_no_page" });
    expect(m.fbPost).not.toHaveBeenCalled();
  });

  it("refuses and writes NOTHING when the Page permission is not granted", async () => {
    m.fbGet.mockImplementation(async (_t: string, path: string) => {
      if (path === ACCOUNT) return { account_status: 1, user_tasks: ["MANAGE"] };
      if (path === "me/permissions") return { data: [{ permission: "ads_management", status: "granted" }] };
      return {};
    });
    await expect(
      metaCreateLibraryAd(TENANT, input, { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "meta_ads_page_permission_missing" });
    expect(m.fbPost).not.toHaveBeenCalled();
  });

  it("stops before the creative when Meta returns no thumbnail", async () => {
    graphWriteOk();
    const base = m.fbGet.getMockImplementation()!;
    m.fbGet.mockImplementation(async (t: string, path: string, p: unknown) => {
      if (path === "777/thumbnails") return { data: [] };
      return base(t, path, p);
    });
    await expect(
      metaCreateLibraryAd(TENANT, input, { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "meta_ads_video_thumbnail_missing" });
    expect(m.fbPost.mock.calls.filter((c) => String(c[1]).endsWith("/adcreatives"))).toHaveLength(0);
  });

  it("stops when Meta says the video failed to process", async () => {
    graphWriteOk();
    const base = m.fbGet.getMockImplementation()!;
    m.fbGet.mockImplementation(async (t: string, path: string, p: unknown) => {
      if (path === "777") return { status: { video_status: "error" } };
      return base(t, path, p);
    });
    await expect(
      metaCreateLibraryAd(TENANT, input, { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "meta_ads_video_processing_failed" });
    expect(m.fbPost.mock.calls.filter((c) => String(c[1]).endsWith("/ads"))).toHaveLength(0);
  });
});

describe("no live ad status anywhere in the slice", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
  const FILES = [
    "src/services/tools/meta-ads/write/_library-ad-shapers.ts",
    "src/services/tools/meta-ads/write/_library-ad-capability.ts",
    "src/services/tools/meta-ads/write/create_library_ad.ts",
    "src/routes/creators/library.ts",
    "src/services/creators/library.ts",
    "workers/functions/creator-rights-expiry.ts",
  ];

  const LIVE_STATUS_LITERAL = /(['"`])ACTIVE\1/;

  it.each(FILES)("%s never writes the live status", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).not.toMatch(LIVE_STATUS_LITERAL);
  });

  it("the web surface never sends a status either", () => {
    const web = readFileSync(
      join(ROOT, "..", "web", "src", "components", "humans", "CreatorLibraryIsland.tsx"),
      "utf8",
    );
    expect(web).not.toMatch(LIVE_STATUS_LITERAL);
    expect(web).not.toMatch(/status:\s*["'`]/);
  });

  it("proves the regex would catch a live status if one were added", () => {
    expect('status: "ACTIVE"').toMatch(LIVE_STATUS_LITERAL);
    expect("// account_status 1 = ACTIVE").not.toMatch(LIVE_STATUS_LITERAL);
  });
});
