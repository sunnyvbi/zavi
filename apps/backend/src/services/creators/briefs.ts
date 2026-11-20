
import { ExpectedToolError } from "@/services/tools/types";
import { computeCreatorFees, MIN_BUSINESS_TOTAL_CENTS, type CreatorFeeBreakdown } from "./order-fees";
import { listOrdersByApplication } from "./booking-db";
import { isNeverPaidOrder } from "./order-state";
import { scrubContact } from "./contact-scrub";
import { isCreatorVideoChannel } from "@zavi/shared";
import {
  adRightsDays,
  BRIEF_BOARD_ORDER,
  answerByCopy,
  briefOpenState,
  briefSpotsLine,
  creatorVisibleBrief,
  type BriefFilters,
  type BriefLane,
  type CreatorVisibleBrief,
} from "./brief-projection";
import {
  countBriefApplications,
  insertTenantBrief,
  listBriefApplications,
  loadApplicantProfiles,
  loadTenantBrief,
  publishTenantBrief,
  resolveBusinessName,
  updateTenantBrief,
  type BriefApplicationRow,
  type BriefWritableFields,
  type TenantBriefRow,
} from "./briefs-db";

export const DEFAULT_ANSWER_BY_DAYS = 5;
export const DEFAULT_APPLICANT_CAP = 20;
export const APPLICANT_CAP_RANGE = { min: 1, max: 500 } as const;
export const DELIVERY_DAYS_RANGE = { min: 1, max: 90 } as const;

export const DEFAULT_DECLINE_NOTE =
  "Thanks for applying. We went with another creator for this brief. Nothing was charged and nothing is owed.";

export const MAX_DECLINE_NOTE_LEN = 2000;

export function quotedRateToCents(quoted_rate_usd: number | string | null | undefined): number {
  const n = typeof quoted_rate_usd === "string" ? Number(quoted_rate_usd) : quoted_rate_usd;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) {
    throw new ExpectedToolError(
      "invalid_quote",
      "A quote has to be a dollar amount greater than zero.",
    );
  }
  return Math.round(n * 100);
}

export function quoteFeeSplit(quoted_rate_usd: number | string): CreatorFeeBreakdown {
  return computeCreatorFees(quotedRateToCents(quoted_rate_usd));
}

export const MIN_QUOTE_CENTS = (() => {
  let cents = 1;
  while (computeCreatorFees(cents).business_total_cents < MIN_BUSINESS_TOTAL_CENTS) cents += 1;
  return cents;
})();

export function applicationQuoteFeeSplit(quoted_rate_usd: number | string): CreatorFeeBreakdown {
  const fees = quoteFeeSplit(quoted_rate_usd);
  if (fees.business_total_cents < MIN_BUSINESS_TOTAL_CENTS) {
    throw new ExpectedToolError(
      "quote_below_minimum",
      `That quote is too small to charge. The business has to pay at least $${(MIN_BUSINESS_TOTAL_CENTS / 100).toFixed(2)}, so quote at least $${(MIN_QUOTE_CENTS / 100).toFixed(2)}.`,
    );
  }
  return fees;
}

function requiredText(field: string, v: unknown, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length === 0) {
    throw new ExpectedToolError("brief_field_required", `${field} is required.`);
  }
  if (s.length > max) {
    throw new ExpectedToolError(
      "brief_field_too_long",
      `${field} has to be ${max} characters or fewer.`,
    );
  }
  return s;
}

function optionalInt(field: string, v: unknown, range: { min: number; max: number }): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < range.min || n > range.max) {
    throw new ExpectedToolError(
      "brief_field_out_of_range",
      `${field} has to be a whole number between ${range.min} and ${range.max}.`,
    );
  }
  return n;
}

function normaliseFilters(v: unknown): BriefFilters | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ExpectedToolError("brief_filters_invalid", "Filters have to be a set of lists.");
  }
  const src = v as Record<string, unknown>;
  const list = (key: string): string[] | undefined => {
    const raw = src[key];
    if (raw === null || raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw new ExpectedToolError("brief_filters_invalid", `Filter '${key}' has to be a list.`);
    }
    const vals = raw
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x.length > 0 && x.length <= 120)
      .slice(0, 25);
    return vals.length > 0 ? vals : undefined;
  };
  const out: BriefFilters = {};
  const niches = list("niches");
  const platforms = list("platforms");
  const locations = list("locations");
  if (niches) out.niches = niches;
  if (platforms) out.platforms = platforms;
  if (locations) out.locations = locations;
  return Object.keys(out).length > 0 ? out : null;
}

