import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import type { GadsOperation } from "../../_client";

const flagEnabled = vi.fn(async () => true);
vi.mock("../_flag-check", () => ({ isGoogleAdsWriteEnabled: () => flagEnabled() }));
const capState = { cap: { enabled: true, max_daily_budget_usd: 100 } as unknown, today_total_change_usd: 0 };
vi.mock("../cap-reader", () => ({ readTenantGoogleCapAndToday: vi.fn(async () => capState) }));

const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  artifacts: new Map<string, { id: string; storage_path: string; bucket: string | null; mime: string; filename: string }>(),
  sources: new Map<string, Buffer>(),
  validate: vi.fn(),
  names: vi.fn(async (_t: string): Promise<string[]> => []),
  mutate: vi.fn(async (_t: string, _ops: GadsOperation[], _o?: { validateOnly?: boolean }): Promise<string[]> => []),
}));
const store = () => ({
  upload: async (path: string, b: Buffer) => {
    if (h.objects.has(path)) return { error: { message: "The resource already exists", statusCode: "409" } };
    h.objects.set(path, Buffer.from(b));
    return { error: null };
  },
  download: async (path: string) =>
    h.objects.has(path) ? { data: new Blob([new Uint8Array(h.objects.get(path)!)]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } },
});
const deps = {
  store: store as never,
  readArtifact: async (_t: unknown, by: { id: string } | { filename: string }) =>
    [...h.artifacts.values()].find((a) => ("id" in by ? a.id === by.id : a.filename === by.filename)) ?? null,
  bucket: () => ({
    download: async (path: string) =>
      h.sources.has(path) ? { data: new Blob([new Uint8Array(h.sources.get(path)!)]), error: null } : { data: null, error: { message: "nf" } },
  }),
};
vi.mock("../_ad-images", async () => {
  const actual = await vi.importActual<typeof import("../_ad-images")>("../_ad-images");
  return {
    ...actual,
    readAdImageSource: (tid: never, src: never) => actual.readAdImageSource(tid, src, deps),
    storeAdImage: (tid: never, img: never) => actual.storeAdImage(tid, img, deps),
    loadAdImageBytes: (tid: never, ref: never) => actual.loadAdImageBytes(tid, ref, deps),
  };
});
vi.mock("../_logo", async () => {
  const actual = await vi.importActual<typeof import("../_logo")>("../_logo");
  return {
    ...actual,
    storeLogo: (tid: never, bytes: Buffer) => actual.storeLogo(tid, bytes, { bucket: store as never }),
    loadLogoBytes: (tid: never, ref: never) => actual.loadLogoBytes(tid, ref, { bucket: store as never }),
  };
});
vi.mock("../../_client", async () => {
  const actual = await vi.importActual<typeof import("../../_client")>("../../_client");
  return {
    ...actual,
    gadsGetBudgetGuardFacts: vi.fn(async () => ({ currency_code: "USD", budget_period: null })),
    gadsListCampaignNames: h.names,
    gadsCustomerId: vi.fn(async () => "1234567890"),
    gadsMutateOperations: h.mutate,
  };
});

import { asTenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolContext } from "@/services/tools/types";
import { fitAdImage, readAdImageSource, loadAdImageBytes, MAX_TRIM } from "../_ad-images";
import { createCampaignBodySchema, type CreateCampaignBody } from "../_decision-bodies";
import { shapeCreateCampaignOperations } from "../_request-shapers";
import { googleCreateCampaign, googleValidateCreateCampaign } from "../create_campaign";
import { googleProposePmaxCampaignTool } from "../propose_pmax_campaign";
import { googleProposeNewCampaignTool } from "../propose_new_campaign";
import { gadsChangeRows as googleChangeRows } from "../_change-rows";
import { clearGoogleCurrencyRunCache } from "../_currency-guard";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TID = asTenantId(T);
const RUN = "33333333-3333-4333-8333-333333333333";

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } } }).png().toBuffer();

function addArtifact(id: string, filename: string, bytes: Buffer, tenant = T, bucket: string | null = null) {
  const storage_path = `${tenant}/${RUN}/${filename}`;
  h.artifacts.set(id, { id, storage_path, bucket, mime: "image/png", filename });
  h.sources.set(storage_path, bytes);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearGoogleCurrencyRunCache();
  h.objects.clear();
  h.artifacts.clear();
  h.sources.clear();
  flagEnabled.mockResolvedValue(true);
  h.names.mockResolvedValue([]);
  h.mutate.mockResolvedValue([]);
});

