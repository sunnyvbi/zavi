
import { getBoolSetting } from "@/services/settings";

const PREVIEW_DEFAULT = true;

export async function isEngineerHtmlPreviewEnabled(
  tenantId?: string | null,
): Promise<boolean> {
  try {
    return await getBoolSetting("engineer_html_preview_enabled", tenantId);
  } catch {
    return PREVIEW_DEFAULT;
  }
}
