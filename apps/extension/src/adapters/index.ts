
import { metaAdsAdapter } from "./meta-ads";
import type {
  AdapterExtraction,
  AdapterLocation,
  PageAdapter,
  WireExtraction,
} from "./types";

export const ADAPTERS: readonly PageAdapter[] = [metaAdsAdapter];

export function pickAdapter(
  location: AdapterLocation,
  doc: Document,
  registry: readonly PageAdapter[] = ADAPTERS,
): AdapterExtraction | null {
  for (const adapter of registry) {
    let claimed = false;
    try {
      claimed = adapter.matches(location);
    } catch {
      continue;
    }
    if (!claimed) continue;

    let extraction: WireExtraction | null = null;
    try {
      extraction = adapter.extract(doc);
    } catch {
      return null;
    }
    if (!extraction) return null;

    return {
      adapter_id: adapter.id,
      schema_version: adapter.schema_version,
      extraction,
    };
  }
  return null;
}

export function locationOf(url: string): AdapterLocation | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return {
      hostname: u.hostname.toLowerCase().replace(/\.$/, ""),
      pathname: u.pathname,
    };
  } catch {
    return null;
  }
}

export function pickAdapterForUrl(
  url: string,
  doc: Document,
  registry: readonly PageAdapter[] = ADAPTERS,
): AdapterExtraction | null {
  const location = locationOf(url ?? "");
  if (location === null) return null;
  return pickAdapter(location, doc, registry);
}

export type { AdapterExtraction, AdapterLocation, PageAdapter } from "./types";
export type {
  MetaAdsExtraction,
  MetaAdsRow,
  MetaAdsLevel,
  MetaAdsWireExtraction,
  ExtractOptions,
} from "./meta-ads";
export {
  extractMetaAds,
  extractMetaAdsFromHtml,
  toWireExtraction,
  parseNumericCell,
  jsonByteLength,
  MAX_ROWS,
  MAX_JSON_BYTES,
  MAX_LABEL_LEN,
  META_ADS_ADAPTER_ID,
  META_ADS_SCHEMA_VERSION,
} from "./meta-ads";