describe("fitAdImage", () => {
  it("a 16:9 render fits the 1.91:1 slot with a small centred trim", async () => {
    const f = await fitAdImage(await png(1280, 720), "landscape");
    expect([f.width, f.height]).toEqual([1200, 628]);
    expect(f.trimmed_pct).toBe(7);
    expect(Math.abs(f.width / f.height - 1.91) / 1.91).toBeLessThan(0.01);
  });

  it("an image already in shape is sent byte for byte", async () => {
    const src = await png(1080, 1080);
    const f = await fitAdImage(src, "square");
    expect(f.bytes.equals(src)).toBe(true);
    expect(f.trimmed_pct).toBe(0);
  });

  it("refuses a crop that would cut a poster's text off, and says what to make", async () => {
    const err = (await fitAdImage(await png(1080, 1350), "square").catch((e) => e)) as { code: string; message: string };
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("google_ads_ad_image_wrong_shape");
    expect(err.message).toMatch(/1:1/);
    expect(MAX_TRIM).toBe(0.1);
    expect((await fitAdImage(await png(1080, 1080), "landscape").catch((e) => e)).code).toBe("google_ads_ad_image_wrong_shape");
  });

  it("refuses an image below Google's minimum, and one that is not an image", async () => {
    expect((await fitAdImage(await png(200, 200), "square").catch((e) => e)).code).toBe("google_ads_ad_image_too_small");
    expect((await fitAdImage(Buffer.from("not an image"), "square").catch((e) => e)).code).toBe("google_ads_ad_image_invalid");
  });

  it("scales a large image down to Google's recommended size", async () => {
    const f = await fitAdImage(await png(2400, 2400), "logo");
    expect([f.width, f.height]).toEqual([1200, 1200]);
  });
});

describe("readAdImageSource is bound to the tenant", () => {
  it("reads an artifact by id or by file name", async () => {
    const bytes = await png(1080, 1080);
    addArtifact("a1", "social-1-scrim.png", bytes);
    expect((await readAdImageSource(TID, { artifact_id: "a1" }, deps)).bytes.equals(bytes)).toBe(true);
    const byName = await readAdImageSource(TID, { filename: "social-1-scrim.png" }, deps);
    expect(byName.artifact_id).toBe("a1");
  });

  it("another tenant's artifact, an unlisted bucket and a missing id all read as not found", async () => {
    addArtifact("x1", "x.png", await png(400, 400), OTHER);
    addArtifact("b1", "b.png", await png(400, 400), T, "some-other-bucket");
    for (const id of ["x1", "b1", "missing"]) {
      const err = (await readAdImageSource(TID, { artifact_id: id }, deps).catch((e) => e)) as { code: string; message: string };
      expect(err.code).toBe("google_ads_ad_image_not_found");
    }
  });

  it("refuses an uploaded image path outside the tenant before any download", async () => {
    const err = (await readAdImageSource(TID, { image_path: `${OTHER}/44444444-4444-4444-8444-444444444444.jpg` }, deps).catch((e) => e)) as { code: string; message: string };
    expect(err.code).toBe("google_ads_ad_image_not_found");
  });

  it("a stored image whose bytes changed is refused", async () => {
    const ref = { storage_path: `${T}/images/${"a".repeat(64)}.png`, sha256: "a".repeat(64), mime: "image/png" as const, width: 1, height: 1 };
    h.objects.set(ref.storage_path, Buffer.from("different"));
    expect((await loadAdImageBytes(TID, ref, deps).catch((e) => e)).code).toBe("google_ads_ad_image_mismatch");
    expect((await loadAdImageBytes(TID, { ...ref, storage_path: `${OTHER}/images/${"a".repeat(64)}.png` }, deps).catch((e) => e)).code).toBe(
      "google_ads_ad_image_mismatch",
    );
  });
});

const ref = (c: string) => ({ storage_path: `${T}/images/${c.repeat(64)}.png`, sha256: c.repeat(64), mime: "image/png" as const, width: 1200, height: 628 });
const LOGO = { storage_path: `${T}/logos/${"f".repeat(64)}.png`, sha256: "f".repeat(64), mime: "image/png" as const, width: 512, height: 512 };

function pmaxBody(over: Record<string, unknown> = {}): CreateCampaignBody {
  return createCampaignBodySchema.parse({
    name: "Hosts PMax",
    channel_type: "PERFORMANCE_MAX",
    daily_budget_usd: 5,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    location_ids: [2840],
    pmax_asset_group: {
      name: "Hosts – assets",
      final_urls: ["https://upcar.example/host"],
      headlines: ["List your car", "Earn from your car", "Host on Upcar"],
      long_headlines: ["List your car on Upcar and earn"],
      descriptions: ["Earn when you are not driving", "Insurance included"],
      business_name: "Upcar",
      landscape_images: [ref("a")],
      square_images: [ref("b")],
      logo: LOGO,
    },
    rationale: "r",
    ...over,
  });
}

