
export function normVocab(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[\s._-]+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*\+/g, "+")
    .trim();
}

const STAGE_BY_NORM: Record<string, string> = {
  "pre seed": "Pre-seed",
  preseed: "Pre-seed",
  "pre seed stage": "Pre-seed",
  seed: "Seed",
  "seed stage": "Seed",
  "early stage": "Seed",
  "series a": "Series A",
  a: "Series A",
  "series b": "Series B+",
  "series b+": "Series B+",
  "series b plus": "Series B+",
  "series c": "Series B+",
  b: "Series B+",
  growth: "Series B+",
  "growth stage": "Series B+",
  late: "Series B+",
  "late stage": "Series B+",
  "multi stage": "Multi-stage",
  multistage: "Multi-stage",
};

const ANGEL_STAGE_NORMS = new Set(["angel", "angels", "angel round", "angel stage"]);

const GEO_BY_NORM: Record<string, string[]> = {
  us: ["US/Canada", "USA"],
  "u s": ["US/Canada", "USA"],
  usa: ["US/Canada", "USA"],
  "united states": ["US/Canada", "USA"],
  "united states of america": ["US/Canada", "USA"],
  america: ["US/Canada", "USA"],
  "us/canada": ["US/Canada", "USA"],
  "us canada": ["US/Canada", "USA"],
  "north america": ["US/Canada", "USA", "Canada"],
  canada: ["Canada", "US/Canada"],
  uk: ["Europe"],
  "u k": ["Europe"],
  "united kingdom": ["Europe"],
  britain: ["Europe"],
  england: ["Europe"],
  eu: ["Europe"],
  europe: ["Europe"],
  asia: ["Asia-Pacific"],
  "asia pacific": ["Asia-Pacific"],
  "asia/pacific": ["Asia-Pacific"],
  apac: ["Asia-Pacific"],
  latam: ["Latin America"],
  "latin america": ["Latin America"],
  india: ["India"],
  israel: ["Israel"],
  africa: ["Africa"],
  "north africa": ["North Africa"],
  "middle east": ["Middle East"],
  mena: ["Middle East", "North Africa"],
  australia: ["Australia/New Zealand"],
  "new zealand": ["Australia/New Zealand"],
  "australia/new zealand": ["Australia/New Zealand"],
  anz: ["Australia/New Zealand"],
  oceania: ["Oceania", "Australia/New Zealand"],
  china: ["China"],
  global: ["Global"],
  worldwide: ["Global"],
  international: ["Global"],
};

const KNOWN_NICHES = [
  "AI","API","AR/VR","Advertising","AgTech","Analytics","Angel","Automation","B2B SaaS",
  "B2C/E-Commerce","BioTech","CPG/D2C","Chemicals","CleanTech/Environment","Climate","Cloud",
  "Cloud Infrastructure","Commercial Services","ConstructionTech","Consumer","Consumer Durables",
  "Consumer Health","Creator Economy","Crypto/Blockchain","Cybersecurity","Data Services","DeepTech",
  "Defense, Gov, & Legal","Developer Tools","Digital Health","Direct-to-Consumer (DTC)",
  "Diverse Investors","EdTech","Education","Energy","EnergyTech","Enterprise","Enterprise Applications",
  "Entertainment","Entertainment & Sports","Fashion","FinTech","Financial Services","Food & Ag",
  "Food and Beverage","Frontier Tech","Future of Work","Gaming/eSports","Generalist","Gig Economy",
  "GovTech","Government Technology","HRTech","Hardware","Health & Hospital Services","Health IT",
  "Health and Wellness","Healthcare/Medtech","Human Capital/HRTech","IT Services","Impact","Industrial",
  "Infrastructure","Insurance","InsureTech","IoT","Life Sciences","Local Services","Lodging/Hospitality",
  "Logistics","Manufacturing","MarketingTech","Marketplaces","Material Science","Media","Media/Content",
  "Medical Devices","Messaging","Mobility","Parenting/Families","Payments","Pharmaceuticals","Productivity",
  "Proptech","Real Estate","Retail","Robotics","SMB Software","SaaS","Sales & CRM","Scout","Security",
  "Semiconductors","Social Commerce","Social Media","Social Networks","Space","Supply Chain","Transportation",
  "TransportationTech","Travel","Under-represented founders","Web3","Wellness & Fitness",
  "and Solo-Capitalists",
];

