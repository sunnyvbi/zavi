
import { platformSecretRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { CHATGPT_ADS_PLATFORM_SECRET_KEY } from "./constants";

const CACHE_TTL_MS = 60_000;

let _cache: { key: string; expiresAtMs: number } | null = null;

async function readPlatformKey(): Promise<string | null> {
  const { data, error } = await platformSecretRpc("get_platform_secret", {
    p_key: CHATGPT_ADS_PLATFORM_SECRET_KEY,
  });
  if (error) {
    throw new ExpectedToolError(
      "chatgpt_ads_http_error",
      `Could not read the ChatGPT Ads platform key: ${error.message}`,
    );
  }
  const v = typeof data === "string" ? data.trim() : "";
  return v.length > 0 ? v : null;
}

export async function getChatgptAdsApiKey(): Promise<string> {
  const configured = process.env.OPENAI_ADS_API_KEY?.trim();
  if (configured) return configured;
  const now = Date.now();
  if (_cache && _cache.expiresAtMs > now) return _cache.key;

  const key = await readPlatformKey();
  if (!key) {
    throw new ExpectedToolError(
      "chatgpt_ads_not_configured",
      `No OPENAI_ADS_API_KEY or ${CHATGPT_ADS_PLATFORM_SECRET_KEY} in platform_secrets, so no OpenAI ad account can be read. ` +
        "This is a Zavi-side setup gap, not a finding about this business: state that the read " +
        "could not be made, and never report zero spend or zero campaigns because of it.",
      { next_step: "zavi_platform_setup" },
    );
  }

  _cache = { key, expiresAtMs: now + CACHE_TTL_MS };
  return key;
}

export function __resetChatgptAdsKeyCacheForTests(): void {
  _cache = null;
}