export type BriefInput = {
  title?: unknown;
  angle?: unknown;
  hook?: unknown;
  format?: unknown;
  deliverables?: unknown;
  budget_usd?: unknown;
  lane?: unknown;
  filters?: unknown;
  delivery_days?: unknown;
  applicant_cap?: unknown;
  answer_by?: unknown;
  decline_note?: unknown;
  product_needed?: unknown;
  source_channel?: unknown;
  ad_rights_days?: unknown;
};

export function validateBriefInput(
  input: BriefInput,
  opts: { partial: boolean },
): BriefWritableFields {
  const out: BriefWritableFields = {};
  const has = (k: keyof BriefInput) => input[k] !== undefined;

  if (!opts.partial || has("title")) out.title = requiredText("Title", input.title, 200);
  if (!opts.partial || has("angle")) out.angle = requiredText("Angle", input.angle, 600);
  if (!opts.partial || has("hook")) out.hook = requiredText("Hook", input.hook, 400);
  if (!opts.partial || has("format")) out.format = requiredText("Format", input.format, 120);

  if (has("deliverables")) {
    out.deliverables = optionalInt("Deliverables", input.deliverables, { min: 1, max: 20 });
  }
  if (has("delivery_days")) {
    out.delivery_days = optionalInt("Days to deliver", input.delivery_days, DELIVERY_DAYS_RANGE);
  }
  if (has("applicant_cap")) {
    out.applicant_cap = optionalInt("Application limit", input.applicant_cap, APPLICANT_CAP_RANGE);
  }
  if (has("budget_usd")) {
    const raw = input.budget_usd;
    if (raw === null || raw === "") out.budget_usd = null;
    else {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new ExpectedToolError("brief_budget_invalid", "Budget has to be zero or more.");
      }
      out.budget_usd = Math.round(n * 100) / 100;
    }
  }
  if (has("lane")) {
    const l = input.lane;
    if (l === null || l === "") out.lane = null;
    else if (l === "ugc_video") out.lane = l;
    else {
      throw new ExpectedToolError(
        "brief_lane_invalid",
        "The only lane is 'ugc_video'.",
      );
    }
  }
  if (has("filters")) out.filters = normaliseFilters(input.filters) as Record<string, unknown> | null;
  if (has("answer_by")) {
    const raw = input.answer_by;
    if (raw === null || raw === "") out.answer_by = null;
    else {
      const at = new Date(String(raw));
      if (Number.isNaN(at.getTime())) {
        throw new ExpectedToolError("brief_answer_by_invalid", "That answer-by date is not a date.");
      }
      out.answer_by = at.toISOString();
    }
  }
  if (has("product_needed")) {
    if (typeof input.product_needed !== "boolean") {
      throw new ExpectedToolError(
        "brief_product_needed_invalid",
        "Say yes or no to whether you ship the creator a product.",
      );
    }
    out.product_needed = input.product_needed;
  }
  if (has("source_channel")) {
    const raw = input.source_channel;
    if (raw === null || raw === "") out.source_channel = null;
    else if (isCreatorVideoChannel(raw)) out.source_channel = raw;
    else {
      throw new ExpectedToolError(
        "brief_source_channel_invalid",
        "That channel does not run creator videos.",
      );
    }
  }
  if (has("ad_rights_days")) {
    const raw = input.ad_rights_days;
    if (raw === null || raw === "") out.ad_rights_days = null;
    else {
      const days = adRightsDays(raw);
      if (days === null) {
        throw new ExpectedToolError(
          "brief_ad_rights_invalid",
          "Ad rights are 30, 90 or 365 days.",
        );
      }
      out.ad_rights_days = days;
    }
  }
  if (has("decline_note")) {
    const raw = input.decline_note;
    if (raw === null || raw === "") out.decline_note = null;
    else {
      const s = String(raw).trim();
      if (s.length === 0 || s.length > MAX_DECLINE_NOTE_LEN) {
        throw new ExpectedToolError(
          "brief_decline_note_invalid",
          `The note has to be between 1 and ${MAX_DECLINE_NOTE_LEN} characters.`,
        );
      }
      out.decline_note = s;
    }
  }
  return out;
}

