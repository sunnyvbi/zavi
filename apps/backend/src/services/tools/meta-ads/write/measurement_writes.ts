
import { fbGet, fbPost, metaAdsCreds } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertGraphWriteSucceeded } from "./_helpers";
import { nameHasTag, taggedName } from "./_launch-shapers";
import type { CreateCustomConversionBody, CreateLookalikeAudienceBody } from "./_decision-bodies";

function sameAccount(a: unknown, ours: string): boolean {
  return typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");
}

export function shapeLookalikeRequest(input: {
  ad_account_id: string;
  name: string;
  origin_audience_id: string;
  country: string;
  ratio: number;
}): { path: string; params: Record<string, string> } {
  return {
    path: `${input.ad_account_id}/customaudiences`,
    params: {
      name: input.name,
      subtype: "LOOKALIKE",
      origin_audience_id: input.origin_audience_id,
      lookalike_spec: JSON.stringify({ ratio: input.ratio, country: input.country }),
    },
  };
}

export function shapeCustomConversionRequest(input: {
  ad_account_id: string;
  name: string;
  pixel_id: string;
  custom_event_type: string;
  url_contains: string;
}): { path: string; params: Record<string, string> } {
  return {
    path: `${input.ad_account_id}/customconversions`,
    params: {
      name: input.name,
      pixel_id: input.pixel_id,
      event_source_id: input.pixel_id,
      custom_event_type: input.custom_event_type,
      rule: JSON.stringify({ url: { i_contains: input.url_contains } }),
    },
  };
}

export async function metaCreateLookalikeAudience(
  tenant_id: string,
  p: CreateLookalikeAudienceBody & { tag: string },
): Promise<{ id: string; name: string; reused: boolean }> {
  const creds = await metaAdsCreds(tenant_id);
  const src = (await fbGet(tenant_id, p.origin_audience_id, { fields: "id,account_id,name" })) as { id?: string; account_id?: string; name?: string };
  if (!src?.id || !sameAccount(src.account_id, creds.ad_account_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", `audience ${p.origin_audience_id} is not in this workspace's ad account; nothing was sent.`);
  }
  const base = p.name ?? `Zavi · Lookalike ${Math.round(p.ratio * 100)}% ${p.country} of ${src.name ?? p.origin_audience_id}`;
  const name = taggedName(base, p.tag);
  const list = (await fbGet(tenant_id, `${creds.ad_account_id}/customaudiences`, { fields: "id,name", limit: 200 })) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  const mine = (list.data ?? []).find((a) => a.id && nameHasTag(a.name, p.tag));
  if (mine?.id) return { id: mine.id, name: mine.name ?? name, reused: true };
  const req = shapeLookalikeRequest({ ad_account_id: creds.ad_account_id, name, origin_audience_id: p.origin_audience_id, country: p.country, ratio: p.ratio });
  const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
  assertGraphWriteSucceeded(r, "lookalike audience create");
  if (!r.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no audience id");
  return { id: r.id, name, reused: false };
}

export async function metaCreateCustomConversion(
  tenant_id: string,
  p: CreateCustomConversionBody & { tag: string },
): Promise<{ id: string; name: string; reused: boolean }> {
  const creds = await metaAdsCreds(tenant_id);
  const px = (await fbGet(tenant_id, `${creds.ad_account_id}/adspixels`, { fields: "id", limit: 50 })) as { data?: Array<{ id?: string }> };
  if (!(px.data ?? []).some((x) => String(x.id) === p.pixel_id)) {
    throw new ExpectedToolError("meta_ads_pixel_not_in_account", `pixel ${p.pixel_id} is not one of this ad account's pixels; nothing was sent.`);
  }
  const name = taggedName(p.name, p.tag);
  const list = (await fbGet(tenant_id, `${creds.ad_account_id}/customconversions`, { fields: "id,name", limit: 200 })) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  const mine = (list.data ?? []).find((c) => c.id && nameHasTag(c.name, p.tag));
  if (mine?.id) return { id: mine.id, name: mine.name ?? name, reused: true };
  const req = shapeCustomConversionRequest({ ad_account_id: creds.ad_account_id, name, pixel_id: p.pixel_id, custom_event_type: p.custom_event_type, url_contains: p.url_contains });
  const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
  assertGraphWriteSucceeded(r, "custom conversion create");
  if (!r.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no custom conversion id");
  return { id: r.id, name, reused: false };
}
