
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const EXTENSION_SCREENSHOTS_TABLE = "extension_screenshots";

export async function recordExtensionScreenshot(
  tenant_id: string,
  user_id: string,
  image_path: string,
): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_SCREENSHOTS_TABLE)
    .insert({ user_id, image_path });
  if (error) throw new Error(error.message);
}

export type ScreenshotTurnVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function validateScreenshotTurn(args: {
  tenant_id: string;
  user_id: string;
  image_paths: readonly string[] | undefined;
}): Promise<ScreenshotTurnVerdict> {
  const paths = args.image_paths ?? [];
  if (paths.length !== 1) {
    return {
      ok: false,
      code: "screenshot_image_required",
      message: "A screenshot turn must attach exactly one screenshot.",
    };
  }
  const notOwned: ScreenshotTurnVerdict = {
    ok: false,
    code: "screenshot_not_found",
    message: "That screenshot was not found. Take a new one and try again.",
  };
  try {
    const { data, error } = await tenantClient(asTenantId(args.tenant_id))
      .from(EXTENSION_SCREENSHOTS_TABLE)
      .select("id")
      .eq("user_id", args.user_id)
      .eq("image_path", paths[0])
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data) return notOwned;
    return { ok: true };
  } catch {
    return notOwned;
  }
}