export const BLANK_BRIEF: Required<
  Pick<BriefWritableFields, "title" | "angle" | "hook" | "format" | "rationale">
> = {
  title: "Untitled brief",
  angle: "Write what this brief is for.",
  hook: "Write the hook you want creators to open with.",
  format: "Write the format you want.",
  rationale: "Written by hand. No agent argued for this brief.",
};

export type SaveBriefDeps = {
  insert: typeof insertTenantBrief;
  update: typeof updateTenantBrief;
  load: typeof loadTenantBrief;
};

export const realSaveBriefDeps: SaveBriefDeps = {
  insert: insertTenantBrief,
  update: updateTenantBrief,
  load: loadTenantBrief,
};

export async function saveBrief(
  args: {
    tenant_id: string;
    brief_id?: string | null;
    input: BriefInput;
    blank?: boolean;
  },
  deps: SaveBriefDeps = realSaveBriefDeps,
): Promise<TenantBriefRow> {
  if (args.brief_id) {
    const fields = validateBriefInput(args.input, { partial: true });
    const current = await deps.load(args.tenant_id, args.brief_id);
    if (!current) throw briefNotFound();
    if (Object.keys(fields).length === 0) return current;
    if (isBriefLocked(current)) throw briefLocked();
    const saved = await deps.update(args.tenant_id, args.brief_id, fields);
    if (!saved) throw briefLocked();
    return saved;
  }

  const base = args.blank
    ? { ...BLANK_BRIEF }
    : { rationale: BLANK_BRIEF.rationale };
  const fields = validateBriefInput(
    { ...(args.blank ? BLANK_BRIEF : {}), ...args.input },
    { partial: false },
  );
  return deps.insert(args.tenant_id, { ...base, ...fields });
}

export function briefNotFound(): ExpectedToolError {
  return new ExpectedToolError("brief_not_found", "That brief does not exist.");
}

export function isBriefLocked(brief: Pick<TenantBriefRow, "status" | "posted_at">): boolean {
  return brief.status !== "draft" || Boolean(brief.posted_at);
}

export function briefLocked(): ExpectedToolError {
  return new ExpectedToolError(
    "brief_locked",
    "This brief is already posted, so it cannot be changed. Close it and repost it to make changes.",
  );
}

export type RepostBriefDeps = {
  load: typeof loadTenantBrief;
  insert: typeof insertTenantBrief;
  closeOld: (args: { tenant_id: string; brief_id: string }) => Promise<unknown>;
};

export async function repostBrief(
  args: { tenant_id: string; brief_id: string },
  deps: RepostBriefDeps,
): Promise<{ brief: TenantBriefRow; closed_brief_id: string }> {
  const old = await deps.load(args.tenant_id, args.brief_id);
  if (!old) throw briefNotFound();
  if (!isBriefLocked(old)) {
    throw new ExpectedToolError(
      "brief_not_posted",
      "This brief is still a draft. Edit it directly instead of reposting it.",
    );
  }
  const copy: BriefWritableFields = {
    title: old.title ?? BLANK_BRIEF.title,
    angle: old.angle ?? BLANK_BRIEF.angle,
    hook: old.hook ?? BLANK_BRIEF.hook,
    format: old.format ?? BLANK_BRIEF.format,
    rationale: old.rationale ?? BLANK_BRIEF.rationale,
    evidence: old.evidence ?? null,
    deliverables: old.deliverables ?? null,
    budget_usd: old.budget_usd == null ? null : Number(old.budget_usd),
    lane: old.lane === "ugc_video" ? "ugc_video" : null,
    filters: old.filters ?? null,
    delivery_days: old.delivery_days ?? null,
    applicant_cap: old.applicant_cap ?? null,
    decline_note: old.decline_note ?? null,
    product_needed: old.product_needed === true,
    source_channel: old.source_channel ?? null,
    ad_rights_days: adRightsDays(old.ad_rights_days),
    ...(old.source_campaign_ref ? { source_campaign_ref: old.source_campaign_ref } : {}),
  };
  const brief = await deps.insert(args.tenant_id, copy);
  await deps.closeOld({ tenant_id: args.tenant_id, brief_id: old.id });
  return { brief, closed_brief_id: old.id };
}

