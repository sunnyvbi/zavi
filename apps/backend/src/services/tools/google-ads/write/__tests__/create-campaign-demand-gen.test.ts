import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import type { GadsOperation } from "../../_client";

const client = vi.hoisted(() => ({
  names: vi.fn(async (_t: string): Promise<string[]> => []),
  customer: vi.fn(async (_t: string): Promise<string> => "1234567890"),
  mutate: vi.fn(async (_t: string, _ops: GadsOperation[], _o?: { validateOnly?: boolean }): Promise<string[]> => []),
}));
vi.mock("../../_client", async () => {
  const actual = await vi.importActual<typeof import("../../_client")>("../../_client");
  return {
    ...actual,
    gadsListCampaignNames: client.names,
    gadsCustomerId: client.customer,
    gadsMutateOperations: client.mutate,
  };
});

import { googleAdsErrorPairs } from "../../_client";
import { googleCreateCampaign, googleValidateCreateCampaign } from "../create_campaign";
import { createCampaignBodySchema } from "../_decision-bodies";
import type { LogoRef } from "../_logo";

const T = "11111111-1111-4111-8111-111111111111";
const SHA = "d".repeat(64);
const LOGO: LogoRef = { storage_path: `${T}/logos/${SHA}.png`, sha256: SHA, mime: "image/png", width: 256, height: 256 };
const BYTES = Buffer.from("the stored logo bytes");

const body = createCampaignBodySchema.parse({
  name: "YT launch",
  channel_type: "DEMAND_GEN",
  daily_budget_usd: 30,
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  demand_gen_ad_group: {
    name: "YT launch – video",
    ad: {
      final_urls: ["https://example.com"],
      youtube_video_ids: ["dQw4w9WgXcQ"],
      headlines: ["Book a car"],
      long_headlines: ["Book a car near you"],
      descriptions: ["Cars from local hosts"],
      business_name: "Upcar",
      logo: LOGO,
    },
  },
  rationale: "r",
});

const loadLogo = vi.fn(async (_tid: string, _ref: LogoRef) => ({ bytes: BYTES, base64: BYTES.toString("base64") }));
const imageData = (ops: GadsOperation[]) =>
  ops.flatMap((o) => ("create" in o && o.create.imageAsset ? [(o.create.imageAsset as { data: string }).data] : []));

beforeEach(() => {
  vi.clearAllMocks();
  client.names.mockResolvedValue([]);
  client.mutate.mockResolvedValue([]);
});

describe("Demand Gen create: the dry run and the create send the same stored bytes", () => {
  it("validate loads the logo by ref and asks Google for validateOnly", async () => {
    await googleValidateCreateCampaign(T, body, { loadLogo });
    expect(loadLogo).toHaveBeenCalledTimes(1);
    expect(loadLogo.mock.calls[0][0]).toBe(T);
    expect(loadLogo.mock.calls[0][1]).toEqual(LOGO);
    expect(client.mutate).toHaveBeenCalledTimes(1);
    expect(client.mutate.mock.calls[0][2]).toEqual({ validateOnly: true });
    expect(imageData(client.mutate.mock.calls[0][1])).toEqual([BYTES.toString("base64")]);
  });

  it("create loads the same ref once and sends the same bytes, for real", async () => {
    client.mutate.mockImplementation(async (_t, ops) =>
      ops.map((o, i) => (o.service === "campaigns" ? "customers/1234567890/campaigns/555" : o.service === "adGroups" ? "customers/1234567890/adGroups/556" : `r${i}`)),
    );
    const r = await googleCreateCampaign(T, body, { loadLogo });
    expect(loadLogo).toHaveBeenCalledTimes(1);
    expect(client.mutate.mock.calls[0][2]).toBeUndefined();
    expect(imageData(client.mutate.mock.calls[0][1])).toEqual([BYTES.toString("base64")]);
    expect(r).toMatchObject({ campaign_id: "555", ad_group_id: "556" });
  });

  it("a name already in the account refuses before any logo read or Google call", async () => {
    client.names.mockResolvedValue(["YT launch"]);
    await expect(googleValidateCreateCampaign(T, body, { loadLogo })).rejects.toMatchObject({ code: "google_ads_campaign_name_exists" });
    expect(loadLogo).not.toHaveBeenCalled();
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("a logo mismatch stops the request from being built", async () => {
    const bad = vi.fn(async () => {
      throw new ExpectedToolError("google_ads_demand_gen_logo_mismatch", "changed");
    });
    await expect(googleCreateCampaign(T, body, { loadLogo: bad })).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_mismatch" });
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("Google's dry-run refusal becomes google_ads_demand_gen_rejected with code: message pairs", async () => {
    const googleBody = JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
            errors: [
              { errorCode: { assetError: "YOUTUBE_VIDEO_NOT_FOUND" }, message: "The YouTube video was not found." },
              { errorCode: { imageError: "ASPECT_RATIO_NOT_ALLOWED" }, message: "The aspect ratio is not allowed." },
            ],
          },
        ],
      },
    });
    client.mutate.mockRejectedValue(new ExpectedToolError("google_ads_mutate_failed", `Google Ads googleAds:mutate failed: 400 ${googleBody}`));
    const err = await googleValidateCreateCampaign(T, body, { loadLogo }).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("google_ads_demand_gen_rejected");
    expect(err.message).toContain("YOUTUBE_VIDEO_NOT_FOUND: The YouTube video was not found.");
    expect(err.message).toContain("ASPECT_RATIO_NOT_ALLOWED: The aspect ratio is not allowed.");
    expect(err.message).toMatch(/no card was filed/);
  });

  it("a non-refusal failure (timeout, not connected) is passed through unchanged", async () => {
    client.mutate.mockRejectedValue(new ExpectedToolError("google_ads_timeout", "slow"));
    await expect(googleValidateCreateCampaign(T, body, { loadLogo })).rejects.toMatchObject({ code: "google_ads_timeout" });
  });
});

describe("googleAdsErrorPairs", () => {
  it("says where each refusal happened and the value that tripped it", () => {
    const body = JSON.stringify({
      error: {
        details: [
          {
            errors: [
              {
                errorCode: { mutateError: "RESOURCE_NOT_FOUND" },
                message: "Resource was not found.",
                trigger: { stringValue: "geoTargetConstants/99999999" },
                location: {
                  fieldPathElements: [
                    { fieldName: "mutate_operations", index: 3 },
                    { fieldName: "ad_group_criterion_operation" },
                    { fieldName: "create" },
                    { fieldName: "location" },
                  ],
                },
              },
              { errorCode: { assetError: "NAME_REQUIRED_FOR_ASSET_TYPE" }, message: "Name is required for this asset type." },
            ],
          },
        ],
      },
    });
    expect(googleAdsErrorPairs(body)).toEqual([
      "RESOURCE_NOT_FOUND: Resource was not found. (at mutate_operations[3].ad_group_criterion_operation.create.location, value geoTargetConstants/99999999)",
      "NAME_REQUIRED_FOR_ASSET_TYPE: Name is required for this asset type.",
    ]);
  });

  it("falls back to the status message, then to the trimmed body, and never throws", () => {
    expect(googleAdsErrorPairs(JSON.stringify({ error: { message: "Bad" } }))).toEqual(["Bad"]);
    expect(googleAdsErrorPairs("<html>gateway</html>")).toEqual(["<html>gateway</html>"]);
    expect(googleAdsErrorPairs("")).toEqual([]);
  });
});
