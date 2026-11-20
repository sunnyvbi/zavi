
import { MCP_NAME_SEPARATOR } from "@/services/mcp/types";

export const PIPEDREAM_SERVER_PREFIX = "pipedream_";

export const MAX_PIPEDREAM_APP_SLUG_LEN = 30;

const APP_SLUG_RE = /^[a-z0-9_]+$/;

export function sanitizeAppSlug(raw: string): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s || s.length > MAX_PIPEDREAM_APP_SLUG_LEN) return null;
  if (!APP_SLUG_RE.test(s)) return null;
  return s;
}

export function serverIdForApp(appSlug: string): string {
  return `${PIPEDREAM_SERVER_PREFIX}${appSlug}`;
}

export function isPipedreamServerId(serverId: string): boolean {
  return serverId.startsWith(PIPEDREAM_SERVER_PREFIX);
}

export function isValidPipedreamServerId(serverId: string): boolean {
  if (!isPipedreamServerId(serverId)) return false;
  const slug = serverId.slice(PIPEDREAM_SERVER_PREFIX.length);
  return sanitizeAppSlug(slug) === slug;
}

export function connectorMetadataSlug(appSlug: string): string {
  return `pipedream.${appSlug}`;
}

export function anthropicNameFits(serverId: string, encodedToolName: string): boolean {
  return serverId.length + MCP_NAME_SEPARATOR.length + encodedToolName.length <= 64;
}
