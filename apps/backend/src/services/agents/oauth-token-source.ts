
import { getAppSetting } from "@/services/settings";

const REFRESH_MS = 60_000;

let cachedTokens: string[] = [];
let lastRefreshAt = 0;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

function parsePool(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function getOAuthTokenPoolOverride(): string[] {
  return cachedTokens;
}

export function oauthTokenPoolCacheAgeMs(): number {
  return lastRefreshAt === 0 ? Infinity : Date.now() - lastRefreshAt;
}

export async function refreshOAuthTokenPoolOverride(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const raw = await getAppSetting("anthropic_oauth_token_pool");
      const tokens = parsePool(raw);
      cachedTokens = tokens;
      lastRefreshAt = Date.now();
    } catch (e) {
      console.warn(
        `[oauth-token-source] refresh failed, keeping ${cachedTokens.length} cached token(s): ${(e as Error).message}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startOAuthTokenPoolRefresh(): void {
  if (timer) return;
  void refreshOAuthTokenPoolOverride();
  timer = setInterval(() => void refreshOAuthTokenPoolOverride(), REFRESH_MS);
  timer.unref?.();
}

export function stopOAuthTokenPoolRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function _setOAuthTokenPoolOverrideForTest(tokens: string[]): void {
  cachedTokens = tokens;
  lastRefreshAt = tokens.length ? Date.now() : 0;
}
