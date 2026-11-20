
import { fbGet, fbPost } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertGraphWriteSucceeded } from "./_helpers";
import { nameHasTag, shapeLaunchCreativeRequest, taggedName } from "./_launch-shapers";
import { shapeUploadLibraryVideoRequest } from "./_library-ad-shapers";
import { resolveMetaAdCapability } from "./_library-ad-capability";
import { capabilityRefusal } from "./create_library_ad";
import { resolveCreativeMedia } from "./launch";
import { safeFetchImage } from "@/services/media-router/vendors/safe-fetch";
import type { CreateCreativeBody, UpdateCreativeBody, UploadAssetBody } from "./_decision-bodies";

function sameAccount(a: unknown, ours: string): boolean {
  return typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");
}

export async function metaCreateCreative(
  tenant_id: string,
  p: CreateCreativeBody & { tag: string },
): Promise<{ id: string; name: string; reused: boolean }> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw capabilityRefusal(cap);
  const name = taggedName(p.name, p.tag);

  const found = (await fbGet(tenant_id, `${cap.ad_account_id}/adcreatives`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: p.tag }]),
    limit: 10,
  })) as { data?: Array<{ id?: string; name?: string }> };
  const mine = (found.data ?? []).find((c) => c.id && nameHasTag(c.name, p.tag));
  if (mine?.id) return { id: mine.id, name: mine.name ?? name, reused: true };

  const media = p.image_hash
    ? { image_hash: p.image_hash }
    : await resolveCreativeMedia(tenant_id, cap.ad_account_id, {
        image_url: p.image_url,
        video_asset_id: p.video_asset_id,
        source_ad_id: p.source_ad_id,
      });
  const req = shapeLaunchCreativeRequest({
    ad_account_id: cap.ad_account_id,
    page_id: cap.page_id,
    name,
    primary_text: p.primary_text,
    headline: p.headline,
    link_url: p.link_url,
    cta: p.cta ?? "LEARN_MORE",
    ...media,
    tag: p.tag,
  });
  const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
  assertGraphWriteSucceeded(r, "ad creative create");
  if (!r.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no creative id");
  return { id: r.id, name, reused: false };
}

export async function metaUpdateCreative(tenant_id: string, p: UpdateCreativeBody): Promise<void> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw capabilityRefusal(cap);
  const c = (await fbGet(tenant_id, p.creative_id, { fields: "id,account_id" })) as { id?: string; account_id?: string };
  if (!c?.id || !sameAccount(c.account_id, cap.ad_account_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", `creative ${p.creative_id} is not in this workspace's ad account; nothing was sent.`);
  }
  assertGraphWriteSucceeded(await fbPost(tenant_id, p.creative_id, { name: p.new_name }), "creative rename");
}

async function downloadImage(url: string): Promise<string> {
  const img = await safeFetchImage(url);
  if (!img) {
    throw new ExpectedToolError(
      "meta_ads_invalid_media",
      "The image could not be downloaded (it must be a public https image under 10MB, with no redirect); nothing was uploaded.",
    );
  }
  return img.bytes.toString("base64");
}

export async function metaUploadAsset(
  tenant_id: string,
  p: UploadAssetBody,
): Promise<{ kind: "image"; hash: string; url: string | null } | { kind: "video"; video_id: string }> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw capabilityRefusal(cap);
  if (p.kind === "video") {
    const req = shapeUploadLibraryVideoRequest({ ad_account_id: cap.ad_account_id, file_url: p.url, name: p.name });
    const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
    if (!r?.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no video id");
    return { kind: "video", video_id: r.id };
  }
  const bytes = await downloadImage(p.url);
  const r = (await fbPost(tenant_id, `${cap.ad_account_id}/adimages`, { bytes, name: p.name })) as {
    images?: Record<string, { hash?: string; url?: string }>;
  };
  const first = r?.images ? Object.values(r.images)[0] : undefined;
  if (!first?.hash) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no image hash");
  return { kind: "image", hash: first.hash, url: first.url ?? null };
}
