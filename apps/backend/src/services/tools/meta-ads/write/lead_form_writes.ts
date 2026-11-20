
import { fbGet, fbPost } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertMetaScopes } from "../_scopes";
import { pageAccessToken } from "../pages";
import { nameHasTag, taggedName } from "./_launch-shapers";
import type { CreateLeadFormBody } from "./_decision-bodies";

export function shapeLeadFormParams(p: CreateLeadFormBody, name: string): Record<string, string> {
  return {
    name,
    questions: JSON.stringify(p.questions),
    privacy_policy: JSON.stringify({ url: p.privacy_policy_url, ...(p.privacy_link_text ? { link_text: p.privacy_link_text } : {}) }),
    follow_up_action_url: p.follow_up_action_url,
  };
}

export async function metaCreateLeadForm(
  tenant_id: string,
  p: CreateLeadFormBody & { tag: string },
): Promise<{ id: string; name: string; reused: boolean }> {
  await assertMetaScopes(tenant_id, ["pages_manage_ads", "leads_retrieval"], "Creating a lead form");
  const token = await pageAccessToken(tenant_id, p.page_id);
  const name = taggedName(p.name, p.tag);
  const forms = (await fbGet(tenant_id, `${p.page_id}/leadgen_forms`, { fields: "id,name", limit: 100 }, { page_access_token: token })) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  const mine = (forms.data ?? []).find((f) => f.id && nameHasTag(f.name, p.tag));
  if (mine?.id) return { id: mine.id, name: mine.name ?? name, reused: true };
  const r = (await fbPost(tenant_id, `${p.page_id}/leadgen_forms`, shapeLeadFormParams(p, name), { page_access_token: token })) as { id?: string };
  if (!r?.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no lead form id");
  return { id: r.id, name, reused: false };
}
