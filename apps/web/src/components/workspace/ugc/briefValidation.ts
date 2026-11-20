export type BriefFieldKey = "title" | "angle" | "hook" | "format" | "deliverables" | "budget" | "days" | "cap" | "locations" | "note";

export type BriefFieldValues = Record<BriefFieldKey, string>;

const TEXT: Array<[BriefFieldKey, string, number]> = [
  ["title", "Title", 200],
  ["angle", "Angle", 600],
  ["hook", "Hook", 400],
  ["format", "Format", 120],
];

const NUMBERS: Array<[BriefFieldKey, number, number, string]> = [
  ["deliverables", 1, 20, "Enter 1 to 20 videos."],
  ["budget", 1, 1_000_000, "Enter a budget of at least $1 per video."],
  ["days", 1, 90, "Enter 1 to 90 days."],
  ["cap", 1, 500, "Enter a limit from 1 to 500."],
];

export const PUBLISH_REQUIRED: BriefFieldKey[] = ["title", "angle", "hook", "format", "deliverables", "budget", "days", "cap"];
const SAVE_REQUIRED: BriefFieldKey[] = ["title", "angle", "hook", "format"];

const MAX_LOCATIONS = 25;
const MAX_LOCATION_LEN = 120;
const MAX_NOTE_LEN = 2000;

export function briefFieldErrors(v: BriefFieldValues): Partial<Record<BriefFieldKey, string>> {
  const out: Partial<Record<BriefFieldKey, string>> = {};
  for (const [key, label, max] of TEXT) {
    const s = v[key].trim();
    if (!s) out[key] = `${label} is required.`;
    else if (s.length > max) out[key] = `${label} has to be ${max} characters or fewer. It is ${s.length} now.`;
  }
  for (const [key, min, max, message] of NUMBERS) {
    const raw = v[key].trim();
    const n = Number(raw);
    if (!raw) out[key] = `${message.replace(/\.$/, "")}. It is required to publish.`;
    else if (!/^\d+$/.test(raw) || n < min || n > max) out[key] = message;
  }
  const places = v.locations.split(",").map((x) => x.trim()).filter(Boolean);
  if (places.length > MAX_LOCATIONS) out.locations = `List ${MAX_LOCATIONS} locations at most. There are ${places.length} now.`;
  else if (places.some((p) => p.length > MAX_LOCATION_LEN)) out.locations = `Each location has to be ${MAX_LOCATION_LEN} characters or fewer.`;
  if (v.note.trim().length > MAX_NOTE_LEN) out.note = `The note has to be ${MAX_NOTE_LEN.toLocaleString("en-US")} characters or fewer.`;
  return out;
}

const isMissing = (v: BriefFieldValues, k: BriefFieldKey) => !v[k].trim();

export function canSaveBrief(v: BriefFieldValues): boolean {
  const errors = briefFieldErrors(v);
  return (Object.keys(errors) as BriefFieldKey[]).every((k) => !SAVE_REQUIRED.includes(k) && isMissing(v, k) && PUBLISH_REQUIRED.includes(k));
}

export function canPublishBrief(v: BriefFieldValues): boolean {
  return Object.keys(briefFieldErrors(v)).length === 0;
}

export function shownBriefErrors(
  v: BriefFieldValues,
  touched: ReadonlySet<BriefFieldKey>,
  showAll: boolean,
): Partial<Record<BriefFieldKey, string>> {
  const errors = briefFieldErrors(v);
  const out: Partial<Record<BriefFieldKey, string>> = {};
  for (const k of Object.keys(errors) as BriefFieldKey[]) {
    if (!isMissing(v, k) || showAll || touched.has(k)) out[k] = errors[k];
  }
  return out;
}
