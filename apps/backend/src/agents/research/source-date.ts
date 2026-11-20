
const MONTHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/jan/i, "Jan"],
  [/feb/i, "Feb"],
  [/mar/i, "Mar"],
  [/apr/i, "Apr"],
  [/may/i, "May"],
  [/jun/i, "Jun"],
  [/jul/i, "Jul"],
  [/aug/i, "Aug"],
  [/sep/i, "Sep"],
  [/oct/i, "Oct"],
  [/nov/i, "Nov"],
  [/dec/i, "Dec"],
];

function monthLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const [re, short] of MONTHS) {
    if (re.test(raw)) return short;
  }
  return null;
}

const META_DATE_RE =
  /(?:article:published_time|datePublished|name=["']date["'][^>]*content=["'])[^0-9]{0,40}(20\d\d)-(\d{2})-(\d{2})/i;

const CUED_DATE_RE =
  /\b(?:published|updated|posted|as of|last reviewed|last updated)\b[^0-9]{0,15}(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+)?(20\d\d)\b/i;

const FILING_DATE_RE = /\b(?:FY|fiscal year|10-K|annual report)\s*'?\s*(20\d\d)\b/i;

const BARE_ISO_RE = /\b(20\d\d)-(\d{2})-(\d{2})\b/;

export function extractSourceDate(text: string): { year: number | null; label: string | null } {
  if (!text) return { year: null, label: null };

  const meta = text.match(META_DATE_RE);
  if (meta) {
    const year = Number(meta[1]);
    if (Number.isFinite(year)) return { year, label: String(year) };
  }

  const cued = text.match(CUED_DATE_RE);
  if (cued) {
    const year = Number(cued[2]);
    if (Number.isFinite(year)) {
      const mon = monthLabel(cued[1]);
      return { year, label: mon ? `${mon} ${year}` : String(year) };
    }
  }

  const filing = text.match(FILING_DATE_RE);
  if (filing) {
    const year = Number(filing[1]);
    if (Number.isFinite(year)) return { year, label: `FY${year}` };
  }

  const iso = text.match(BARE_ISO_RE);
  if (iso) {
    const year = Number(iso[1]);
    if (Number.isFinite(year)) return { year, label: String(year) };
  }

  return { year: null, label: null };
}

export function yearOlderThanMonths(year: number, now: Date, months: number): boolean {
  if (!Number.isFinite(year) || !Number.isFinite(months)) return false;
  const sourceDate = new Date(Date.UTC(year, 0, 1));
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - Math.round(months));
  return sourceDate.getTime() < cutoff.getTime();
}
