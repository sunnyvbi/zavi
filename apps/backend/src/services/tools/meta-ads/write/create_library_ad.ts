
import { fbGet, fbPost } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertGraphWriteSucceeded } from "./_helpers";
import {
  LIBRARY_AD_STATUS,
  pickThumbnailUri,
  readVideoProcessingState,
  shapeLibraryAdCreativeRequest,
  shapeLibraryAdRequest,
  shapeUploadLibraryVideoRequest,
} from "./_library-ad-shapers";
import { resolveMetaAdCapability, type MetaAdCapability } from "./_library-ad-capability";

const VIDEO_READY_ATTEMPTS = 20;
const VIDEO_READY_INTERVAL_MS = 3_000;

export type CreateLibraryAdInput = {
  ad_set_id: string;
  video_url: string;
  name: string;
  message?: string;
  tracking_tag?: string;
  resume_video_id?: string;
};

export type CreateLibraryAdResult = {
  ad_account_id: string;
  page_id: string;
  video_id: string;
  creative_id: string;
  ad_id: string;
  status: typeof LIBRARY_AD_STATUS;
};

export function capabilityRefusal(cap: Extract<MetaAdCapability, { ok: false }>): ExpectedToolError {
  return new ExpectedToolError(`meta_ads_${cap.reason_code}`, cap.reason, {
    next_step: "operator_action",
    reason_code: cap.reason_code,
  });
}

export async function metaCreateLibraryAd(
  tenant_id: string,
  input: CreateLibraryAdInput,
  deps: {
    sleep?: (ms: number) => Promise<void>;
    onVideoUploaded?: (video_id: string, ad_account_id: string) => Promise<void>;
  } = {},
): Promise<CreateLibraryAdResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw capabilityRefusal(cap);

  let video_id = (input.resume_video_id ?? "").trim();
  if (!video_id) {
    const upload = shapeUploadLibraryVideoRequest({
      ad_account_id: cap.ad_account_id,
      file_url: input.video_url,
      name: input.name,
    });
    const uploaded = (await fbPost(tenant_id, upload.path, upload.params)) as {
      id?: string;
      video_id?: string;
    };
    video_id = uploaded.id ?? uploaded.video_id ?? "";
    if (!video_id) {
      throw new ExpectedToolError(
        "meta_ads_write_failed",
        `Meta advideos upload returned no video id: ${JSON.stringify(uploaded).slice(0, 300)}`,
      );
    }
    await deps.onVideoUploaded?.(video_id, cap.ad_account_id);
  }

  await waitForVideoReady(tenant_id, video_id, sleep);

  const thumbs = await fbGet(tenant_id, `${video_id}/thumbnails`, {
    fields: "uri,is_preferred",
    limit: 10,
  });
  const thumbnail_url = pickThumbnailUri(thumbs);
  if (!thumbnail_url) {
    throw new ExpectedToolError(
      "meta_ads_video_thumbnail_missing",
      "Meta finished the video but returned no thumbnail, so the video ad creative cannot be built. Download the video and upload it yourself.",
      { video_id },
    );
  }

  const creativeReq = shapeLibraryAdCreativeRequest({
    ad_account_id: cap.ad_account_id,
    page_id: cap.page_id,
    video_id,
    thumbnail_url,
    name: input.name,
    message: input.message,
    tracking_tag: input.tracking_tag,
  });
  const creativeRes = (await fbPost(tenant_id, creativeReq.path, creativeReq.params)) as {
    id?: string;
  };
  assertGraphWriteSucceeded(creativeRes, "ad creative create");
  const creative_id = creativeRes.id;
  if (!creative_id) {
    throw new ExpectedToolError(
      "meta_ads_write_failed",
      "Meta adcreatives create returned no creative id",
    );
  }

  const adReq = shapeLibraryAdRequest({
    ad_account_id: cap.ad_account_id,
    ad_set_id: input.ad_set_id,
    creative_id,
    name: input.name,
  });
  const adRes = (await fbPost(tenant_id, adReq.path, adReq.params)) as { id?: string };
  assertGraphWriteSucceeded(adRes, "ad create");
  const ad_id = adRes.id;
  if (!ad_id) {
    throw new ExpectedToolError("meta_ads_write_failed", "Meta ads create returned no ad id");
  }

  return {
    ad_account_id: cap.ad_account_id,
    page_id: cap.page_id,
    video_id,
    creative_id,
    ad_id,
    status: LIBRARY_AD_STATUS,
  };
}

async function waitForVideoReady(
  tenant_id: string,
  video_id: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < VIDEO_READY_ATTEMPTS; attempt += 1) {
    const node = await fbGet(tenant_id, video_id, { fields: "status" });
    const state = readVideoProcessingState(node);
    if (state === "ready") return;
    if (state === "error") {
      throw new ExpectedToolError(
        "meta_ads_video_processing_failed",
        "Meta could not process this video. Download it and upload it yourself.",
        { video_id },
      );
    }
    await sleep(VIDEO_READY_INTERVAL_MS);
  }
  throw new ExpectedToolError(
    "meta_ads_video_not_ready",
    "Meta is still processing this video. The upload is saved in the ad account; try Use in Meta Ads again in a few minutes.",
    { video_id },
  );
}
