
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX = 400;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const CASED_PLACES = new Set(["NYC", "LA", "SF", "Phoenix", "PHOENIX", "Reno", "RENO"]);
const PLACES = [
  "Los Angeles", "San Francisco", "San Diego", "San Jose", "Sacramento", "Oakland", "Fresno", "Long Beach", "Irvine",
  "Orange County", "Bay Area", "Las Vegas", "Reno", "Houston", "Dallas", "Austin", "San Antonio", "Fort Worth",
  "El Paso", "Phoenix", "Tucson", "Scottsdale", "Tempe", "Miami", "Orlando", "Tampa", "Jacksonville",
  "Fort Lauderdale", "New York City", "New York", "Chicago", "Seattle", "Portland", "Denver", "Atlanta", "Boston",
  "Philadelphia", "Washington DC", "Nashville", "Detroit", "Minneapolis", "Salt Lake City", "Honolulu",
  "NYC", "LA", "SF", "PHOENIX", "RENO",
].sort((a, b) => b.length - a.length);
const placeAlt = (names: string[]) => `(?:${names.map(esc).join("|")})`;
const ANY_CASE_PLACE = placeAlt(PLACES.filter((p) => !CASED_PLACES.has(p)));
const CASED_PLACE = placeAlt(PLACES.filter((p) => CASED_PLACES.has(p)));
const LOCAL_NOUN = "(?:cars?|renters?|drivers?|hosts?|guests?|customers?|users?|buyers?|sellers?|bookings?|trips?|budgets?|search|searches|ads?|ad sets?|campaigns?|audiences?|market|markets|traffic|demand|listings?|pages?|keywords?)";
const COUNT = ["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function scrubPlaces(text: string): string {
  let s = String(text ?? "");
  for (const [place, flags] of [[ANY_CASE_PLACE, "gi"], [CASED_PLACE, "g"]] as const) {
    s = s
      .replace(new RegExp(`\\b(in|across|around|near|from|to|for) ${place}(?![A-Za-z0-9])`, flags), "$1 one city")
      .replace(new RegExp(`(?<![A-Za-z0-9])${place} (?=${LOCAL_NOUN}\\b)`, flags), "local ")
      .replace(new RegExp(`(?<![A-Za-z0-9])${place}(?![A-Za-z0-9])`, flags), "one city");
  }
  return s.replace(/\bone city(?:(?:,? and |, )one city)+/g, (m) => `${COUNT[m.split("one city").length - 1] ?? "several"} cities`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoDate = (m: string, mo: string, d: string) =>
  MONTHS[+mo - 1] && +d >= 1 && +d <= 31 ? `${MONTHS[+mo - 1]} ${+d}${m.endsWith("T") ? " " : ""}` : m;
const CLOSE_QUOTE: Record<string, string> = { "'": "'", "‘": "’", "“": "”" };

function dropStrayClose(s: string): string {
  let depth = 0;
  let out = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0 && /\s/.test(out.slice(-1))) continue;
      depth = Math.max(0, depth - 1);
    }
    out += ch;
  }
  return out;
}

export function tidyPublicText(text: string): string {
  const s = String(text ?? "")
    .replace(/\s{2,}/g, " ")
    .replace(/(?<![\w-])[\w-]+\[phone\][\w-]+/g, "")
    .replace(/\s+\(\s*\)/g, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/,(\s*,)+/g, ",")
    .replace(/\s*,\s*\)/g, ")")
    .replace(/\ba campaign campaign\b/g, "a campaign")
    .replace(/\b([Tt])he (an? )(?=(?:campaign|ad|account)\b)/g, (_m, t: string, a: string) => (t === "T" ? "A" + a.slice(1) : a))
    .replace(/(['‘“])a campaign(?=[.,;:!?]|$)/g, (_m, q: string) => `${q}a campaign${CLOSE_QUOTE[q]}`);
  return dropStrayClose(s).replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();
}

export function scrubPublicText(text: string, opts: { campaignNames: string[] }): string {
  let s = String(text ?? "")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
  for (const n of [...opts.campaignNames].filter(Boolean).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(?<![A-Za-z0-9\\[])${esc(n)}(?![A-Za-z0-9\\]])`, "gi"), "a campaign");
  }
  s = s
    .replace(/(?<![\w-])\d{4}-(\d{2})-(\d{2})(?:T(?=\d{2}:)|(?![\w-]))/g, isoDate)
    .replace(/\bact_\d+/g, "__ACCT__")
    .replace(/\b(ad set|adset|ad group|adgroup|campaign|ad|customer)\s+\d{6,}/gi, (_m, w: string) => `__OBJ_${w.toLowerCase()}__`)
    .replace(UUID, "__ID__")
    .replace(/\b\d{9,}\b/g, "__ID__")
    .replace(/\+?\(?\d[\d\s().-]{8,}\d/g, (m, at: number, all: string) =>
      all[at - 1] === "$" && /^\d[\d.]*\s*-\s*\d[\d.]*$/.test(m) && m.replace(/\D/g, "").length < 10 ? m : "[phone]")
    .replace(/(['‘])Zavi · [^.,;:!?\n]{0,200}(['’])(?![A-Za-z0-9])/g, "$1a campaign$2")
    .replace(/(["“])Zavi · [^.,;:!?\n]{0,200}(["”])(?![A-Za-z0-9])/g, "$1a campaign$2")
    .replace(/\bZavi · [^.,;:!?\n]+/g, "a campaign");
  s = scrubPlaces(s)
    .replace(/\bin __ACCT__/g, "in an ad account")
    .replace(/__ACCT__/g, "an ad account")
    .replace(/__OBJ_(ad set|adset)__/g, "an ad set")
    .replace(/__OBJ_(ad group|adgroup)__/g, "an ad group")
    .replace(/__OBJ_campaign__/g, "a campaign")
    .replace(/__OBJ_ad__/g, "an ad")
    .replace(/__OBJ_customer__/g, "an account")
    .replace(/__ID__/g, "");
  s = tidyPublicText(s);
  if (s.length > MAX) {
    const cut = s.slice(0, MAX - 3);
    s = cut.slice(0, Math.max(0, cut.lastIndexOf(" "))).trimEnd() + "...";
  }
  return s;
}

const ID_PATTERNS: RegExp[] = [
  UUID,
  /\bact_\d*/g,
  /\bcustomers\/\S*/g,
  /\badsets?\/\S*/g,
  /\bZavi · /g,
];

export function findIdentifiers(text: string): string[] {
  const s = String(text ?? "");
  const hits: string[] = [];
  for (const re of ID_PATTERNS) for (const m of s.matchAll(re)) hits.push(m[0]);
  for (const m of s.matchAll(/\b\d[\d\s-]{7,}\d\b/g)) {
    if (m[0].replace(/\D/g, "").length >= 9) hits.push(m[0]);
  }
  return hits;
}
