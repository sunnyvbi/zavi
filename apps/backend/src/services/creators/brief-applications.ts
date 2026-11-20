
import { businessApplicantsLink } from "./hub-links";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import {
  BRIEF_BOARD_ORDER,
  answerByCopy,
  briefBoardCountLine,
  briefOpenState,
  briefSpotsLine,
  creatorVisibleBrief,
  type CreatorVisibleBrief,
} from "./brief-projection";
import {
  DEFAULT_DECLINE_NOTE,
  applicationQuoteFeeSplit,
  quoteFeeSplit,
  quotedRateToCents,
} from "./briefs";
import { creatorPayoutCountrySupported } from "./payout-countries";
import type { CreatorFeeBreakdown } from "./order-fees";
import {
  claimPendingApplications,
  closeTenantBrief,
  countBoardBriefApplications,
  countBriefApplications,
  declineApprovedApplication,
  insertBriefApplication,
  listAppliedBriefIds,
  bookingCaptured,
  linkBookingToPendingApplication,
  liveBookingsOnBrief,
  listAppliedClosedBriefs,
  listBoardBriefs,
  loadBoardBrief,
  loadBoardMemberByAuthUser,
  loadTenantBrief,
  orderNeverPaid,
  resolveBriefTenant,
  resolveBusinessName,
  type BriefApplicationRow,
  type BoardMemberRow,
} from "./briefs-db";
import { notify, type NotifyResult } from "./notify";
import { scrubContact } from "./contact-scrub";
import { tenantClient, asTenantId } from "@/services/tenant-client";

export const MAX_APPLICATION_NOTE_LEN = 4000;

export type BoardBriefCard = CreatorVisibleBrief & {
  spots_line: string;
  answer_by_line: string;
};

export type CreatorBoard = {
  briefs: BoardBriefCard[];
  applied_closed: BoardBriefCard[];
  order: string;
  count_line: string;
  lanes: string[];
  apply: {
    available: true;
    endpoint: string;
    method: "POST";
  };
};

export type BoardDeps = {
  listBriefs: typeof listBoardBriefs;
  counts: typeof countBoardBriefApplications;
  businessNames: (tenant_ids: string[]) => Promise<Map<string, string>>;
  appliedClosed?: typeof listAppliedClosedBriefs;
  appliedBriefIds?: typeof listAppliedBriefIds;
};

async function boardBusinessNames(brief_ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (brief_ids.length === 0) return out;
  for (const brief_id of brief_ids) {
    const ref = await resolveBriefTenant(brief_id);
    if (!ref) continue;
    out.set(brief_id, await resolveBusinessName(ref.tenant_id));
  }
  return out;
}

export const realBoardDeps: BoardDeps = {
  listBriefs: listBoardBriefs,
  counts: countBoardBriefApplications,
  businessNames: boardBusinessNames,
  appliedClosed: listAppliedClosedBriefs,
  appliedBriefIds: listAppliedBriefIds,
};

export function briefApplyEndpoint(brief_id: string): string {
  return `/api/humans/open-briefs/${encodeURIComponent(brief_id)}/apply`;
}

