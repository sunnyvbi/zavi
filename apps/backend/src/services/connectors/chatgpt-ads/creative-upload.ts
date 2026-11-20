import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { chatgptAdsPost } from "./http";

export async function stableCreativeUpload(tenantId: string, requestKey: string, input: Record<string, unknown>, apiKey: string, fetchUrl: string): Promise<{ file_id: string }> {
  const db = tenantClient(asTenantId(tenantId));
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const inserted = await db.from("ads_creative_uploads").upsert({ tenant_id: tenantId, request_key: requestKey, input_hash: hash }, { onConflict: "tenant_id,request_key", ignoreDuplicates: true });
  if (inserted.error) throw new Error("Creative retry storage unavailable");
  const read = async () => {
    const { data, error } = await db.from("ads_creative_uploads").select("input_hash,file_id").eq("request_key", requestKey).single();
    if (error || !data) throw new Error("Creative retry storage unavailable");
    const row = data as { input_hash: string; file_id: string | null };
    if (row.input_hash !== hash) throw new ExpectedToolError("chatgpt_ads_conflict", "This create request has changed. Start a new draft before saving.");
    return row;
  };
  let row = await read();
  if (!row.file_id) {
    const uploaded = await chatgptAdsPost<{ file_id: string }>(apiKey, "/upload", { image_url: fetchUrl });
    if (typeof uploaded.file_id !== "string" || !uploaded.file_id) throw new Error("Creative image upload unavailable");
    const result = await db.from("ads_creative_uploads").update({ file_id: uploaded.file_id }).eq("request_key", requestKey).is("file_id", null);
    if (result.error) throw new Error("Creative retry storage unavailable");
    row = await read();
  }
  return { file_id: row.file_id as string };
}
