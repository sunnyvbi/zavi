
import {
  asTenantId,
  creatorAreaClient,
  creatorBoardClient,
  globalClient,
  preTenantRpc,
  tenantClient,
  tenantRpc,
} from "@/services/tenant-client";
import { CREATOR_BRIEF_COLUMNS, type CreatorBriefSourceRow } from "./brief-projection";
import { creatorPayoutCountrySupported } from "./payout-countries";

const BRIEFS = "creator_briefs";
const APPLICATIONS = "brief_applications";

export const CREATIVE_BRIEF_KIND = "creative";

export const PENDING_APPLICATION_STATUSES = ["applied", "shortlisted"] as const;

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what} failed: ${error.message}`);
}

export type TenantBriefRow = CreatorBriefSourceRow & {
  tenant_id: string;
  status: string;
  rationale: string | null;
  evidence: unknown;
  source_campaign_ref: string | null;
  source_run_id: string | null;
  utm_campaign: string | null;
  filters: Record<string, unknown> | null;
  decline_note: string | null;
  product_needed?: boolean;
  source_channel?: string | null;
  created_at: string;
  updated_at: string | null;
};

const TENANT_BRIEF_COLUMNS =
  "id, tenant_id, status, title, angle, hook, format, deliverables, rationale, evidence, " +
  "source_campaign_ref, source_run_id, budget_usd, utm_campaign, lane, filters, " +
  "delivery_days, posted_at, answer_by, applicant_cap, decline_note, closed_at, " +
  "product_needed, source_channel, ad_rights_days, created_at, updated_at";

export async function loadTenantBrief(
  tenant_id: string,
  brief_id: string,
): Promise<TenantBriefRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(BRIEFS)
    .select(TENANT_BRIEF_COLUMNS)
    .eq("id", brief_id)
    .maybeSingle();
  if (error) fail("loadTenantBrief", error);
  return (data as TenantBriefRow | null) ?? null;
}

export type BriefWritableFields = {
  title?: string;
  angle?: string;
  hook?: string;
  format?: string;
  deliverables?: number | null;
  budget_usd?: number | null;
  lane?: string | null;
  filters?: Record<string, unknown> | null;
  delivery_days?: number | null;
  applicant_cap?: number | null;
  answer_by?: string | null;
  decline_note?: string | null;
  product_needed?: boolean;
  source_channel?: string | null;
  ad_rights_days?: number | null;
  rationale?: string;
  evidence?: unknown;
  source_campaign_ref?: string;
};

export async function insertTenantBrief(
  tenant_id: string,
  fields: BriefWritableFields,
): Promise<TenantBriefRow> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(BRIEFS)
    .insert({ ...fields, status: "draft" })
    .select(TENANT_BRIEF_COLUMNS)
    .single();
  if (error) fail("insertTenantBrief", error);
  return data as unknown as TenantBriefRow;
}

export async function updateTenantBrief(
  tenant_id: string,
  brief_id: string,
  patch: BriefWritableFields,
): Promise<TenantBriefRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(BRIEFS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", brief_id)
    .eq("status", "draft")
    .is("posted_at", null)
    .select(TENANT_BRIEF_COLUMNS)
    .maybeSingle();
  if (error) fail("updateTenantBrief", error);
  return (data as TenantBriefRow | null) ?? null;
}

export async function publishTenantBrief(args: {
  tenant_id: string;
  brief_id: string;
  posted_at: string;
  answer_by: string;
  applicant_cap: number | null;
}): Promise<TenantBriefRow | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(BRIEFS)
    .update({
      posted_at: args.posted_at,
      answer_by: args.answer_by,
      applicant_cap: args.applicant_cap,
      status: "sent",
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.brief_id)
    .is("posted_at", null)
    .select(TENANT_BRIEF_COLUMNS)
    .maybeSingle();
  if (error) fail("publishTenantBrief", error);
  return (data as TenantBriefRow | null) ?? null;
}

export async function closeTenantBrief(args: {
  tenant_id: string;
  brief_id: string;
  closed_at: string;
  status?: "filled" | "sent";
}): Promise<TenantBriefRow | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(BRIEFS)
    .update({
      closed_at: args.closed_at,
      ...(args.status ? { status: args.status } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.brief_id)
    .is("closed_at", null)
    .select(TENANT_BRIEF_COLUMNS)
    .maybeSingle();
  if (error) fail("closeTenantBrief", error);
  return (data as TenantBriefRow | null) ?? null;
}

export async function listTenantPostedBriefs(
  tenant_id: string,
  limit = 50,
): Promise<TenantBriefRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(BRIEFS)
    .select(TENANT_BRIEF_COLUMNS)
    .not("posted_at", "is", null)
    .order("posted_at", { ascending: false })
    .limit(Math.min(limit, 100));
  if (error) fail("listTenantPostedBriefs", error);
  return (data as TenantBriefRow[] | null) ?? [];
}

export async function resolveBusinessName(tenant_id: string): Promise<string> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenants")
    .select("display_name")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) fail("resolveBusinessName", error);
  return ((data as { display_name?: string } | null)?.display_name ?? "").trim();
}

export type BriefApplicationRow = {
  id: string;
  tenant_id: string;
  brief_id: string;
  brief_kind: string;
  human_member_id: string;
  status: string;
  pitch: string | null;
  quoted_rate_usd: number | string | null;
  created_at: string;
};

const APPLICATION_COLUMNS =
  "id, tenant_id, brief_id, brief_kind, human_member_id, status, pitch, quoted_rate_usd, created_at";

export async function listBriefApplications(
  tenant_id: string,
  brief_id: string,
): Promise<BriefApplicationRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(APPLICATIONS)
    .select(APPLICATION_COLUMNS)
    .eq("brief_id", brief_id)
    .eq("brief_kind", CREATIVE_BRIEF_KIND)
    .order("created_at", { ascending: true });
  if (error) fail("listBriefApplications", error);
  return (data as BriefApplicationRow[] | null) ?? [];
}

export async function loadBriefApplication(
  tenant_id: string,
  application_id: string,
): Promise<BriefApplicationRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(APPLICATIONS)
    .select(APPLICATION_COLUMNS)
    .eq("id", application_id)
    .maybeSingle();
  if (error) fail("loadBriefApplication", error);
  return (data as BriefApplicationRow | null) ?? null;
}

export async function countBriefApplications(
  tenant_id: string,
  brief_id: string,
): Promise<number> {
  const { count, error } = await tenantClient(asTenantId(tenant_id))
    .from(APPLICATIONS)
    .select("id", { count: "exact", head: true })
    .eq("brief_id", brief_id)
    .eq("brief_kind", CREATIVE_BRIEF_KIND);
  if (error) fail("countBriefApplications", error);
  return count ?? 0;
}

export async function insertBriefApplication(args: {
  tenant_id: string;
  brief_id: string;
  human_member_id: string;
  pitch: string | null;
  quoted_rate_usd: number;
}): Promise<{ ok: true; application_id: string } | { ok: false; duplicate: true }> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(APPLICATIONS)
    .insert({
      brief_kind: CREATIVE_BRIEF_KIND,
      brief_id: args.brief_id,
      human_member_id: args.human_member_id,
      status: "applied",
      pitch: args.pitch,
      quoted_rate_usd: args.quoted_rate_usd,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") return { ok: false, duplicate: true };
    fail("insertBriefApplication", error);
  }
  const application_id = (data as { id?: string } | null)?.id;
  if (!application_id) fail("insertBriefApplication", { message: "no id returned" });
  return { ok: true, application_id };
}

export async function claimApplicationForHire(args: {
  tenant_id: string;
  application_id: string;
}): Promise<BriefApplicationRow | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(APPLICATIONS)
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", args.application_id)
    .in("status", PENDING_APPLICATION_STATUSES as unknown as string[])
    .select(APPLICATION_COLUMNS)
    .maybeSingle();
  if (error) fail("claimApplicationForHire", error);
  return (data as BriefApplicationRow | null) ?? null;
}

export async function linkBookingToPendingApplication(args: {
  tenant_id: string;
  brief_id: string;
  order_id: string;
  human_member_id: string;
}): Promise<{ application_id: string; filled_brief: boolean } | null> {
  const db = tenantClient(asTenantId(args.tenant_id));
  const { data: app, error } = await db
    .from(APPLICATIONS)
    .select("id, status")
    .eq("brief_id", args.brief_id)
    .eq("brief_kind", CREATIVE_BRIEF_KIND)
    .eq("human_member_id", args.human_member_id)
    .maybeSingle();
  if (error) fail("linkBookingToPendingApplication", error);
  const application = (app as { id: string; status: string } | null) ?? null;
  if (!application) return null;
  const application_id = application.id;

  if ((PENDING_APPLICATION_STATUSES as readonly string[]).includes(application.status)) {
    const approved = await claimApplicationForHire({ tenant_id: args.tenant_id, application_id });
    if (!approved) return null;
  } else if (application.status !== "approved") {
    return null;
  }

  const { data: holders, error: holdersError } = await db
    .from("creator_orders")
    .select("id")
    .eq("application_id", application_id)
    .neq("status", "cancelled");
  if (holdersError) fail("linkBookingToPendingApplication", holdersError);
  const holderIds = ((holders ?? []) as { id: string }[]).map((r) => r.id);
  if (holderIds.some((id) => id !== args.order_id)) return null;

  if (!holderIds.includes(args.order_id)) {
    const { error: linkError } = await db
      .from("creator_orders")
      .update({ application_id, updated_at: new Date().toISOString() })
      .eq("id", args.order_id)
      .eq("human_member_id", args.human_member_id)
      .is("application_id", null);
    if (linkError) fail("linkBookingToPendingApplication", linkError);
  }

  const at = new Date().toISOString();
  const { data: filled, error: fillError } = await db
    .from(BRIEFS)
    .update({ closed_at: at, status: "filled", filled_by_order_id: args.order_id, updated_at: at })
    .eq("id", args.brief_id)
    .is("filled_by_order_id", null)
    .select("id")
    .maybeSingle();
  if (fillError) fail("linkBookingToPendingApplication", fillError);
  const filled_brief = Boolean(filled) || (await loadBriefOwner({ tenant_id: args.tenant_id, brief_id: args.brief_id })) === args.order_id;
  return { application_id, filled_brief };
}

export type LiveBriefBooking = {
  order_id: string;
  human_member_id: string;
  status: string;
  application_id: string | null;
};

export async function liveBookingsOnBrief(args: { tenant_id: string; brief_id: string }): Promise<LiveBriefBooking[]> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("creator_orders")
    .select("id, human_member_id, status, application_id")
    .eq("brief_id", args.brief_id)
    .eq("source", "booking")
    .neq("status", "cancelled");
  if (error) fail("liveBookingsOnBrief", error);
  return ((data ?? []) as { id: string; human_member_id: string; status: string; application_id: string | null }[]).map((r) => ({
    order_id: r.id,
    human_member_id: r.human_member_id,
    status: r.status,
    application_id: r.application_id ?? null,
  }));
}

export function bookingCaptured(status: string): boolean {
  return status !== "checkout_pending" && status !== "awaiting_acceptance" && status !== "cancelled";
}

export async function releaseApplicationHireClaim(args: {
  tenant_id: string;
  application_id: string;
}): Promise<void> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from(APPLICATIONS)
    .update({ status: "applied", updated_at: new Date().toISOString() })
    .eq("id", args.application_id)
    .eq("status", "approved");
  if (error) fail("releaseApplicationHireClaim", error);
}

const PRE_CAPTURE_CLOSE_REASONS = new Set([
  "checkout_abandoned",
  "payment_failed",
  "declined",
  "expired",
  "withdrawn",
  "creator_removed",
]);

export function orderNeverPaid(o: { status: string; closed_reason: string | null }): boolean {
  if (o.status === "checkout_pending" || o.status === "awaiting_acceptance") return true;
  return o.status === "cancelled" && PRE_CAPTURE_CLOSE_REASONS.has(o.closed_reason ?? "");
}

export type ReleaseAfterCancelDeps = {
  declineLate?: (args: { tenant_id: string; brief_id: string; application_id: string }) => Promise<{ declined: boolean }>;
  now?: () => Date;
};

export async function releaseApplicationAfterCancelledOrder(
  args: {
    tenant_id: string;
    order_id: string;
  },
  deps: ReleaseAfterCancelDeps = {},
): Promise<boolean> {
  const db = tenantClient(asTenantId(args.tenant_id));
  const { data: order, error: orderError } = await db
    .from("creator_orders")
    .select("application_id, status, closed_reason")
    .eq("id", args.order_id)
    .maybeSingle();
  if (orderError) fail("releaseApplicationAfterCancelledOrder", orderError);
  const row = order as { application_id: string | null; status: string; closed_reason: string | null } | null;
  if (!row?.application_id || row.status !== "cancelled") return false;
  if (!orderNeverPaid({ status: row.status, closed_reason: row.closed_reason ?? null })) return false;

  const { data: live, error: liveError } = await db
    .from("creator_orders")
    .select("id")
    .eq("application_id", row.application_id)
    .neq("status", "cancelled")
    .limit(1);
  if (liveError) fail("releaseApplicationAfterCancelledOrder", liveError);
  if (((live as unknown[] | null) ?? []).length > 0) return false;

  const { data: app, error: appError } = await db
    .from(APPLICATIONS)
    .select("id, brief_id, status")
    .eq("id", row.application_id)
    .maybeSingle();
  if (appError) fail("releaseApplicationAfterCancelledOrder", appError);
  const application = app as { id: string; brief_id: string; status: string } | null;
  if (!application || application.status !== "approved") return false;

  const { data: brief, error: briefError } = await db
    .from(BRIEFS)
    .select("closed_at, answer_by")
    .eq("id", application.brief_id)
    .maybeSingle();
  if (briefError) fail("releaseApplicationAfterCancelledOrder", briefError);
  const b = brief as { closed_at: string | null; answer_by: string | null } | null;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const briefOpen = Boolean(b) && !b?.closed_at && (!b?.answer_by || new Date(b.answer_by).getTime() > now);

  if (!briefOpen) {
    const declineLate =
      deps.declineLate ??
      (async (a: { tenant_id: string; brief_id: string; application_id: string }) => {
        const { declineLateHire, realLateHireDeps } = await import("./brief-applications");
        return declineLateHire(a, realLateHireDeps);
      });
    await declineLate({ tenant_id: args.tenant_id, brief_id: application.brief_id, application_id: application.id });
    return false;
  }

  const { data, error } = await db
    .from(APPLICATIONS)
    .update({ status: "applied", updated_at: new Date().toISOString() })
    .eq("id", row.application_id)
    .eq("status", "approved")
    .select("id");
  if (error) fail("releaseApplicationAfterCancelledOrder", error);
  return ((data as unknown[] | null) ?? []).length === 1;
}

export async function claimPendingApplications(args: {
  tenant_id: string;
  brief_id: string;
  except_application_id?: string | null;
  except_human_member_ids?: readonly string[];
}): Promise<BriefApplicationRow[]> {
  let q = tenantClient(asTenantId(args.tenant_id))
    .from(APPLICATIONS)
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("brief_id", args.brief_id)
    .eq("brief_kind", CREATIVE_BRIEF_KIND)
    .in("status", PENDING_APPLICATION_STATUSES as unknown as string[]);
  if (args.except_application_id) q = q.neq("id", args.except_application_id);
  for (const member of args.except_human_member_ids ?? []) q = q.neq("human_member_id", member);
  const { data, error } = await q.select(APPLICATION_COLUMNS);
  if (error) fail("claimPendingApplications", error);
  return (data as BriefApplicationRow[] | null) ?? [];
}

export type BoardMemberRow = {
  id: string;
  display_name: string;
  vetting_state: string;
  lanes: string[] | null;
  country_code: string | null;
  earn_mode?: string | null;
};

export async function loadBoardMemberByAuthUser(
  auth_user_id: string,
): Promise<BoardMemberRow | null> {
  const base = "id, display_name, vetting_state, lanes, country_code";
  const read = (cols: string) => globalClient().from("human_members").select(cols).eq("auth_user_id", auth_user_id).maybeSingle();
  let { data, error } = await read(`${base}, earn_mode`);
  if (error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? ""))) ({ data, error } = await read(base));
  if (error) fail("loadBoardMemberByAuthUser", error);
  return (data as unknown as BoardMemberRow | null) ?? null;
}

const BOARD_REASON =
  "posted-brief board: spec item 15 makes a posted brief visible to every approved creator in its lane";

export async function listBoardBriefs(args: {
  lanes: string[];
  limit?: number;
}): Promise<CreatorBriefSourceRow[]> {
  let q = creatorBoardClient(BOARD_REASON)
    .from(BRIEFS)
    .select(CREATOR_BRIEF_COLUMNS)
    .not("posted_at", "is", null)
    .is("closed_at", null)
    .order("posted_at", { ascending: false })
    .limit(Math.min(args.limit ?? 50, 100));
  if (args.lanes.length > 0) {
    q = args.lanes.includes("ugc_video") ? q.or("lane.is.null,lane.in.(ugc_video)") : q.in("lane", args.lanes);
  }
  const { data, error } = await q;
  if (error) fail("listBoardBriefs", error);
  return (data as unknown as CreatorBriefSourceRow[] | null) ?? [];
}

export async function listAppliedBriefIds(human_member_id: string, limit = 50): Promise<string[]> {
  const { data: apps, error: appsError } = await creatorAreaClient(
    "creator's own brief applications, for their Briefs history",
  )
    .from(APPLICATIONS)
    .select("brief_id")
    .eq("human_member_id", human_member_id)
    .eq("brief_kind", CREATIVE_BRIEF_KIND)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100));
  if (appsError) fail("listAppliedBriefIds", appsError);
  return [...new Set(((apps as { brief_id: string }[] | null) ?? []).map((a) => a.brief_id))];
}

export async function listAppliedClosedBriefs(
  human_member_id: string,
  limit = 50,
): Promise<CreatorBriefSourceRow[]> {
  const ids = await listAppliedBriefIds(human_member_id, limit);
  if (ids.length === 0) return [];
  const { data, error } = await creatorBoardClient(BOARD_REASON)
    .from(BRIEFS)
    .select(CREATOR_BRIEF_COLUMNS)
    .in("id", ids)
    .not("posted_at", "is", null)
    .not("closed_at", "is", null)
    .order("posted_at", { ascending: false });
  if (error) fail("listAppliedClosedBriefs", error);
  return (data as unknown as CreatorBriefSourceRow[] | null) ?? [];
}

export async function loadBoardBrief(brief_id: string): Promise<CreatorBriefSourceRow | null> {
  const { data, error } = await creatorBoardClient(BOARD_REASON)
    .from(BRIEFS)
    .select(CREATOR_BRIEF_COLUMNS)
    .eq("id", brief_id)
    .not("posted_at", "is", null)
    .maybeSingle();
  if (error) fail("loadBoardBrief", error);
  return (data as CreatorBriefSourceRow | null) ?? null;
}

export async function countBoardBriefApplications(brief_ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (brief_ids.length === 0) return out;
  const sb = creatorBoardClient(
    "posted-brief board: places-left counts, spec item 16 shows applicants how many are left",
  );
  for (const brief_id of brief_ids) {
    const { count, error } = await sb
      .from(APPLICATIONS)
      .select("id", { count: "exact", head: true })
      .eq("brief_id", brief_id)
      .eq("brief_kind", CREATIVE_BRIEF_KIND);
    if (error) fail("countBoardBriefApplications", error);
    out.set(brief_id, count ?? 0);
  }
  return out;
}

export async function resolveBriefTenant(
  brief_id: string,
): Promise<{ tenant_id: string; status: string } | null> {
  const { data, error } = await preTenantRpc("human_resolve_brief", {
    p_brief_kind: CREATIVE_BRIEF_KIND,
    p_brief_id: brief_id,
  });
  if (error) fail("resolveBriefTenant", error);
  const rows = (data ?? []) as { tenant_id: string; status: string }[];
  return rows.length > 0 ? rows[0] : null;
}

export async function listBriefsPastAnswerBy(
  limit: number,
  now: Date = new Date(),
): Promise<{ id: string; tenant_id: string; answer_by: string }[]> {
  const { data, error } = await creatorBoardClient(
    "answer-by sweep: spec item 16 closes every overdue brief and sends its notes, across tenants",
  )
    .from(BRIEFS)
    .select("id, tenant_id, answer_by")
    .not("posted_at", "is", null)
    .is("closed_at", null)
    .not("answer_by", "is", null)
    .lte("answer_by", now.toISOString())
    .order("answer_by", { ascending: true })
    .limit(limit);
  if (error) fail("listBriefsPastAnswerBy", error);
  return (data ?? []) as { id: string; tenant_id: string; answer_by: string }[];
}

export async function listCreatorsMatchingBriefFilters(args: {
  tenant_id: string;
  lane: string | null;
  niches: string[];
  platforms: string[];
  locations: string[];
  limit?: number;
}): Promise<{ human_member_id: string; display_name: string }[]> {
  const tid = asTenantId(args.tenant_id);
  const seen = new Map<string, string>();
  const platforms: (string | null)[] = args.platforms.length > 0 ? args.platforms : [null];
  const locations: (string | null)[] = args.locations.length > 0 ? args.locations : [null];

  for (const platform of platforms) {
    for (const location of locations) {
      const isCountry = typeof location === "string" && /^[A-Za-z]{2}$/.test(location.trim());
      const { data, error } = await tenantRpc(tid, "search_creators", {
        p_order: "newest",
        p_lane: args.lane,
        p_platform: platform,
        p_niches: args.niches.length > 0 ? args.niches : null,
        p_max_price_cents: null,
        p_max_delivery_days: null,
        p_country_code: isCountry ? (location as string).trim().toUpperCase() : null,
        p_city: isCountry ? null : location,
        p_limit: Math.min(args.limit ?? 100, 100),
        p_offset: 0,
      });
      if (error) fail("listCreatorsMatchingBriefFilters", error);
      for (const r of (data ?? []) as { human_member_id: string; display_name: string }[]) {
        if (!seen.has(r.human_member_id)) seen.set(r.human_member_id, r.display_name ?? "");
      }
    }
  }
  return [...seen].map(([human_member_id, display_name]) => ({ human_member_id, display_name }));
}

export async function loadApplicantProfiles(args: {
  tenant_id: string;
  human_member_ids: string[];
}): Promise<Map<string, { display_name: string; slug: string | null; city: string | null; country_code: string | null; bookable: boolean }>> {
  const out = new Map<
    string,
    { display_name: string; slug: string | null; city: string | null; country_code: string | null; bookable: boolean }
  >();
  const ids = [...new Set(args.human_member_ids)];
  if (ids.length === 0) return out;
  const { data, error } = await globalClient()
    .from("human_members")
    .select("id, slug, display_name, city, country_code")
    .in("id", ids)
    .eq("vetting_state", "approved");
  if (error) fail("loadApplicantProfiles", error);
  for (const r of (data ?? []) as Array<{
    id: string;
    display_name: string | null;
    slug: string | null;
    city: string | null;
    country_code: string | null;
  }>) {
    out.set(r.id, {
      display_name: (r.display_name ?? "").trim(),
      slug: r.slug ?? null,
      city: r.city ?? null,
      country_code: r.country_code ?? null,
      bookable: creatorPayoutCountrySupported(r.country_code),
    });
  }
  return out;
}

export type BriefHireClaim = "claimed" | "ours" | "taken";

export async function claimBriefForHire(args: {
  tenant_id: string;
  brief_id: string;
  order_id: string;
  now?: Date;
}): Promise<BriefHireClaim> {
  const db = tenantClient(asTenantId(args.tenant_id));
  const at = (args.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from(BRIEFS)
    .update({ closed_at: at, status: "filled", filled_by_order_id: args.order_id, updated_at: at })
    .eq("id", args.brief_id)
    .is("closed_at", null)
    .or(`answer_by.is.null,answer_by.gt."${at}"`)
    .select("id")
    .maybeSingle();
  if (error) fail("claimBriefForHire", error);
  if (data) return "claimed";
  const { data: cur, error: readError } = await db
    .from(BRIEFS)
    .select("filled_by_order_id")
    .eq("id", args.brief_id)
    .maybeSingle();
  if (readError) fail("claimBriefForHire", readError);
  return (cur as { filled_by_order_id: string | null } | null)?.filled_by_order_id === args.order_id
    ? "ours"
    : "taken";
}

export async function releaseBriefClaim(args: {
  tenant_id: string;
  brief_id: string;
  order_id: string;
}): Promise<void> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from(BRIEFS)
    .update({ closed_at: null, status: "sent", filled_by_order_id: null, updated_at: new Date().toISOString() })
    .eq("id", args.brief_id)
    .eq("filled_by_order_id", args.order_id);
  if (error) fail("releaseBriefClaim", error);
}

export async function declineApprovedApplication(args: {
  tenant_id: string;
  application_id: string;
}): Promise<BriefApplicationRow | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(APPLICATIONS)
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", args.application_id)
    .eq("status", "approved")
    .select(APPLICATION_COLUMNS)
    .maybeSingle();
  if (error) fail("declineApprovedApplication", error);
  return (data as BriefApplicationRow | null) ?? null;
}

export async function loadBriefOwner(args: { tenant_id: string; brief_id: string }): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(BRIEFS)
    .select("filled_by_order_id")
    .eq("id", args.brief_id)
    .maybeSingle();
  if (error) fail("loadBriefOwner", error);
  return (data as { filled_by_order_id: string | null } | null)?.filled_by_order_id ?? null;
}
