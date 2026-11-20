
import net from "node:net";
import { getBoolSetting } from "@/services/settings";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";

export async function engineerSitePreviewEnabled(
  tenant_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id) return false;
  try {
    return await getBoolSetting("engineer_site_preview_enabled", tenant_id);
  } catch {
    return true;
  }
}

export type SitePreviewUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export function validateSitePreviewUrl(raw: unknown): SitePreviewUrlCheck {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "missing_url" };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "unparseable_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "localhost_blocked" };
  }
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare) && isPrivateIp(bare)) {
    return { ok: false, reason: "private_ip_blocked" };
  }
  return { ok: true, url };
}

const PREVIEW_CDP_TTL_MS = 65 * 60 * 1000;

type PreviewCdpEntry = {
  tenantId: string;
  cdpUrl: string;
  expiresAt: number;
};
const previewCdpBySession = new Map<string, PreviewCdpEntry>();

export function rememberPreviewCdp(
  sessionId: string,
  tenantId: string,
  cdpUrl: string,
  ttlMs: number = PREVIEW_CDP_TTL_MS,
): void {
  previewCdpBySession.set(sessionId, {
    tenantId,
    cdpUrl,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getPreviewCdp(sessionId: string): PreviewCdpEntry | null {
  const e = previewCdpBySession.get(sessionId);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    previewCdpBySession.delete(sessionId);
    return null;
  }
  return e;
}

export function forgetPreviewCdp(sessionId: string): void {
  previewCdpBySession.delete(sessionId);
}

export function _resetLiveViewStore(): void {
  previewCdpBySession.clear();
}
