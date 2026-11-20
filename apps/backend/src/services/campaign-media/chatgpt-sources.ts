import { z } from "zod";
import { isOwnAdImagePath } from "@zavi/shared";
import { tenantClient, asTenantId } from "@/services/tenant-client";
import { signOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { campaignActionRequestId } from "@/services/connectors/chatgpt-ads/campaign-action-request-id";
import { addMedia, inGroups, type CampaignThumbnails } from "./media";

const upload = z.object({ request_key: z.string(), file_id: z.string() });
const action = z.object({ id: z.string(), exec_payload: z.object({ ads: z.array(z.object({ image_url: z.string().optional(), image_path: z.string().optional() })) }) });

export async function addSavedChatgptMedia(tenantId: string, files: ReadonlyMap<string, ReadonlySet<string>>, result: CampaignThumbnails): Promise<void> {
  if (!files.size) return;
  const db = tenantClient(asTenantId(tenantId));
  const [uploads, actions] = await Promise.all([
    db.from("ads_creative_uploads").select("request_key,file_id").in("file_id", [...files.keys()].slice(0, 150)),
    db.from("channel_actions").select("id,exec_payload").eq("channel_slug", "chatgpt_ads").eq("exec_class", "chatgpt_ads.create_campaign_bundle").order("proposed_at", { ascending: false }).limit(200),
  ]);
  if (uploads.error || actions.error) return;
  const ids = new Map((uploads.data ?? []).flatMap((item) => { const parsed = upload.safeParse(item); return parsed.success ? [[parsed.data.request_key, parsed.data.file_id] as const] : []; }));
  const sources = new Map<string, Set<string>>();
  for (const row of actions.data ?? []) {
    const parsed = action.safeParse(row);
    if (!parsed.success) continue;
    parsed.data.exec_payload.ads.forEach((ad, index) => {
      const file = ids.get(campaignActionRequestId(parsed.data.id, `ad:${index}`));
      const source = ad.image_path ?? ad.image_url;
      if (!file || !source) return;
      const campaigns = sources.get(source) ?? new Set<string>();
      for (const campaign of files.get(file) ?? []) campaigns.add(campaign);
      sources.set(source, campaigns);
    });
  }
  await inGroups([...sources], async ([source, campaigns]) => {
    let url = source;
    if (isOwnAdImagePath(tenantId, source)) {
      try { url = await signOwnImageForVendor(tenantId, source); } catch { return; }
    }
    for (const campaign of campaigns) addMedia(result, campaign, { image_url: url });
  });
}
