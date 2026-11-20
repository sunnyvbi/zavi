import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { VENDOR_FETCH_TTL_SECONDS } from "@/services/chat-images/sign-own-image";
import { checkStoredImageAvailable } from "@/services/chat-images/availability";

const BUCKET = "agent-artifacts";
const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-z0-9._-]+\.(png|jpe?g)$/i;

export async function generatedAdImagePath(tenantId: string, artifactId: string) {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("run_artifacts")
    .select("id, storage_path, bucket, mime")
    .eq("id", artifactId)
    .maybeSingle();
  if (error) throw new ExpectedToolError("image_unavailable", "The generated image could not be checked. Retry with the same artifact without generating another image.");
  const row = data as { id?: unknown; storage_path?: unknown; bucket?: unknown; mime?: unknown } | null;
  if (!row || row.id !== artifactId || (row.bucket ?? BUCKET) !== BUCKET
    || typeof row.mime !== "string" || !["image/png", "image/jpeg"].includes(row.mime)
    || typeof row.storage_path !== "string"
    || !row.storage_path.startsWith(`${tenantId}/`)
    || !IMAGE_PATH.test(row.storage_path)) {
    throw new ExpectedToolError("image_not_owned", "That artifact is not an available generated PNG or JPEG in this workspace. Use a valid image_artifact_id from report.generate_image; do not put an artifact ID in image_url.");
  }
  return row.storage_path;
}

export async function checkGeneratedAdImage(tenantId: string, artifactId: string): Promise<void> {
  const path = await generatedAdImagePath(tenantId, artifactId);
  await checkStoredImageAvailable(tenantId, BUCKET, path);
}

export async function signGeneratedAdImage(tenantId: string, artifactId: string): Promise<string> {
  const path = await generatedAdImagePath(tenantId, artifactId);
  const { data, error } = await tenantStorage(asTenantId(tenantId)).from(BUCKET)
    .createSignedUrl(path, VENDOR_FETCH_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new ExpectedToolError("image_unavailable", "The generated image could not be opened for upload. Retry with the same image; no public hosting or regeneration is needed.");
  }
  return data.signedUrl;
}
