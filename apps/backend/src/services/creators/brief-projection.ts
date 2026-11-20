
export type BriefLane = "ugc_video";

export type BriefFilters = {
  niches?: string[];
  platforms?: string[];
  locations?: string[];
};

export const CREATOR_BRIEF_COLUMNS =
  "id, title, angle, hook, format, deliverables, budget_usd, lane, " +
  "delivery_days, posted_at, answer_by, applicant_cap, closed_at, ad_rights_days";

export type CreatorBriefSourceRow = {
  id: string;
  title: string | null;
  angle: string | null;
  hook: string | null;
  format: string | null;
  deliverables: number | null;
  budget_usd: number | string | null;
  lane: string | null;
  delivery_days: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap: number | null;
  closed_at: string | null;
  ad_rights_days?: number | null;
};

export type CreatorVisibleBrief = {
  id: string;
  business_name: string;
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: number | null;
  budget_usd: number | null;
  lane: BriefLane | null;
  delivery_days: number | null;
  ad_rights_days: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap: number | null;
  applicant_count: number;
  spots_left: number | null;
  open: boolean;
  closed_reason: BriefClosedReason | null;
};

export type BriefClosedReason = "cap_reached" | "answer_by_passed" | "filled";

export type CreatorBriefContext = {
  business_name: string;
  applicant_count: number;
  now?: Date;
};

function text(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function money(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function lane(v: string | null | undefined): BriefLane | null {
  return v === "ugc_video" ? v : null;
}

export function briefOpenState(
  row: Pick<CreatorBriefSourceRow, "posted_at" | "closed_at" | "answer_by" | "applicant_cap">,
  applicant_count: number,
  now: Date = new Date(),
): { open: boolean; closed_reason: BriefClosedReason | null; spots_left: number | null } {
  const cap = row.applicant_cap;
  const spots_left = cap === null || cap === undefined ? null : Math.max(0, cap - applicant_count);

  if (!row.posted_at) return { open: false, closed_reason: null, spots_left };

  if (row.closed_at) {
    if (spots_left === 0) return { open: false, closed_reason: "cap_reached", spots_left };
    if (row.answer_by && new Date(row.answer_by).getTime() <= now.getTime()) {
      return { open: false, closed_reason: "answer_by_passed", spots_left };
    }
    return { open: false, closed_reason: "filled", spots_left };
  }
  if (spots_left === 0) return { open: false, closed_reason: "cap_reached", spots_left };
  if (row.answer_by && new Date(row.answer_by).getTime() <= now.getTime()) {
    return { open: false, closed_reason: "answer_by_passed", spots_left };
  }
  return { open: true, closed_reason: null, spots_left };
}

export function adRightsDays(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return n === 30 || n === 90 || n === 365 ? n : null;
}

export function creatorVisibleBrief(
  row: CreatorBriefSourceRow,
  ctx: CreatorBriefContext,
): CreatorVisibleBrief {
  const state = briefOpenState(row, ctx.applicant_count, ctx.now ?? new Date());
  return {
    id: row.id,
    business_name: text(ctx.business_name) || "A Zavi business",
    title: text(row.title),
    angle: text(row.angle),
    hook: text(row.hook),
    format: text(row.format),
    deliverables: row.deliverables ?? null,
    budget_usd: money(row.budget_usd),
    lane: lane(row.lane),
    delivery_days: row.delivery_days ?? null,
    ad_rights_days: adRightsDays(row.ad_rights_days),
    posted_at: row.posted_at ?? null,
    answer_by: row.answer_by ?? null,
    applicant_cap: row.applicant_cap ?? null,
    applicant_count: ctx.applicant_count,
    spots_left: state.spots_left,
    open: state.open,
    closed_reason: state.closed_reason,
  };
}

export const BRIEF_BOARD_ORDER = "Newest first. Briefs are never ranked by fit or quality.";

export function briefBoardCountLine(shown: number, laneCount: number | null): string {
  if (shown === 0) {
    return laneCount === 0
      ? "No briefs are open in your lanes right now. This is a real zero, not a loading state."
      : "No briefs are open right now. This is a real zero, not a loading state.";
  }
  if (shown === 1) return "1 brief is open right now.";
  return `${shown} briefs are open right now.`;
}

export function briefSpotsLine(brief: Pick<CreatorVisibleBrief, "spots_left" | "applicant_cap">): string {
  if (brief.applicant_cap === null) return "This brief has no application limit.";
  if (brief.spots_left === null) return "This brief has no application limit.";
  if (brief.spots_left === 0) return "This brief has taken all the applications it will take.";
  if (brief.spots_left === 1) return "1 place left before this brief closes to new applications.";
  return `${brief.spots_left} places left before this brief closes to new applications.`;
}

export function answerByCopy(answer_by: string | Date | null | undefined): {
  line: string;
  at: string | null;
} {
  if (!answer_by) {
    return {
      line: "This business has not set a date to answer everyone by.",
      at: null,
    };
  }
  const at = typeof answer_by === "string" ? new Date(answer_by) : answer_by;
  if (Number.isNaN(at.getTime())) {
    return { line: "This business has not set a date to answer everyone by.", at: null };
  }
  const when = at.toISOString().slice(0, 10);
  return {
    line: `Everyone who applies hears back by ${when}. On that date every applicant who was not hired gets a note, and the brief closes.`,
    at: at.toISOString(),
  };
}
