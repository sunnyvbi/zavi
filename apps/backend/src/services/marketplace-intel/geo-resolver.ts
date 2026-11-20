export type GeoConfidence = "high" | "medium" | "low" | "none";

export interface ResolvedGeo {
  country: "US" | null;
  state: string | null;
  geo_label: string;
  confidence: GeoConfidence;
  raw: string;
}

export interface GeoSummary {
  total: number;
  resolved: number;
  unresolved: number;
  state_rollup: Record<string, number>;
}

const UNKNOWN_STATE = "unknown_state";

const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_NAME_TO_CODE = new Map(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

const METRO_ALIASES: Record<
  string,
  { state: string | null; label: string; confidence: GeoConfidence }
> = {
  "bay area": { state: "CA", label: "Bay Area, CA", confidence: "medium" },
  "sf bay area": { state: "CA", label: "SF Bay Area, CA", confidence: "medium" },
  "san francisco bay area": {
    state: "CA",
    label: "SF Bay Area, CA",
    confidence: "medium",
  },
  dfw: { state: "TX", label: "Dallas-Fort Worth, TX", confidence: "medium" },
  "dallas fort worth": {
    state: "TX",
    label: "Dallas-Fort Worth, TX",
    confidence: "medium",
  },
  "dallas-fort worth": {
    state: "TX",
    label: "Dallas-Fort Worth, TX",
    confidence: "medium",
  },
  "dallas ft worth": {
    state: "TX",
    label: "Dallas-Fort Worth, TX",
    confidence: "medium",
  },
  "dfw metroplex": { state: "TX", label: "Dallas-Fort Worth, TX", confidence: "medium" },
  nyc: { state: "NY", label: "NYC, NY", confidence: "medium" },
  "new york city": { state: "NY", label: "New York City, NY", confidence: "medium" },
  socal: { state: "CA", label: "Southern California", confidence: "medium" },
  "southern california": {
    state: "CA",
    label: "Southern California",
    confidence: "medium",
  },
  "la metro": { state: "CA", label: "LA Metro, CA", confidence: "medium" },
  "los angeles metro": { state: "CA", label: "LA Metro, CA", confidence: "medium" },
  "greater los angeles": { state: "CA", label: "LA Metro, CA", confidence: "medium" },
  dmv: { state: null, label: "DMV / DC metro (multi-state)", confidence: "medium" },
  "dc metro": { state: null, label: "DC metro (multi-state)", confidence: "medium" },
  "washington dc metro": { state: null, label: "DC metro (multi-state)", confidence: "medium" },
  "tri state": { state: null, label: UNKNOWN_STATE, confidence: "none" },
  "tri-state": { state: null, label: UNKNOWN_STATE, confidence: "none" },
};

export const AMBIGUOUS_CITY_NAMES = new Set([
  "aurora",
  "columbus",
  "glendale",
  "kansas city",
  "portland",
  "springfield",
]);

const CITY_TO_STATE: Record<string, string> = {
  "new york": "NY",
  "new york city": "NY",
  "los angeles": "CA",
  chicago: "IL",
  houston: "TX",
  phoenix: "AZ",
  philadelphia: "PA",
  "san antonio": "TX",
  "san diego": "CA",
  dallas: "TX",
  "san jose": "CA",
  austin: "TX",
  jacksonville: "FL",
  "fort worth": "TX",
  charlotte: "NC",
  indianapolis: "IN",
  "san francisco": "CA",
  seattle: "WA",
  denver: "CO",
  "oklahoma city": "OK",
  nashville: "TN",
  "el paso": "TX",
  "washington dc": "DC",
  "washington": "DC",
  "las vegas": "NV",
  boston: "MA",
  detroit: "MI",
  memphis: "TN",
  louisville: "KY",
  baltimore: "MD",
  milwaukee: "WI",
  albuquerque: "NM",
  tucson: "AZ",
  fresno: "CA",
  sacramento: "CA",
  mesa: "AZ",
  atlanta: "GA",
  omaha: "NE",
  "colorado springs": "CO",
  raleigh: "NC",
  "long beach": "CA",
  "virginia beach": "VA",
  miami: "FL",
  oakland: "CA",
  minneapolis: "MN",
  tulsa: "OK",
  tampa: "FL",
  arlington: "TX",
  "new orleans": "LA",
  wichita: "KS",
  cleveland: "OH",
  bakersfield: "CA",
  anaheim: "CA",
  honolulu: "HI",
  "santa ana": "CA",
  "riverside": "CA",
  "corpus christi": "TX",
  lexington: "KY",
  henderson: "NV",
  stockton: "CA",
  "saint paul": "MN",
  "st paul": "MN",
  cincinnati: "OH",
  "st louis": "MO",
  "saint louis": "MO",
  pittsburgh: "PA",
  greensboro: "NC",
  anchorage: "AK",
  plano: "TX",
  lincoln: "NE",
  orlando: "FL",
  irvine: "CA",
  newark: "NJ",
  durham: "NC",
  "chula vista": "CA",
  toledo: "OH",
  "fort wayne": "IN",
  "st petersburg": "FL",
  "saint petersburg": "FL",
  laredo: "TX",
  chandler: "AZ",
  madison: "WI",
  lubbock: "TX",
  scottsdale: "AZ",
  reno: "NV",
  buffalo: "NY",
  gilbert: "AZ",
  "north las vegas": "NV",
  "winston salem": "NC",
  "winston-salem": "NC",
  chesapeake: "VA",
  norfolk: "VA",
  fremont: "CA",
  garland: "TX",
  irving: "TX",
  "hialeah": "FL",
  richmond: "VA",
  boise: "ID",
  spokane: "WA",
  "baton rouge": "LA",
  tacoma: "WA",
  "san bernardino": "CA",
  modesto: "CA",
  fontana: "CA",
  "des moines": "IA",
  "moreno valley": "CA",
  "santa clarita": "CA",
  fayetteville: "NC",
  birmingham: "AL",
  oxnard: "CA",
  rochester: "NY",
  "port st lucie": "FL",
  "port saint lucie": "FL",
  "grand rapids": "MI",
  huntsville: "AL",
  "salt lake city": "UT",
  frisco: "TX",
  yonkers: "NY",
  amarillo: "TX",
  "glendale ca": "CA",
  huntington: "CA",
  "huntington beach": "CA",
  mckinney: "TX",
  montgomery: "AL",
  augusta: "GA",
  "little rock": "AR",
  akron: "OH",
  tempe: "AZ",
  "overland park": "KS",
  "grand prairie": "TX",
  mobile: "AL",
  knoxville: "TN",
  shreveport: "LA",
  worcester: "MA",
  "brownsville": "TX",
  "newport news": "VA",
  "fort lauderdale": "FL",
  pearland: "TX",
  chattanooga: "TN",
  providence: "RI",
  "santa rosa": "CA",
  oceanside: "CA",
  salem: "OR",
  "garden grove": "CA",
  "rancho cucamonga": "CA",
  "cape coral": "FL",
  vancouver: "WA",
  "sioux falls": "SD",
  ontario: "CA",
  "elk grove": "CA",
  jackson: "MS",
  "pembroke pines": "FL",
  "salem or": "OR",
  eugene: "OR",
  peoria: "AZ",
  corona: "CA",
  lancaster: "CA",
  cary: "NC",
  palmdale: "CA",
  "hayward": "CA",
  salinas: "CA",
  "alexandria": "VA",
  "lakewood": "CO",
  "springfield mo": "MO",
  sunnyvale: "CA",
  "hollywood": "FL",
  macon: "GA",
  "kansas city mo": "MO",
  "kansas city ks": "KS",
};

function result(
  raw: string,
  country: "US" | null,
  state: string | null,
  geo_label: string,
  confidence: GeoConfidence,
): ResolvedGeo {
  return { country, state, geo_label, confidence, raw };
}

function normalizeInput(raw: string): string {
  let value = raw.trim().replace(/\s+/g, " ");
  value = stripTrailingCountry(stripTrailingZip(value));
  value = stripTrailingZip(value);
  value = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return value.replace(/[,\s]+$/g, "").trim().toLowerCase();
}

function stripTrailingZip(value: string): string {
  return value.replace(/\s*,?\s+\d{5}(?:-\d{4})?$/u, "").trim();
}

function stripTrailingCountry(value: string): string {
  return value
    .replace(
      /\s*,?\s*(?:USA|U\.S\.A\.|US|U\.S\.|United States|United States of America)\.?$/iu,
      "",
    )
    .trim();
}

function keyFor(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[']/g, "")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function compactKeyFor(value: string): string {
  return keyFor(value).replace(/-/g, " ");
}

function stateCodeFor(value: string): string | null {
  const state = value.trim();
  const upper = state.toUpperCase();
  if (US_STATES[upper]) return upper;
  return STATE_NAME_TO_CODE.get(state.toLowerCase()) ?? null;
}

function toTitle(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveExplicitCityState(raw: string, cleaned: string): ResolvedGeo | null {
  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const state = stateCodeFor(parts[parts.length - 1]);
  if (!state) return null;

  const city = parts.slice(0, -1).join(", ");
  if (!city) {
    return result(raw, "US", state, `${US_STATES[state]} (${state})`, "high");
  }

  return result(raw, "US", state, `${toTitle(city)}, ${state}`, "high");
}

function resolveTrailingStateToken(raw: string, cleaned: string): ResolvedGeo | null {
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return null;

  const stateToken = parts[parts.length - 1];
  const state = US_STATES[stateToken.toUpperCase()] ? stateToken.toUpperCase() : null;
  if (!state) return null;

  const city = parts.slice(0, -1).join(" ");
  if (!city) return null;

  return result(raw, "US", state, `${toTitle(city)}, ${state}`, "high");
}

export function resolveGeo(raw: string): ResolvedGeo {
  const cleaned = normalizeInput(raw);
  if (!cleaned) return result(raw, null, null, UNKNOWN_STATE, "none");

  const explicit = resolveExplicitCityState(raw, cleaned);
  if (explicit) return explicit;

  const trailingState = resolveTrailingStateToken(raw, cleaned);
  if (trailingState) return trailingState;

  const state = stateCodeFor(cleaned);
  if (state) return result(raw, "US", state, `${US_STATES[state]} (${state})`, "high");

  const key = keyFor(cleaned);
  const compactKey = compactKeyFor(cleaned);

  const metro = METRO_ALIASES[key] ?? METRO_ALIASES[compactKey];
  if (metro) {
    return result(
      raw,
      metro.confidence === "none" ? null : "US",
      metro.state,
      metro.label,
      metro.confidence,
    );
  }

  if (AMBIGUOUS_CITY_NAMES.has(compactKey)) {
    return result(raw, "US", null, `${toTitle(cleaned)} (ambiguous city)`, "low");
  }

  const cityState = CITY_TO_STATE[key] ?? CITY_TO_STATE[compactKey];
  if (cityState) return result(raw, "US", cityState, `${toTitle(cleaned)}, ${cityState}`, "high");

  return result(raw, null, null, UNKNOWN_STATE, "none");
}

export type UsStateEvidence = {
  state: string | null;
  strength: "strong" | "weak" | "none";
};

const STATE_CODES_THAT_ARE_COUNTRY_CODES = new Set([
  "AL", "AR", "AZ", "CA", "CO", "DE", "GA", "ID", "IL", "IN", "KY", "LA", "MA",
  "MD", "ME", "MN", "MO", "MS", "MT", "NC", "NE", "PA", "SC", "SD", "TN", "VA",
]);

function isKnownUsPlace(place: string): boolean {
  if (!place) return false;
  const key = keyFor(place);
  const compactKey = compactKeyFor(place);
  if (AMBIGUOUS_CITY_NAMES.has(compactKey)) return false;
  const metro = METRO_ALIASES[key] ?? METRO_ALIASES[compactKey];
  if (metro) return metro.confidence !== "none";
  return Boolean(CITY_TO_STATE[key] ?? CITY_TO_STATE[compactKey]);
}

export function usStateEvidence(raw: string): UsStateEvidence {
  const resolved = resolveGeo(raw);
  if (!resolved.state) return { state: null, strength: "none" };
  const strong: UsStateEvidence = { state: resolved.state, strength: "strong" };

  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (/\s*,?\s+\d{5}(?:-\d{4})?$/u.test(collapsed)) return strong;
  if (
    /(?:^|[\s,])(?:USA|U\.S\.A\.|U\.S\.|United States(?: of America)?)\.?$/iu.test(
      stripTrailingZip(collapsed),
    )
  ) {
    return strong;
  }

  const cleaned = normalizeInput(raw);
  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (STATE_NAME_TO_CODE.has(last)) return strong;

  if (parts.length >= 2) {
    if (isKnownUsPlace(parts.slice(0, -1).join(", "))) return strong;
  } else {
    const tokens = cleaned.split(" ").filter(Boolean);
    const tail = tokens[tokens.length - 1] ?? "";
    const place =
      tokens.length >= 2 && US_STATES[tail.toUpperCase()] ? tokens.slice(0, -1).join(" ") : cleaned;
    if (isKnownUsPlace(place)) return strong;
  }

  return {
    state: resolved.state,
    strength: STATE_CODES_THAT_ARE_COUNTRY_CODES.has(resolved.state) ? "weak" : "strong",
  };
}

export function resolveGeos(raws: string[]): ResolvedGeo[] {
  return raws.map(resolveGeo);
}

export function summarizeGeos(raws: string[]): GeoSummary {
  const state_rollup: Record<string, number> = {};
  let resolved = 0;

  for (const geo of resolveGeos(raws)) {
    if (geo.state) {
      state_rollup[geo.state] = (state_rollup[geo.state] ?? 0) + 1;
      resolved += 1;
    } else {
      state_rollup[UNKNOWN_STATE] = (state_rollup[UNKNOWN_STATE] ?? 0) + 1;
    }
  }

  return {
    total: raws.length,
    resolved,
    unresolved: raws.length - resolved,
    state_rollup,
  };
}
