
import { getCompanyFacts } from "@/services/company/facts";

export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

export function normalizeCountryCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return ISO_COUNTRY_CODES.has(c) ? c : null;
}

export type Country = { code: string; name: string };

const COUNTRIES: ReadonlyArray<readonly [string, number, string]> = [
  ["US", 840, "United States"], ["CA", 124, "Canada"], ["GB", 826, "United Kingdom"], ["IE", 372, "Ireland"],
  ["AU", 36, "Australia"], ["NZ", 554, "New Zealand"], ["IN", 356, "India"], ["SG", 702, "Singapore"],
  ["AE", 784, "United Arab Emirates"], ["DE", 276, "Germany"], ["FR", 250, "France"], ["ES", 724, "Spain"],
  ["IT", 380, "Italy"], ["PT", 620, "Portugal"], ["NL", 528, "Netherlands"], ["BE", 56, "Belgium"],
  ["CH", 756, "Switzerland"], ["AT", 40, "Austria"], ["SE", 752, "Sweden"], ["NO", 578, "Norway"],
  ["DK", 208, "Denmark"], ["FI", 246, "Finland"], ["PL", 616, "Poland"], ["CZ", 203, "Czechia"],
  ["GR", 300, "Greece"], ["RO", 642, "Romania"], ["HU", 348, "Hungary"], ["IL", 376, "Israel"],
  ["TR", 792, "Turkey"], ["SA", 682, "Saudi Arabia"], ["QA", 634, "Qatar"], ["EG", 818, "Egypt"],
  ["ZA", 710, "South Africa"], ["NG", 566, "Nigeria"], ["KE", 404, "Kenya"], ["MX", 484, "Mexico"],
  ["BR", 76, "Brazil"], ["AR", 32, "Argentina"], ["CL", 152, "Chile"], ["CO", 170, "Colombia"],
  ["PE", 604, "Peru"], ["JP", 392, "Japan"], ["KR", 410, "South Korea"], ["CN", 156, "China"],
  ["HK", 344, "Hong Kong"], ["TW", 158, "Taiwan"], ["TH", 764, "Thailand"], ["VN", 704, "Vietnam"],
  ["MY", 458, "Malaysia"], ["ID", 360, "Indonesia"], ["PH", 608, "Philippines"], ["PK", 586, "Pakistan"],
  ["BD", 50, "Bangladesh"], ["LK", 144, "Sri Lanka"], ["UA", 804, "Ukraine"], ["EE", 233, "Estonia"],
  ["LT", 440, "Lithuania"], ["LV", 428, "Latvia"], ["LU", 442, "Luxembourg"], ["IS", 352, "Iceland"],
];

const BY_CODE = new Map(COUNTRIES.map(([code, num, name]) => [code, { code, num, name }]));

const ALIASES: Record<string, string> = {
  usa: "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US", america: "US",
  uk: "GB", "u.k.": "GB", england: "GB", scotland: "GB", wales: "GB", britain: "GB", "great britain": "GB",
  uae: "AE", dubai: "AE", "czech republic": "CZ", holland: "NL", korea: "KR", "republic of korea": "KR",
  türkiye: "TR", turkiye: "TR",
};

const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);
const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma",
  "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text: string, phrase: string) => new RegExp(`(^|[^a-z])${escape(phrase)}($|[^a-z])`, "i").test(text);

export function countryFromText(text: string | null | undefined): Country | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let lower = t.toLowerCase();
  const usState = US_STATE_NAMES.some((n) => has(lower, n));
  for (const region of [...US_STATE_NAMES, "new south wales"]) {
    lower = lower.replace(new RegExp(`(^|[^a-z])${escape(region)}(?=$|[^a-z])`, "gi"), "$1 ");
  }
  const found = new Set<string>();
  for (const [code, , name] of COUNTRIES) if (has(lower, name.toLowerCase())) found.add(code);
  for (const [alias, code] of Object.entries(ALIASES)) if (has(lower, alias)) found.add(code);
  if (/\b(US|USA)\b/.test(t)) found.add("US");
  if (/\bUK\b/.test(t)) found.add("GB");
  const st = /,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,|$)/.exec(t);
  if (st && US_STATE_CODES.has(st[1]) && found.size === 0) found.add("US");
  if (found.size === 0 && usState) found.add("US");
  if (found.size !== 1) return null;
  const code = [...found][0];
  const c = BY_CODE.get(code);
  return c ? { code: c.code, name: c.name } : null;
}

export function googleCountryGeoId(code: string): number | null {
  const c = BY_CODE.get(code.toUpperCase());
  return c ? 2000 + c.num : null;
}

export function countryFromGoogleGeoId(id: number): Country | null {
  for (const c of BY_CODE.values()) if (2000 + c.num === id) return { code: c.code, name: c.name };
  return null;
}

let displayNames: Intl.DisplayNames | null = null;
export function countryName(code: string): string {
  const c = code.toUpperCase();
  const known = BY_CODE.get(c)?.name;
  if (known) return known;
  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(c) ?? c;
  } catch {
    return c;
  }
}

export async function businessCountry(tenant_id: string): Promise<Country | null> {
  try {
    return await businessCountryOrThrow(tenant_id);
  } catch (e) {
    console.warn(`[ad-locations] company record unreadable for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export async function businessCountryOrThrow(tenant_id: string): Promise<Country | null> {
  const { facts } = await getCompanyFacts(tenant_id);
  const code = normalizeCountryCode(facts.country?.value);
  return code ? { code, name: countryName(code) } : null;
}

export async function businessAddress(tenant_id: string): Promise<string | null> {
  try {
    const { facts } = await getCompanyFacts(tenant_id);
    return facts.location?.value?.trim() || null;
  } catch {
    return null;
  }
}
