import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export async function checkStoredImageAvailable(
  tenantId: string,
  bucket: "agent-artifacts" | "agent-chat-images",
  path: string,
): Promise<void> {
  if (!path.toLowerCase().startsWith(`${tenantId.toLowerCase()}/`)) {
    throw new ExpectedToolError("image_not_owned", "That image is not in this workspace.");
  }
  const unavailable = () => new ExpectedToolError("image_unavailable", "Image storage could not be checked. Retry with the same image; no public hosting or regeneration is needed.");
  let result;
  try {
    result = await tenantStorage(asTenantId(tenantId)).from(bucket).exists(path);
  } catch {
    throw unavailable();
  }
  if (!result.data && (!result.error || [400, 404].includes(Number((result.error as { status?: unknown }).status)))) {
    throw new ExpectedToolError("image_unavailable", "The saved image is no longer available. Choose another saved image or upload a replacement.");
  }
  if (result.error || result.data !== true) throw unavailable();
}
