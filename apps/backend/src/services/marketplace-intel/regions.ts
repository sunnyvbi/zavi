
import { usStateEvidence } from "./geo-resolver";

export const OTHER_REGION = "__other__";
export const NO_LOCATION_REGION = "__no_location__";
export const MARKETPLACE_TOTAL_REGION = "__marketplace_total__";
export const MAX_REGIONS = 50;

const US_MODE_MIN_RESOLVED_SHARE = 0.8;
const US_MODE_MIN_STRONG_SHARE = 0.2;
const US_MODE_MIN_STATES = 2;

const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

export type RegionMode = "us_state" | "location";

export type Region = {
  key: string;
  label: string;
  state: string | null;
};

export type RegionIndex = {
  mode: RegionMode;
  resolve(raw: unknown): Region;
  regionForKey(key: string): Region;
};

export type LocationWeight = { raw: unknown; weight: number };

export function normalizeLocation(raw: unknown): string {
  if (raw == null) return "";
  const text = typeof raw === "string" ? raw : String(raw);
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*,?\s+\d{5}(?:-\d{4})?$/u, "")
    .replace(/[\s,]+$/u, "")
    .trim()
    .toLowerCase();
}

function displayOf(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  return text.replace(/\s+/g, " ").trim().replace(/[\s,]+$/u, "");
}

export function isSentinelRegion(key: string): boolean {
  return key === OTHER_REGION || key === NO_LOCATION_REGION || key === MARKETPLACE_TOTAL_REGION;
}

export function buildRegionIndex(inputs: LocationWeight[]): RegionIndex {
  const byLocation = new Map<
    string,
    { weight: number; spellings: Map<string, number>; state: string | null; strength: "strong" | "weak" | "none" }
  >();
  for (const { raw, weight } of inputs) {
    const key = normalizeLocation(raw);
    if (!key || isSentinelRegion(key)) continue;
    const w = Number.isFinite(weight) && weight > 0 ? weight : 0;
    let entry = byLocation.get(key);
    if (!entry) {
      const evidence = usStateEvidence(displayOf(raw));
      entry = { weight: 0, spellings: new Map(), state: evidence.state, strength: evidence.strength };
      byLocation.set(key, entry);
    }
    entry.weight += w;
    const spelling = displayOf(raw);
    entry.spellings.set(spelling, (entry.spellings.get(spelling) ?? 0) + w + 1);
  }

  let total = 0;
  let resolved = 0;
  let strong = 0;
  const states = new Set<string>();
  for (const entry of byLocation.values()) {
    total += 1;
    if (entry.state) {
      resolved += 1;
      states.add(entry.state);
      if (entry.strength === "strong") strong += 1;
    }
  }
  const mode: RegionMode =
    total > 0 &&
    resolved >= US_MODE_MIN_RESOLVED_SHARE * total &&
    strong >= US_MODE_MIN_STRONG_SHARE * total &&
    states.size >= US_MODE_MIN_STATES
      ? "us_state"
      : "location";

  const candidate = new Map<string, Region>();
  const regionWeight = new Map<string, number>();
  for (const [key, entry] of byLocation) {
    let region: Region;
    if (mode === "us_state" && entry.state) {
      region = { key: entry.state, label: US_STATE_NAMES[entry.state] ?? entry.state, state: entry.state };
    } else {
      const label = [...entry.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key;
      region = { key, label, state: null };
    }
    candidate.set(key, region);
    regionWeight.set(region.key, (regionWeight.get(region.key) ?? 0) + entry.weight);
  }

  const kept = new Set(
    [...regionWeight.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_REGIONS)
      .map(([key]) => key),
  );
  const other: Region = { key: OTHER_REGION, label: OTHER_REGION, state: null };
  const noLocation: Region = { key: NO_LOCATION_REGION, label: NO_LOCATION_REGION, state: null };

  const byKey = new Map<string, Region>([
    [OTHER_REGION, other],
    [NO_LOCATION_REGION, noLocation],
  ]);
  for (const region of candidate.values()) if (kept.has(region.key)) byKey.set(region.key, region);

  return {
    mode,
    regionForKey(key: string): Region {
      return byKey.get(key) ?? other;
    },
    resolve(raw: unknown): Region {
      const key = normalizeLocation(raw);
      if (!key || key === NO_LOCATION_REGION) return noLocation;
      if (key === OTHER_REGION) return other;
      const region = candidate.get(key);
      if (!region) return other;
      return kept.has(region.key) ? region : other;
    },
  };
}