export type PublishBriefDeps = SaveBriefDeps & {
  publish: typeof publishTenantBrief;
};

export const realPublishBriefDeps: PublishBriefDeps = {
  ...realSaveBriefDeps,
  publish: publishTenantBrief,
};

export type PublishBriefResult =
  | {
      ok: true;
      first_publish: boolean;
      brief: TenantBriefRow;
      answer_by: string;
      applicant_cap: number | null;
    }
  | { ok: false; code: "brief_not_found" | "brief_incomplete"; message: string };

export async function publishBrief(
  args: {
    tenant_id: string;
    brief_id: string;
    answer_by?: string | Date | null;
    applicant_cap?: number | null;
    now?: Date;
  },
  deps: PublishBriefDeps = realPublishBriefDeps,
): Promise<PublishBriefResult> {
  const now = args.now ?? new Date();
  const current = await deps.load(args.tenant_id, args.brief_id);
  if (!current) return { ok: false, code: "brief_not_found", message: "That brief does not exist." };

  if (current.posted_at) {
    return {
      ok: true,
      first_publish: false,
      brief: current,
      answer_by: current.answer_by ?? "",
      applicant_cap: current.applicant_cap ?? null,
    };
  }

  for (const [field, value] of [
    ["Title", current.title],
    ["Angle", current.angle],
    ["Hook", current.hook],
    ["Format", current.format],
  ] as const) {
    if (!(value ?? "").trim()) {
      return {
        ok: false,
        code: "brief_incomplete",
        message: `${field} is empty. Fill it in before you post this brief.`,
      };
    }
  }

  if (adRightsDays(current.ad_rights_days) === null) {
    return {
      ok: false,
      code: "brief_incomplete",
      message: "Ad rights are not set. Pick 30, 90 or 365 days before you post this brief.",
    };
  }

  const answer_by = resolveAnswerBy(args.answer_by ?? current.answer_by, now);
  const applicant_cap =
    args.applicant_cap === undefined
      ? (current.applicant_cap ?? DEFAULT_APPLICANT_CAP)
      : args.applicant_cap;
  if (applicant_cap !== null) {
    optionalInt("Application limit", applicant_cap, APPLICANT_CAP_RANGE);
  }

  const posted = await deps.publish({
    tenant_id: args.tenant_id,
    brief_id: args.brief_id,
    posted_at: now.toISOString(),
    answer_by,
    applicant_cap,
  });
  if (!posted) {
    const again = await deps.load(args.tenant_id, args.brief_id);
    if (!again) return { ok: false, code: "brief_not_found", message: "That brief does not exist." };
    return {
      ok: true,
      first_publish: false,
      brief: again,
      answer_by: again.answer_by ?? "",
      applicant_cap: again.applicant_cap ?? null,
    };
  }
  return { ok: true, first_publish: true, brief: posted, answer_by, applicant_cap };
}