export const ANGEL_NICHES = ["Angel", "and Solo-Capitalists"] as const;

const ANGEL_CHECK_BUCKETS = ["$0 - $25K", "$25K - $100K", "$0 - $100K"];

export function isAngelTagged(
  niches: string[] | null | undefined,
  checkBuckets: string[] | null | undefined,
): boolean {
  return (
    (niches ?? []).some((n) => (ANGEL_NICHES as readonly string[]).includes(n)) &&
    (checkBuckets ?? []).some((b) => ANGEL_CHECK_BUCKETS.includes(b))
  );
}

const NICHE_BY_NORM: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const n of KNOWN_NICHES) m[normVocab(n)] = n;
  const aliases: Record<string, string> = {
    "artificial intelligence": "AI",
    "agentic ai": "AI",
    "ai agents": "AI",
    "machine learning": "AI",
    ml: "AI",
    "dev tools": "Developer Tools",
    devtools: "Developer Tools",
    "developer tooling": "Developer Tools",
    fintech: "FinTech",
    "financial technology": "FinTech",
    "b2b": "B2B SaaS",
    "enterprise saas": "B2B SaaS",
    "e commerce": "B2C/E-Commerce",
    ecommerce: "B2C/E-Commerce",
    "e-commerce": "B2C/E-Commerce",
    d2c: "CPG/D2C",
    dtc: "Direct-to-Consumer (DTC)",
    crypto: "Crypto/Blockchain",
    blockchain: "Crypto/Blockchain",
    web3: "Web3",
    healthtech: "Digital Health",
    "health tech": "Digital Health",
    healthcare: "Healthcare/Medtech",
    cybersecurity: "Cybersecurity",
    "cyber security": "Cybersecurity",
    marketplace: "Marketplaces",
    proptech: "Proptech",
    edtech: "EdTech",
    "climate tech": "Climate",
    climatetech: "Climate",
    angels: "Angel",
    "angel investor": "Angel",
    "angel investors": "Angel",
    "solo capitalist": "and Solo-Capitalists",
    "solo capitalists": "and Solo-Capitalists",
  };
  for (const [k, v] of Object.entries(aliases)) m[normVocab(k)] = v;
  return m;
})();

export type Canon = {
  values: string[];
  ignored: string[];
};

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function canonicalizeStages(input?: string[]): Canon & { angel: boolean } {
  const values: string[] = [];
  const ignored: string[] = [];
  let angel = false;
  for (const raw of input ?? []) {
    const norm = normVocab(raw);
    const hit = STAGE_BY_NORM[norm];
    if (hit) values.push(hit);
    else if (ANGEL_STAGE_NORMS.has(norm)) angel = true;
    else ignored.push(raw);
  }
  return { values: dedupe(values), ignored, angel };
}

export function canonicalizeGeography(input?: string): Canon {
  if (!input) return { values: [], ignored: [] };
  const hit = GEO_BY_NORM[normVocab(input)];
  if (hit) return { values: dedupe(hit), ignored: [] };
  return { values: [], ignored: [input] };
}

export function canonicalizeSectors(input?: string[]): Canon {
  const values: string[] = [];
  const ignored: string[] = [];
  for (const raw of input ?? []) {
    const hit = NICHE_BY_NORM[normVocab(raw)];
    if (hit) values.push(hit);
    else ignored.push(raw);
  }
  return { values: dedupe(values), ignored };
}

export const CANONICAL_STAGES = ["Pre-seed", "Seed", "Series A", "Series B+", "Multi-stage"] as const;
export const CANONICAL_GEOGRAPHIES = [
  "US/Canada","USA","Canada","Europe","Asia-Pacific","Latin America","Israel","India","Africa",
  "Australia/New Zealand","North Africa","Middle East","Oceania","China","Global",
] as const;