export async function creatorBoard(
  args: {
    member: Pick<BoardMemberRow, "lanes"> & { id?: string };
    limit?: number;
    now?: Date;
  },
  deps: BoardDeps = realBoardDeps,
): Promise<CreatorBoard> {
  const lanes = (args.member.lanes ?? []).filter((l) => typeof l === "string" && l.length > 0);
  const rows = await deps.listBriefs({ lanes, limit: args.limit });
  const closedRows =
    args.member.id && deps.appliedClosed ? await deps.appliedClosed(args.member.id) : [];
  const all = [...rows, ...closedRows];
  const counts = await deps.counts(all.map((r) => r.id));
  const names = await deps.businessNames(all.map((r) => r.id));

  const now = args.now ?? new Date();
  const toCard = (row: (typeof all)[number]): BoardBriefCard => {
    const brief = creatorVisibleBrief(row, {
      business_name: names.get(row.id) ?? "",
      applicant_count: counts.get(row.id) ?? 0,
      now,
    });
    return {
      ...brief,
      spots_line: briefSpotsLine(brief),
      answer_by_line: answerByCopy(brief.answer_by).line,
    };
  };
  const isOpen = (row: (typeof all)[number]) => briefOpenState(row, counts.get(row.id) ?? 0, now).open;
  const openRows = rows.filter(isOpen);
  const shutRows = rows.filter((r) => !isOpen(r));
  const mine =
    shutRows.length > 0 && args.member.id && deps.appliedBriefIds
      ? new Set(await deps.appliedBriefIds(args.member.id))
      : new Set<string>();
  const briefs = openRows.map(toCard);
  const openIds = new Set(openRows.map((r) => r.id));
  const seen = new Set<string>();
  const applied_closed = [...shutRows.filter((r) => mine.has(r.id)), ...closedRows]
    .filter((r) => !openIds.has(r.id) && !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => String(b.posted_at ?? "").localeCompare(String(a.posted_at ?? "")))
    .map(toCard);

  return {
    briefs,
    applied_closed,
    order: BRIEF_BOARD_ORDER,
    count_line: briefBoardCountLine(briefs.length, lanes.length),
    lanes,
    apply: { available: true, endpoint: "/api/humans/open-briefs/:briefId/apply", method: "POST" },
  };
}

export type ApplyRefusal =
  | "not_a_creator"
  | "not_approved"
  | "affiliate_only"
  | "brief_not_found"
  | "brief_closed"
  | "cap_reached"
  | "already_applied"
  | "payout_country_unsupported"
  | "lane_mismatch"
  | "invalid_quote"
  | "quote_below_minimum";

export type ApplyToBriefResult =
  | {
      ok: true;
      application_id: string;
      brief: CreatorVisibleBrief;
      fees: CreatorFeeBreakdown;
      answer_by_line: string;
      spots_line: string;
    }
  | { ok: false; code: ApplyRefusal; message: string };

export type ApplyDeps = {
  loadMember: typeof loadBoardMemberByAuthUser;
  loadBrief: typeof loadBoardBrief;
  resolveTenant: typeof resolveBriefTenant;
  count: typeof countBriefApplications;
  insert: (args: {
    tenant_id: string;
    brief_id: string;
    human_member_id: string;
    pitch: string | null;
    quoted_rate_usd: number;
  }) => Promise<{ ok: true; application_id: string } | { ok: false; duplicate: true }>;
  businessName: typeof resolveBusinessName;
  closeBrief?: typeof closeTenantBrief;
  notify: typeof notify;
};

export const realApplyDeps: ApplyDeps = {
  loadMember: loadBoardMemberByAuthUser,
  loadBrief: loadBoardBrief,
  resolveTenant: resolveBriefTenant,
  count: countBriefApplications,
  insert: insertBriefApplication,
  businessName: resolveBusinessName,
  notify,
};

