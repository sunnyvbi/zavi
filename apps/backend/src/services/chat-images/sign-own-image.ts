import { isOwnAdImagePath } from "@zavi/shared";
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { CHAT_IMAGE_BUCKET } from "./store-chat-image";
import { checkStoredImageAvailable } from "./availability";

export const VENDOR_FETCH_TTL_SECONDS = 15 * 60;

export async function checkOwnImageForVendor(tenantId: string, path: string): Promise<void> {
  if (!isOwnAdImagePath(tenantId, path)) {
    throw new ExpectedToolError("image_not_owned", "That image is not in this workspace.");
  }
  await checkStoredImageAvailable(tenantId, CHAT_IMAGE_BUCKET, path);
}

export async function signOwnImageForVendor(tenantId: string, path: string, ttlSeconds = VENDOR_FETCH_TTL_SECONDS): Promise<string> {
  if (!isOwnAdImagePath(tenantId, path)) {
    throw new ExpectedToolError("image_not_owned", "That image is not in this workspace. Upload it again.");
  }
  const { data, error } = await tenantStorage(asTenantId(tenantId)).from(CHAT_IMAGE_BUCKET).createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) {
    throw new ExpectedToolError("image_unavailable", "That image could not be read. Retry with the same image; no public hosting is needed.");
  }
  return data.signedUrl;
}
