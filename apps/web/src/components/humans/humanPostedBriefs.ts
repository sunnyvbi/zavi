
export type CreatorFees = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
  zavi_gross_cents: number;
  currency: string;
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
  lane: string | null;
  delivery_days: number | null;
  ad_rights_days?: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap: number | null;
  applicant_count: number;
  spots_left: number | null;
  open: boolean;
  closed_reason: "cap_reached" | "answer_by_passed" | "filled" | null;
};

export type TenantBrief = {
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
  utm_campaign: string | null;
  product_needed?: boolean;
  source_channel?: string | null;
  ad_rights_days?: number | null;
};

export type BriefWorkbenchResponse = {
  brief: TenantBrief;
  creator_preview: CreatorVisibleBrief;
  applicant_count: number;
  spots_line: string;
  answer_by_line: string;
  order_line: string;
  decline_note: string;
  decline_note_is_default: boolean;
};

export type ApplicantView = {
  application_id: string;
  human_member_id: string;
  display_name: string;
  slug: string | null;
  city: string | null;
  country_code: string | null;
  bookable: boolean;
  status: string;
  note: string;
  applied_at: string;
  quoted_rate_usd: number | null;
  fees: CreatorFees | null;
  hire_state?: "hired" | "cancelled" | "unpaid" | null;
};

export function applicantOutcome(a: Pick<ApplicantView, "status" | "hire_state">): string {
  if (a.status !== "approved") return "Not hired";
  if (a.hire_state === "cancelled") return "Hired, then cancelled";
  if (a.hire_state === "unpaid") return "Hire not paid, nothing charged";
  return "Hired";
}

export type BriefApplicantsResponse = {
  applicants: ApplicantView[];
  order: string;
  brief: CreatorVisibleBrief;
  applicant_count: number;
  spots_line: string;
  answer_by_line: string;
  decline_note: string;
  decline_note_is_default: boolean;
};

export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "not given";
  return `$${(cents / 100).toFixed(2)}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "no date set";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "no date set";
  return at.toISOString().slice(0, 10);
}

export function runningTotalLine(fees: CreatorFees | null): string {
  if (!fees) return "This applicant did not leave a price, so there is nothing to total up yet.";
  return `You pay ${usd(fees.business_total_cents)} in total: ${usd(fees.price_cents)} to the creator plus ${usd(
    fees.business_fee_cents,
  )} Zavi fee.`;
}

export function closedReasonLine(brief: CreatorVisibleBrief): string | null {
  if (brief.open) return null;
  if (!brief.posted_at) return "This brief has not been posted yet, so no creator can see it.";
  switch (brief.closed_reason) {
    case "cap_reached":
      return "Closed to new applications: the application limit was reached.";
    case "answer_by_passed":
      return "Closed: the answer-by date passed and everyone who applied has been told.";
    case "filled":
      return "Closed: you hired someone and everyone else has been told.";
    default:
      return "Closed to new applications.";
  }
}

export function bookableLine(a: ApplicantView): string | null {
  if (a.bookable) return null;
  return "Zavi cannot pay creators in this creator's country yet, so they cannot be hired. Nothing would be charged.";
}
