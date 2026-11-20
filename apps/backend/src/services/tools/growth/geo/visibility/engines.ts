
export type GeoEngine = "chatgpt" | "claude" | "gemini" | "perplexity";

export type EngineEndpoint = "llm_scraper" | "llm_responses";

export type EngineDef = {
  id: GeoEngine;
  label: string;
  dataforseo_se: "chat_gpt" | "claude" | "gemini" | "perplexity";
  endpoint: EngineEndpoint;
  est_cost_usd: number;
};

export const GEO_ENGINES: readonly EngineDef[] = [
  { id: "chatgpt", label: "ChatGPT", dataforseo_se: "chat_gpt", endpoint: "llm_scraper", est_cost_usd: 0.004 },
  { id: "claude", label: "Claude", dataforseo_se: "claude", endpoint: "llm_responses", est_cost_usd: 0.05 },
  { id: "gemini", label: "Gemini", dataforseo_se: "gemini", endpoint: "llm_scraper", est_cost_usd: 0.004 },
  { id: "perplexity", label: "Perplexity", dataforseo_se: "perplexity", endpoint: "llm_responses", est_cost_usd: 0.03 },
];

export const GEO_ENGINE_IDS: readonly GeoEngine[] = GEO_ENGINES.map((e) => e.id);

export function engineDef(id: string): EngineDef | null {
  return GEO_ENGINES.find((e) => e.id === id) ?? null;
}

export function isGeoEngine(id: unknown): id is GeoEngine {
  return typeof id === "string" && GEO_ENGINE_IDS.includes(id as GeoEngine);
}

export type GeoLocale = {
  country: string;
  label: string;
  location_code: number;
  language_code: string;
};

export const GEO_LOCALES: readonly GeoLocale[] = [
  { country: "US", label: "United States", location_code: 2840, language_code: "en" },
  { country: "IN", label: "India", location_code: 2356, language_code: "en" },
  { country: "GB", label: "United Kingdom", location_code: 2826, language_code: "en" },
  { country: "CA", label: "Canada", location_code: 2124, language_code: "en" },
  { country: "AU", label: "Australia", location_code: 2036, language_code: "en" },
  { country: "SG", label: "Singapore", location_code: 2702, language_code: "en" },
  { country: "AE", label: "United Arab Emirates", location_code: 2784, language_code: "en" },
  { country: "IE", label: "Ireland", location_code: 2372, language_code: "en" },
  { country: "NZ", label: "New Zealand", location_code: 2554, language_code: "en" },
  { country: "DE", label: "Germany", location_code: 2276, language_code: "de" },
  { country: "FR", label: "France", location_code: 2250, language_code: "fr" },
];

export const DEFAULT_GEO_COUNTRY = "US";

export function localeFor(country: string | null | undefined): GeoLocale | null {
  const c = (country ?? "").trim().toUpperCase();
  return GEO_LOCALES.find((l) => l.country === c) ?? null;
}