export function resolveAnswerBy(
  requested: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (requested) {
    const at = typeof requested === "string" ? new Date(requested) : requested;
    if (!Number.isNaN(at.getTime()) && at.getTime() > now.getTime()) return at.toISOString();
  }
  return new Date(now.getTime() + DEFAULT_ANSWER_BY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export type BriefWorkbench = {
  brief: TenantBriefRow;
  creator_preview: CreatorVisibleBrief;
  applicant_count: number;
  spots_line: string;
  answer_by_line: string;
  order_line: string;
  decline_note: string;
  decline_note_is_default: boolean;
};

export type BriefWorkbenchDeps = {
  load: typeof loadTenantBrief;
  count: typeof countBriefApplications;
  businessName: typeof resolveBusinessName;
};

export const realBriefWorkbenchDeps: BriefWorkbenchDeps = {
  load: loadTenantBrief,
  count: countBriefApplications,
  businessName: resolveBusinessName,
};

export async function briefWorkbench(
  args: { tenant_id: string; brief_id: string; now?: Date },
  deps: BriefWorkbenchDeps = realBriefWorkbenchDeps,
): Promise<BriefWorkbench | null> {
  const brief = await deps.load(args.tenant_id, args.brief_id);
  if (!brief) return null;
  const [applicant_count, business_name] = await Promise.all([
    deps.count(args.tenant_id, args.brief_id),
    deps.businessName(args.tenant_id),
  ]);
  const creator_preview = creatorVisibleBrief(brief, {
    business_name,
    applicant_count,
    now: args.now,
  });
  const note = (brief.decline_note ?? "").trim();
  return {
    brief,
    creator_preview,
    applicant_count,
    spots_line: briefSpotsLine(creator_preview),
    answer_by_line: answerByCopy(brief.answer_by).line,
    order_line: BRIEF_BOARD_ORDER,
    decline_note: note.length > 0 ? note : DEFAULT_DECLINE_NOTE,
    decline_note_is_default: note.length === 0,
  };
}

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
  fees: CreatorFeeBreakdown | null;
  hire_state: "hired" | "cancelled" | "unpaid" | null;
};

export type ApplicantListDeps = {
  load: typeof loadTenantBrief;
  listApplications: typeof listBriefApplications;
  profiles: typeof loadApplicantProfiles;
  hireOrders?: typeof listOrdersByApplication;
};

export const realApplicantListDeps: ApplicantListDeps = {
  load: loadTenantBrief,
  listApplications: listBriefApplications,
  profiles: loadApplicantProfiles,
  hireOrders: listOrdersByApplication,
};

function hireState(
  row: Pick<BriefApplicationRow, "status">,
  order: { status: string; closed_reason: string | null } | undefined,
): ApplicantView["hire_state"] {
  if (row.status !== "approved") return null;
  if (!order) return "hired";
  if (isNeverPaidOrder(order)) return "unpaid";
  return order.status === "cancelled" ? "cancelled" : "hired";
}

export async function listApplicantsForBusiness(
  args: { tenant_id: string; brief_id: string },
  deps: ApplicantListDeps = realApplicantListDeps,
): Promise<{ applicants: ApplicantView[]; order: string } | null> {
  const brief = await deps.load(args.tenant_id, args.brief_id);
  if (!brief) return null;
  const rows = await deps.listApplications(args.tenant_id, args.brief_id);
  const profiles = await deps.profiles({
    tenant_id: args.tenant_id,
    human_member_ids: rows.map((r) => r.human_member_id),
  });
  const hired = rows.filter((r) => r.status === "approved").map((r) => r.id);
  const orders = hired.length > 0 && deps.hireOrders ? await deps.hireOrders(args.tenant_id, hired) : new Map();
  return {
    applicants: rows.map((r) => ({ ...applicantView(r, profiles.get(r.human_member_id)), hire_state: hireState(r, orders.get(r.id)) })),
    order: "Oldest first. Applicants are never ranked by fit or quality.",
  };
}

function applicantView(
  row: BriefApplicationRow,
  profile:
    | { display_name: string; slug: string | null; city: string | null; country_code: string | null; bookable: boolean }
    | undefined,
): Omit<ApplicantView, "hire_state"> {
  const quoted =
    row.quoted_rate_usd === null || row.quoted_rate_usd === undefined
      ? null
      : Number(row.quoted_rate_usd);
  let fees: CreatorFeeBreakdown | null = null;
  if (quoted !== null && Number.isFinite(quoted) && quoted > 0) {
    try {
      fees = quoteFeeSplit(quoted);
    } catch {
      fees = null;
    }
  }
  return {
    application_id: row.id,
    human_member_id: row.human_member_id,
    display_name: profile?.display_name ?? "",
    slug: profile?.slug ?? null,
    city: profile?.city ?? null,
    country_code: profile?.country_code ?? null,
    bookable: profile?.bookable === true,
    status: row.status,
    note: scrubContact((row.pitch ?? "").trim()).body,
    applied_at: row.created_at,
    quoted_rate_usd: quoted !== null && Number.isFinite(quoted) ? quoted : null,
    fees,
  };
}

export {
  BRIEF_BOARD_ORDER,
  answerByCopy,
  briefOpenState,
  briefSpotsLine,
  creatorVisibleBrief,
  type BriefFilters,
  type BriefLane,
  type CreatorVisibleBrief,
};