export async function applyToBrief(
  args: {
    auth_user_id: string;
    brief_id: string;
    quoted_rate_usd: number | string;
    note?: string | null;
    now?: Date;
  },
  deps: ApplyDeps,
): Promise<ApplyToBriefResult> {
  const now = args.now ?? new Date();

  const member = await deps.loadMember(args.auth_user_id);
  if (!member) {
    return { ok: false, code: "not_a_creator", message: "You are not a Zavi creator." };
  }
  if (member.vetting_state !== "approved") {
    return {
      ok: false,
      code: "not_approved",
      message: "Your creator profile is not approved yet.",
    };
  }
  if (member.earn_mode === "affiliate") {
    return {
      ok: false,
      code: "affiliate_only",
      message: "You picked Refer customers only. Add Paid creator jobs in How you want to earn to apply to briefs.",
    };
  }
  if (!creatorPayoutCountrySupported(member.country_code ?? "")) {
    return {
      ok: false,
      code: "payout_country_unsupported",
      message:
        "Zavi cannot pay creators in your country yet, so you cannot be hired from a brief. Your profile stays as it is and we will tell you when this changes.",
    };
  }

  let fees: CreatorFeeBreakdown;
  try {
    fees = applicationQuoteFeeSplit(args.quoted_rate_usd);
  } catch (e) {
    return {
      ok: false,
      code: e instanceof ExpectedToolError && e.code === "quote_below_minimum" ? "quote_below_minimum" : "invalid_quote",
      message: e instanceof ExpectedToolError ? e.message : "That quote is not a dollar amount.",
    };
  }

  const row = await deps.loadBrief(args.brief_id);
  const ref = row ? await deps.resolveTenant(args.brief_id) : null;
  if (!row || !ref) {
    return { ok: false, code: "brief_not_found", message: "That brief is not open." };
  }

  const memberLanes = (member.lanes ?? []).filter((l) => typeof l === "string" && l.length > 0);
  const briefLane = row.lane ?? "ugc_video";
  if (memberLanes.length > 0 && !memberLanes.includes(briefLane)) {
    return {
      ok: false,
      code: "lane_mismatch",
      message: "This brief is for ad videos, and your profile does not offer those. Add ad videos to your profile to apply.",
    };
  }

  const business_name = await deps.businessName(ref.tenant_id);
  const countBefore = await deps.count(ref.tenant_id, args.brief_id);
  const state = briefOpenState(row, countBefore, now);
  if (!state.open) {
    if (state.closed_reason === "cap_reached") {
      return {
        ok: false,
        code: "cap_reached",
        message: "This brief has taken all the applications it will take.",
      };
    }
    return {
      ok: false,
      code: "brief_closed",
      message:
        state.closed_reason === "answer_by_passed"
          ? "This brief closed when its answer-by date passed."
          : "This brief is no longer taking applications.",
    };
  }

  const inserted = await deps.insert({
    tenant_id: ref.tenant_id,
    brief_id: args.brief_id,
    human_member_id: member.id,
    pitch: normaliseNote(args.note),
    quoted_rate_usd: fees.price_cents / 100,
  });
  if (!inserted.ok) {
    return {
      ok: false,
      code: "already_applied",
      message: "You have already applied to this brief. One application per brief.",
    };
  }

  const countAfter = await deps.count(ref.tenant_id, args.brief_id);

  const brief = creatorVisibleBrief(row, {
    business_name,
    applicant_count: countAfter,
    now,
  });

  try {
    await deps.notify({
      recipient: { kind: "tenant", tenant_id: ref.tenant_id },
      event: "brief_application_received",
      scope_id: inserted.application_id,
      vars: {
        business_name,
        creator_name: member.display_name,
        brief_title: brief.title,
        job_title: brief.title,
        price_cents: fees.price_cents,
        business_total_cents: fees.business_total_cents,
        payout_cents: fees.creator_payout_cents,
        link_path: businessApplicantsLink(args.brief_id),
      },
    });
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "creator.briefs",
      code: "apply_notify_failed",
      message: (e as Error).message,
      tenant_id: ref.tenant_id,
    });
  }

  return {
    ok: true,
    application_id: inserted.application_id,
    brief,
    fees,
    answer_by_line: answerByCopy(brief.answer_by).line,
    spots_line: briefSpotsLine(brief),
  };
}

function normaliseNote(note: string | null | undefined): string | null {
  const s = (note ?? "").trim();
  if (s.length === 0) return null;
  return scrubContact(s).body.slice(0, MAX_APPLICATION_NOTE_LEN);
}

export async function myApplication(args: {
  tenant_id: string;
  brief_id: string;
  human_member_id: string;
}): Promise<{
  application: BriefApplicationRow;
  fees: CreatorFeeBreakdown | null;
  hired_order_id: string | null;
  hired_order_status: string | null;
  business_note: string | null;
} | null> {
  const db = tenantClient(asTenantId(args.tenant_id));
  const { data, error } = await db
    .from("brief_applications")
    .select("id, tenant_id, brief_id, brief_kind, human_member_id, status, pitch, quoted_rate_usd, created_at")
    .eq("brief_id", args.brief_id)
    .eq("human_member_id", args.human_member_id)
    .maybeSingle();
  if (error) throw new Error(`myApplication failed: ${error.message}`);
  const application = (data as BriefApplicationRow | null) ?? null;
  if (!application) return null;
  let fees: CreatorFeeBreakdown | null = null;
  try {
    if (application.quoted_rate_usd !== null && application.quoted_rate_usd !== undefined) {
      fees = quoteFeeSplit(application.quoted_rate_usd);
    }
  } catch {
    fees = null;
  }

  let hired_order_id: string | null = null;
  let hired_order_status: string | null = null;
  if (application.status === "approved") {
    const { data: orders, error: orderError } = await db
      .from("creator_orders")
      .select("id, status, closed_reason")
      .eq("application_id", application.id)
      .eq("human_member_id", args.human_member_id)
      .order("created_at", { ascending: false });
    if (orderError) throw new Error(`myApplication order read failed: ${orderError.message}`);
    const rows = (orders ?? []) as { id: string; status: string; closed_reason: string | null }[];
    const o = rows.find((r) => r.status !== "cancelled") ?? rows[0] ?? null;
    if (o && !orderNeverPaid(o)) {
      hired_order_id = o.id;
      hired_order_status = o.status;
    }
  }

  let business_note: string | null = null;
  if (application.status === "rejected") {
    const brief = await loadTenantBrief(args.tenant_id, args.brief_id);
    business_note = (brief?.decline_note ?? "").trim() || DEFAULT_DECLINE_NOTE;
  }

  return { application, fees, hired_order_id, hired_order_status, business_note };
}