describe("PMax body and request shape", () => {
  it("an asset group belongs only to a PERFORMANCE_MAX campaign; an old PMax card without one still parses", () => {
    const pm = pmaxBody().pmax_asset_group;
    expect(createCampaignBodySchema.safeParse({ ...pmaxBody(), channel_type: "SEARCH", pmax_asset_group: pm }).success).toBe(false);
    expect(createCampaignBodySchema.safeParse({ ...pmaxBody(), pmax_asset_group: undefined }).success).toBe(true);
  });

  it("orders every asset before any asset-group link, links brand on the campaign, and keeps the campaign the one switch", () => {
    const data = { logo: "TE9HTw==", images: { ["a".repeat(64)]: "QQ==", ["b".repeat(64)]: "Qg==" } };
    const { ops, asset_group_resource } = shapeCreateCampaignOperations(pmaxBody(), "1234567890", { pmaxData: data });
    const services = ops.map((o) => o.service);
    expect(services.slice(0, 2)).toEqual(["campaignBudgets", "campaigns"]);
    const lastAsset = services.lastIndexOf("assets");
    const group = services.indexOf("assetGroups");
    expect(lastAsset).toBeLessThan(group);
    expect(services.indexOf("assetGroupAssets")).toBeGreaterThan(group);
    expect(services.slice(group + 1).every((s) => s === "assetGroupAssets")).toBe(true);

    const campaign = ops[1] as { create: Record<string, unknown> };
    expect(campaign.create).toMatchObject({ status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: true });
    expect((ops[group] as { create: Record<string, unknown> }).create).toMatchObject({
      resourceName: asset_group_resource,
      status: "ENABLED",
      finalUrls: ["https://upcar.example/host"],
    });
    const brand = ops.filter((o) => o.service === "campaignAssets").map((o) => (o as unknown as { create: { fieldType: string } }).create.fieldType);
    expect(brand.sort()).toEqual(["BUSINESS_NAME", "LOGO"]);
    const fields = ops.filter((o) => o.service === "assetGroupAssets").map((o) => (o as unknown as { create: { fieldType: string } }).create.fieldType);
    expect(fields.filter((f) => f === "HEADLINE")).toHaveLength(3);
    expect(fields).toEqual(expect.arrayContaining(["LONG_HEADLINE", "DESCRIPTION", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE"]));
    expect(fields).not.toContain("BUSINESS_NAME");
    expect(services).toContain("campaignCriteria");
  });

  it("names every IMAGE asset, uniquely, since Google refuses an unnamed one", () => {
    const data = { logo: "TE9HTw==", images: { ["a".repeat(64)]: "QQ==", ["b".repeat(64)]: "Qg==" } };
    const { ops } = shapeCreateCampaignOperations(pmaxBody(), "1234567890", { pmaxData: data });
    const images = ops
      .filter((o) => o.service === "assets")
      .map((o) => (o as unknown as { create: { type?: string; name?: string } }).create)
      .filter((a) => a.type === "IMAGE");
    expect(images.length).toBeGreaterThan(1);
    const names = images.map((a) => a.name ?? "");
    expect(names.every((n) => n.length > 0 && n.length <= 128)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses to build without the image bytes", () => {
    expect(() => shapeCreateCampaignOperations(pmaxBody(), "1234567890")).toThrow(/image bytes/);
  });
});

describe("dry run and create send the same stored bytes", () => {
  it("loads each image and the logo from storage, checked by hash, for both", async () => {
    const land = await fitAdImage(await png(1280, 720), "landscape");
    const sq = await fitAdImage(await png(1080, 1080), "square");
    const { storeAdImage } = await import("../_ad-images");
    const { storeLogo } = await import("../_logo");
    const body = pmaxBody({
      pmax_asset_group: {
        ...pmaxBody().pmax_asset_group!,
        landscape_images: [await storeAdImage(TID, land)],
        square_images: [await storeAdImage(TID, sq)],
        logo: await storeLogo(TID, (await fitAdImage(await png(512, 512), "logo")).bytes),
      },
    });
    h.mutate.mockResolvedValueOnce([]);
    await googleValidateCreateCampaign(T, body);
    const results = ["customers/1/campaignBudgets/1", "customers/1/campaigns/2"];
    h.mutate.mockImplementationOnce(async (_t, ops) => ops.map((o, i) => results[i] ?? (o.service === "assetGroups" ? "customers/1/assetGroups/77" : "x")));
    const created = await googleCreateCampaign(T, body);
    const [dry, real] = h.mutate.mock.calls;
    expect(dry[2]).toEqual({ validateOnly: true });
    expect(JSON.stringify(real[1])).toBe(JSON.stringify(dry[1]));
    expect(created).toMatchObject({ campaign_id: "2", asset_group_id: "77" });
  });
});

describe("the approval card", () => {
  it("names the asset group, its images, copy and brand", () => {
    const card = googleChangeRows("google_ads.create_campaign", pmaxBody());
    expect(card?.title).toBe("Create the Performance Max campaign “Hosts PMax”");
    const rows = Object.fromEntries((card?.rows ?? []).map((r) => [r.item, r.after]));
    expect(rows).toMatchObject({ Type: "Performance Max", "Asset group": "Hosts – assets", Images: "1 landscape, 1 square", Brand: "Upcar, square logo 512x512" });
  });
});

function makeCtx() {
  const emit = vi.fn(async (_cls: string, _body: unknown) => "decision-1");
  const ctx: ToolContext = { tenant_id: T, log: () => {}, emit_decision: emit };
  return { ctx, emit };
}

const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S1 = "aaaaaaaa-0000-4000-8000-000000000002";
const L1 = "aaaaaaaa-0000-4000-8000-000000000003";

const toolInput = (over: Record<string, unknown> = {}) => ({
  name: "Hosts PMax",
  daily_budget_usd: 5,
  final_url: "https://upcar.example/host",
  headlines: ["List your car", "Earn from your car", "Host on Upcar"],
  long_headlines: ["List your car on Upcar and earn"],
  descriptions: ["Earn when you are not driving", "Insurance included"],
  business_name: "Upcar",
  landscape_images: [{ artifact_id: A1 }],
  square_images: [{ filename: "social-2-square.png" }],
  logo: { artifact_id: L1 },
  location_ids: [2840],
  rationale: "Host supply is the constraint",
  ...over,
});

describe("google_ads_propose_pmax_campaign", () => {
  beforeEach(async () => {
    addArtifact(A1, "social-1-wide.png", await png(1280, 720));
    addArtifact(S1, "social-2-square.png", await png(1080, 1080));
    addArtifact(L1, "logo.png", await png(512, 512));
  });

  it("happy path: images fitted and stored, Google dry-runs the exact body, then one create card", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await googleProposePmaxCampaignTool.execute(ctx, toolInput())) as Record<string, unknown>;
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true });
    expect(emit).toHaveBeenCalledTimes(1);
    const [cls, body] = emit.mock.calls[0] as [string, CreateCampaignBody];
    expect(cls).toBe("google_ads.create_campaign");
    expect(body.channel_type).toBe("PERFORMANCE_MAX");
    expect(body.pmax_asset_group?.landscape_images[0]).toMatchObject({ width: 1200, height: 628 });
    expect(body.pmax_asset_group?.square_images[0].storage_path.startsWith(`${T}/images/`)).toBe(true);
    expect(out).toMatchObject({ campaign_type: "PERFORMANCE_MAX" });
    expect("will_auto_apply" in out).toBe(false);
    expect(out.images).toEqual(expect.arrayContaining([expect.objectContaining({ slot: "landscape", artifact_id: A1, trimmed_pct: 7 })]));
  });

  it("a square poster offered as the landscape image files nothing and says to make a 16:9 one", async () => {
    const { ctx, emit } = makeCtx();
    const err = (await googleProposePmaxCampaignTool.execute(ctx, toolInput({ landscape_images: [{ artifact_id: S1 }] })).catch((e) => e)) as { code: string; message: string };
    expect(err.code).toBe("google_ads_ad_image_wrong_shape");
    expect(emit).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("a Google dry-run refusal files nothing", async () => {
    h.mutate.mockRejectedValueOnce(new ExpectedToolError("google_ads_mutate_failed", "Google Ads googleAds:mutate failed: 400 {}"));
    const { ctx, emit } = makeCtx();
    const err = (await googleProposePmaxCampaignTool.execute(ctx, toolInput()).catch((e) => e)) as { code: string; message: string };
    expect(err.code).toBe("google_ads_create_rejected");
    expect(err.message).toMatch(/Performance Max/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("over the tenant ceiling is refused before any image is read", async () => {
    const { ctx } = makeCtx();
    const err = (await googleProposePmaxCampaignTool.execute(ctx, toolInput({ daily_budget_usd: 500 })).catch((e) => e)) as { code: string; message: string };
    expect(err.code).toBe("google_ads_proposal_over_absolute_cap");
    expect(h.objects.size).toBe(0);
  });

  it("propose_new_campaign sends PERFORMANCE_MAX here instead of filing an empty shell", async () => {
    const { ctx, emit } = makeCtx();
    const err = (await googleProposeNewCampaignTool
      .execute(ctx, { name: "p", channel_type: "PERFORMANCE_MAX", daily_budget_usd: 5, bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, rationale: "r" })
      .catch((e) => e)) as { code: string; message: string };
    expect(err.code).toBe("google_ads_pmax_use_pmax_tool");
    expect(emit).not.toHaveBeenCalled();
  });
});
