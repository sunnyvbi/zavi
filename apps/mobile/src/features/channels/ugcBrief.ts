
export type BriefRow = {
  id: string;
  status: string;
  title: string | null;
  angle: string | null;
  hook: string | null;
  format: string | null;
  deliverables: number | null;
  budget_usd: number | string | null;
  lane: string | null;
  filters: { niches?: string[]; platforms?: string[]; locations?: string[] } | null;
  delivery_days: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap: number | null;
  decline_note: string | null;
  closed_at: string | null;
  rationale: string | null;
  product_needed?: boolean;
  ad_rights_days?: number | null;
};

export type BriefWorkbench = {
  brief: BriefRow;
  creator_preview: { business_name: string };
  applicant_count: number;
};

export type Draft = {
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: string;
  platforms: string[];
  budget: string;
  days: string;
  niches: string[];
  locations: string;
  answerBy: string;
  cap: string;
  note: string;
  product: boolean;
  rights: string;
};

export const PLATFORMS = ["TikTok", "Instagram", "YouTube", "X", "LinkedIn"];

const PLACEHOLDER = /^Write (what|the hook|the format)|^Untitled brief$/;
const clean = (v: string | null | undefined): string => (v && !PLACEHOLDER.test(v) ? v : "");

export const digits = (v: string): string => v.replace(/\D/g, "");

export function draftFrom(b: BriefRow | null, defaultRights = 90): Draft {
  return {
    title: clean(b?.title),
    angle: clean(b?.angle),
    hook: clean(b?.hook),
    format: clean(b?.format),
    deliverables: b?.deliverables ? String(b.deliverables) : "1",
    platforms: b?.filters?.platforms ?? [],
    budget: b?.budget_usd !== null && b?.budget_usd !== undefined ? String(Math.round(Number(b.budget_usd))) : "",
    days: b?.delivery_days ? String(b.delivery_days) : "",
    niches: b?.filters?.niches ?? [],
    locations: (b?.filters?.locations ?? []).join(", "),
    answerBy: b?.answer_by ? b.answer_by.slice(0, 10) : "",
    cap: b?.applicant_cap ? String(b.applicant_cap) : "",
    note: b?.decline_note ?? "",
    product: b?.product_needed === true,
    rights: b?.ad_rights_days ? String(b.ad_rights_days) : String(defaultRights),
  };
}

export function toInput(d: Draft) {
  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    title: d.title.trim(),
    angle: d.angle.trim(),
    hook: d.hook.trim(),
    format: d.format.trim(),
    deliverables: d.deliverables ? Number(d.deliverables) : null,
    lane: "ugc_video",
    budget_usd: d.budget ? Number(d.budget) : null,
    delivery_days: d.days ? Number(d.days) : null,
    applicant_cap: d.cap ? Number(d.cap) : null,
    answer_by: d.answerBy ? `${d.answerBy}T23:59:59.000Z` : null,
    decline_note: d.note.trim() || null,
    product_needed: d.product,
    ad_rights_days: d.rights ? Number(d.rights) : null,
    filters: { niches: d.niches, platforms: d.platforms, locations: list(d.locations) },
  };
}

export const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

export type Check = { ready: boolean; daysOk: boolean; capOk: boolean; dayOk: boolean; videosOk: boolean };

export function check(d: Draft): Check {
  const daysN = Number(d.days);
  const capN = Number(d.cap);
  const videosN = Number(d.deliverables);
  const daysOk = !d.days || (daysN >= 1 && daysN <= 90);
  const capOk = !d.cap || (capN >= 1 && capN <= 500);
  const dayOk = !d.answerBy || isDay(d.answerBy);
  const videosOk = !d.deliverables || (videosN >= 1 && videosN <= 20);
  const ready = Boolean(d.title.trim() && d.angle.trim() && d.hook.trim() && d.format.trim()) && daysOk && capOk && dayOk && videosOk;
  return { ready, daysOk, capOk, dayOk, videosOk };
}

export function dayFromNow(n: number, now: Date = new Date()): string {
  return new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}