export { orderNeverPaid };

export type AutoNoCause = "hire" | "answer_by";

export type AutoNoResult = {
  declined: number;
  notified: number;
  closed_by_this_call: boolean;
  note: string;
};

export type AutoNoDeps = {
  loadBrief: typeof loadTenantBrief;
  closeBrief: typeof closeTenantBrief;
  claim: typeof claimPendingApplications;
  businessName: typeof resolveBusinessName;
  notify: typeof notify;
  liveBookings: typeof liveBookingsOnBrief;
  relinkBooking: typeof linkBookingToPendingApplication;
};

export const realAutoNoDeps: AutoNoDeps = {
  loadBrief: loadTenantBrief,
  closeBrief: closeTenantBrief,
  claim: claimPendingApplications,
  businessName: resolveBusinessName,
  notify,
  liveBookings: liveBookingsOnBrief,
  relinkBooking: linkBookingToPendingApplication,
};

export async function hireFromBookedBrief(
  args: { tenant_id: string; brief_id: string; order_id: string; human_member_id: string },
  deps: {
    link: typeof linkBookingToPendingApplication;
    nos: (a: { tenant_id: string; brief_id: string; cause: AutoNoCause; hired_application_id: string }) => Promise<unknown>;
  } = { link: linkBookingToPendingApplication, nos: (a) => sendAutomaticNos(a, realAutoNoDeps) },
): Promise<string | null> {
  const linked = await deps.link(args);
  if (!linked) return null;
  if (linked.filled_brief) {
    await deps.nos({ tenant_id: args.tenant_id, brief_id: args.brief_id, cause: "hire", hired_application_id: linked.application_id });
  }
  return linked.application_id;
}

export async function sendAutomaticNos(
  args: {
    tenant_id: string;
    brief_id: string;
    cause: AutoNoCause;
    hired_application_id?: string | null;
    now?: Date;
  },
  deps: AutoNoDeps = realAutoNoDeps,
): Promise<AutoNoResult> {
  const now = args.now ?? new Date();
  const brief = await deps.loadBrief(args.tenant_id, args.brief_id);
  if (!brief) {
    return { declined: 0, notified: 0, closed_by_this_call: false, note: DEFAULT_DECLINE_NOTE };
  }

  const note = (brief.decline_note ?? "").trim() || DEFAULT_DECLINE_NOTE;

  const bookings = await deps.liveBookings({ tenant_id: args.tenant_id, brief_id: args.brief_id });
  for (const b of bookings) {
    if (b.application_id || !bookingCaptured(b.status)) continue;
    try {
      await deps.relinkBooking({
        tenant_id: args.tenant_id,
        brief_id: args.brief_id,
        order_id: b.order_id,
        human_member_id: b.human_member_id,
      });
    } catch (e) {
      await logEvent({
        level: "error",
        source: "creator.briefs",
        code: "booking_link_failed",
        message: (e as Error).message.slice(0, 300),
        tenant_id: args.tenant_id,
        meta: { brief_id: args.brief_id, creator_order_id: b.order_id },
      }).catch(() => undefined);
    }
  }

  const closed = await deps.closeBrief({
    tenant_id: args.tenant_id,
    brief_id: args.brief_id,
    closed_at: now.toISOString(),
    status: args.cause === "hire" ? "filled" : "sent",
  });

  const claimed = await deps.claim({
    tenant_id: args.tenant_id,
    brief_id: args.brief_id,
    except_application_id: args.hired_application_id ?? null,
    except_human_member_ids: Array.from(new Set(bookings.map((b) => b.human_member_id))),
  });

  const business_name = await deps.businessName(args.tenant_id);
  let notified = 0;
  for (const application of claimed) {
    try {
      const res: NotifyResult = await deps.notify({
        recipient: { kind: "creator", human_member_id: application.human_member_id },
        event: "not_hired",
        scope_id: application.id,
        vars: {
          business_name,
          brief_title: brief.title ?? "",
          job_title: brief.title ?? "",
          note,
          link_path: "/creator/briefs",
        },
      });
      if (res.written) notified += 1;
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "creator.briefs",
        code: "auto_no_notify_failed",
        message: (e as Error).message,
        tenant_id: args.tenant_id,
        meta: { brief_id: args.brief_id, application_id: application.id },
      });
    }
  }

  return {
    declined: claimed.length,
    notified,
    closed_by_this_call: closed !== null,
    note,
  };
}

