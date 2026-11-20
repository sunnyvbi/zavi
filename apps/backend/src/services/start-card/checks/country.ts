
import { START_CARD_LOCALES, type StartCardLocale, type StartCardProfileEvidence } from "@zavi/shared";
import { localeFor } from "@/services/tools/growth/geo/visibility/engines";

type CountryFrom = StartCardProfileEvidence["country_from"];

const CCTLD: Record<string, StartCardLocale> = {
  uk: "GB",
  in: "IN",
  ca: "CA",
  au: "AU",
  sg: "SG",
  ae: "AE",
  ie: "IE",
  nz: "NZ",
  de: "DE",
  fr: "FR",
  us: "US",
};

const GENERIC_CCTLDS = new Set(["io", "ai", "co", "me", "tv", "app", "ly", "fm", "gg", "so", "to", "sh", "cc", "ws", "vc"]);

export type CountryPick = { country: StartCardLocale; country_from: CountryFrom; country_label: string };

function pick(country: StartCardLocale, from: CountryFrom): CountryPick {
  return { country, country_from: from, country_label: localeFor(country)?.label ?? country };
}

export function countryFromTld(domain: string): StartCardLocale | null | undefined {
  const tld = domain.toLowerCase().replace(/\.$/, "").split(".").pop() ?? "";
  if (tld.length !== 2 || GENERIC_CCTLDS.has(tld)) return undefined;
  return CCTLD[tld] ?? null;
}

type Signal = { re: RegExp; weight: number };

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

const SIGNALS: Record<StartCardLocale, Signal[]> = {
  US: [
    { re: new RegExp(`\\b[A-Z][a-zA-Z .]+,\\s*(?:${US_STATES})\\s+\\d{5}(?:-\\d{4})?\\b`), weight: 2 },
    { re: /\bUnited States\b|\bUSA\b/, weight: 1 },
  ],
  GB: [
    { re: /\+44[\s(]/, weight: 2 },
    { re: /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/, weight: 2 },
    { re: /\bUnited Kingdom\b|\bEngland\b|\bScotland\b|\bWales\b/, weight: 1 },
    { re: /\bLondon\b|\bManchester\b|\bBirmingham\b|\bEdinburgh\b|\bGlasgow\b/, weight: 1 },
  ],
  IN: [
    { re: /\+91[\s-]?\d/, weight: 2 },
    { re: /\bIndia\b/, weight: 1 },
    {
      re: /\bMumbai\b|\bDelhi\b|\bBengaluru\b|\bBangalore\b|\bHyderabad\b|\bChennai\b|\bPune\b|\bKolkata\b|\bGurugram\b|\bGurgaon\b|\bNoida\b|\bAhmedabad\b/,
      weight: 1,
    },
  ],
  CA: [
    { re: /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d\b/, weight: 2 },
    { re: /\bCanada\b/, weight: 1 },
    { re: /\bToronto\b|\bVancouver\b|\bMontreal\b|\bMontréal\b|\bCalgary\b|\bOttawa\b|\bEdmonton\b/, weight: 1 },
  ],
  AU: [
    { re: /\+61[\s-]?\d/, weight: 2 },
    { re: /\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/, weight: 2 },
    { re: /\bAustralia\b/, weight: 1 },
    { re: /\bSydney\b|\bMelbourne\b|\bBrisbane\b|\bPerth\b|\bAdelaide\b/, weight: 1 },
  ],
  SG: [
    { re: /\+65[\s-]?\d/, weight: 2 },
    { re: /\bSingapore\s+\d{6}\b/, weight: 2 },
    { re: /\bSingapore\b/, weight: 1 },
  ],
  AE: [
    { re: /\+971[\s-]?\d/, weight: 2 },
    { re: /\bUnited Arab Emirates\b|\bUAE\b/, weight: 1 },
    { re: /\bDubai\b|\bAbu Dhabi\b|\bSharjah\b/, weight: 1 },
  ],
  IE: [
    { re: /\+353[\s-]?\d/, weight: 2 },
    { re: /\b[AC-FHKNPRTV-Y]\d{2}\s?[AC-FHKNPRTV-Y\d]{4}\b/, weight: 1 },
    { re: /\bIreland\b/, weight: 1 },
    { re: /\bDublin\b|\bCork\b|\bGalway\b|\bLimerick\b/, weight: 1 },
  ],
  NZ: [
    { re: /\+64[\s-]?\d/, weight: 2 },
    { re: /\bNew Zealand\b/, weight: 1 },
    { re: /\bAuckland\b|\bWellington\b|\bChristchurch\b/, weight: 1 },
  ],
  DE: [
    { re: /\+49[\s-]?\d/, weight: 2 },
    { re: /\bDeutschland\b|\bGermany\b/, weight: 1 },
    { re: /\bBerlin\b|\bMünchen\b|\bMunich\b|\bHamburg\b|\bFrankfurt\b|\bKöln\b|\bCologne\b/, weight: 1 },
  ],
  FR: [
    { re: /\+33[\s-]?\d/, weight: 2 },
    { re: /\bFrance\b/, weight: 1 },
    { re: /\bParis\b|\bLyon\b|\bMarseille\b|\bToulouse\b|\bBordeaux\b/, weight: 1 },
  ],
};

export function countryFromAddress(texts: readonly string[], hint?: string | null): StartCardLocale | null {
  const text = texts.join("\n");
  if (!text.trim()) return null;
  const h = (hint ?? "").trim().toUpperCase();
  const scores = START_CARD_LOCALES.map((c) => {
    const s = SIGNALS[c].reduce((sum, sig) => sum + (sig.re.test(text) ? sig.weight : 0), 0);
    return { c, s: s > 0 && c === h ? s + 1 : s };
  }).sort((a, b) => b.s - a.s);
  const [top, next] = scores;
  if (!top || top.s < 2 || (next && next.s >= top.s)) return null;
  return top.c;
}

export function asVisitorCountry(code: unknown): StartCardLocale | null {
  const c = typeof code === "string" ? code.trim().toUpperCase() : "";
  return c !== "US" && (START_CARD_LOCALES as readonly string[]).includes(c) ? (c as StartCardLocale) : null;
}

export function detectCountry(
  domain: string,
  pageTexts: readonly string[],
  hint?: string | null,
  visitor?: string | null,
): CountryPick {
  const fromTld = countryFromTld(domain);
  if (fromTld) return pick(fromTld, "cctld");
  if (fromTld === null) return pick("US", "default_us");
  const fromAddress = countryFromAddress(pageTexts, hint);
  if (fromAddress) return pick(fromAddress, "address");
  const fromVisitor = asVisitorCountry(visitor);
  return fromVisitor ? pick(fromVisitor, "visitor") : pick("US", "default_us");
}