export type FitAlertResult = { matched: number; alerted: number };

export async function sendBriefFitAlerts(
  args: {
    tenant_id: string;
    brief_id: string;
    brief_title: string;
    lane: string | null;
    filters: { niches?: string[]; platforms?: string[]; locations?: string[] } | null;
  },
  deps: {
    match: (a: {
      tenant_id: string;
      lane: string | null;
      niches: string[];
      platforms: string[];
      locations: string[];
    }) => Promise<{ human_member_id: string; display_name: string }[]>;
    businessName: typeof resolveBusinessName;
    notify: typeof notify;
  },
): Promise<FitAlertResult> {
  const f = args.filters ?? {};
  const matched = await deps.match({
    tenant_id: args.tenant_id,
    lane: args.lane,
    niches: f.niches ?? [],
    platforms: f.platforms ?? [],
    locations: f.locations ?? [],
  });
  const business_name = await deps.businessName(args.tenant_id);
  let alerted = 0;
  for (const m of matched) {
    try {
      const res = await deps.notify({
        recipient: { kind: "creator", human_member_id: m.human_member_id },
        event: "brief_fits_you",
        scope_id: args.brief_id,
        vars: { business_name, brief_title: args.brief_title },
      });
      if (res.written) alerted += 1;
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "creator.briefs",
        code: "fit_alert_failed",
        message: (e as Error).message,
        tenant_id: args.tenant_id,
        meta: { brief_id: args.brief_id },
      });
    }
  }
  return { matched: matched.length, alerted };
}

export { quotedRateToCents, quoteFeeSplit, DEFAULT_DECLINE_NOTE };

export type LateHireDeps = {
  loadBrief: typeof loadTenantBrief;
  decline: typeof declineApprovedApplication;
  businessName: typeof resolveBusinessName;
  notify: typeof notify;
};

export const realLateHireDeps: LateHireDeps = {
  loadBrief: loadTenantBrief,
  decline: declineApprovedApplication,
  businessName: resolveBusinessName,
  notify,
};

export async function declineLateHire(
  args: { tenant_id: string; brief_id: string; application_id: string },
  deps: LateHireDeps = realLateHireDeps,
): Promise<{ declined: boolean }> {
  const row = await deps.decline({ tenant_id: args.tenant_id, application_id: args.application_id });
  if (!row) return { declined: false };
  const brief = await deps.loadBrief(args.tenant_id, args.brief_id);
  const note = (brief?.decline_note ?? "").trim() || DEFAULT_DECLINE_NOTE;
  await deps.notify({
    recipient: { kind: "creator", human_member_id: row.human_member_id },
    event: "not_hired",
    scope_id: row.id,
    vars: {
      business_name: await deps.businessName(args.tenant_id),
      brief_title: brief?.title ?? "",
      job_title: brief?.title ?? "",
      note,
      link_path: "/creator/briefs",
    },
  });
  return { declined: true };
}
