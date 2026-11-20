
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { readHandles } from "@/services/humans/store";

export type HumanBriefView = {
  id: string;
  title: string;
  utm_campaign: string | null;
  status: string;
  deliverables: number | null;
  created_at: string;
  match_count: number | null;
  application_count: number | null;
  engagement_count: number | null;
  posted_at?: string | null;
  answer_by?: string | null;
  closed_at?: string | null;
  angle?: string | null;
  hook?: string | null;
  format?: string | null;
  lane?: string | null;
  budget_usd?: number | null;
  delivery_days?: number | null;
  applicant_cap?: number | null;
  ad_rights_days?: number | null;
  source_channel?: string | null;
};

export type HumanMatchView = {
  member_id: string;
  handle: string;
  platform: string;
  discipline: string;
  skills: string[];
  rate_usd: number | null;
  rate_unit: string | null;
};

export type HumanApplicationSummaryView = {
  id: string;
  member_id: string;
  handle: string;
  platform: string;
  status: string;
  quoted_rate_usd: number | null;
  pitch: string;
  created_at: string;
  engagement_id: string | null;
};

export type HumanEngagementView = {
  id: string;
  brief_id: string;
  brief_title: string;
  member_handle: string;
  member_platform: string;
  status: string;
  agreed_rate_usd: number | null;
  created_at: string;
  utm_campaign: string | null;
};

export type HumanReceiptView = {
  available: boolean;
  reason: string | null;
  spend_usd: number | null;
  attributed_revenue_usd: number | null;
  attributed_conversions: number | null;
};

async function primaryHandle(memberId: string): Promise<{ handle: string; platform: string }> {
  const handles = await readHandles(memberId);
  const first = handles[0];
  return {
    handle: first?.handle ?? "",
    platform: first?.platform ?? "",
  };
}

export async function listBriefs(accessToken: string, tenantId: string): Promise<HumanBriefView[]> {
  const supabase = serverClientFromBearer(accessToken);
  const { data: briefs, error } = await supabase
    .from("creator_briefs")
    .select(
      "id, title, utm_campaign, status, deliverables, created_at, posted_at, answer_by, closed_at, angle, hook, format, lane, budget_usd, delivery_days, applicant_cap, ad_rights_days, source_channel",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error || !briefs) return [];

  const ids = briefs.map((b) => b.id as string);
  if (ids.length === 0) return [];

  const [{ data: apps }, { data: engs }] = await Promise.all([
    supabase
      .from("brief_applications")
      .select("brief_id")
      .eq("tenant_id", tenantId)
      .in("brief_id", ids),
    supabase.from("engagements").select("brief_id").eq("tenant_id", tenantId).in("brief_id", ids),
  ]);

  const appCount = new Map<string, number>();
  for (const a of apps ?? []) {
    const k = a.brief_id as string;
    appCount.set(k, (appCount.get(k) ?? 0) + 1);
  }
  const engCount = new Map<string, number>();
  for (const e of engs ?? []) {
    const k = e.brief_id as string;
    engCount.set(k, (engCount.get(k) ?? 0) + 1);
  }

  return briefs.map((b) => ({
    id: b.id as string,
    title: (b.title as string) ?? "",
    utm_campaign: (b.utm_campaign as string | null) ?? null,
    status: (b.status as string) ?? "draft",
    deliverables: (b.deliverables as number | null) ?? null,
    created_at: b.created_at as string,
    posted_at: (b.posted_at as string | null) ?? null,
    answer_by: (b.answer_by as string | null) ?? null,
    closed_at: (b.closed_at as string | null) ?? null,
    angle: (b.angle as string | null) ?? null,
    hook: (b.hook as string | null) ?? null,
    format: (b.format as string | null) ?? null,
    lane: (b.lane as string | null) ?? null,
    budget_usd: b.budget_usd === null || b.budget_usd === undefined ? null : Number(b.budget_usd),
    delivery_days: (b.delivery_days as number | null) ?? null,
    applicant_cap: (b.applicant_cap as number | null) ?? null,
    ad_rights_days: (b.ad_rights_days as number | null) ?? null,
    source_channel: (b.source_channel as string | null) ?? null,
    match_count: null,
    application_count: appCount.get(b.id as string) ?? 0,
    engagement_count: engCount.get(b.id as string) ?? 0,
  }));
}

export async function getBriefDetail(
  accessToken: string,
  tenantId: string,
  briefId: string,
): Promise<{
  brief: HumanBriefView;
  matches: HumanMatchView[];
  applications: HumanApplicationSummaryView[];
} | null> {
  const supabase = serverClientFromBearer(accessToken);
  const { data: brief } = await supabase
    .from("creator_briefs")
    .select("id, title, utm_campaign, status, deliverables, created_at")
    .eq("id", briefId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!brief) return null;

  const { data: appRows } = await supabase
    .from("brief_applications")
    .select("id, human_member_id, status, quoted_rate_usd, pitch, created_at")
    .eq("tenant_id", tenantId)
    .eq("brief_id", briefId)
    .order("created_at", { ascending: false });

  const { data: engRows } = await supabase
    .from("engagements")
    .select("id, application_id")
    .eq("tenant_id", tenantId)
    .eq("brief_id", briefId);
  const engByApp = new Map<string, string>();
  for (const e of engRows ?? []) {
    const appId = e.application_id as string | null;
    if (appId) engByApp.set(appId, e.id as string);
  }

  const applications: HumanApplicationSummaryView[] = [];
  for (const a of appRows ?? []) {
    const { handle, platform } = await primaryHandle(a.human_member_id as string);
    applications.push({
      id: a.id as string,
      member_id: a.human_member_id as string,
      handle,
      platform,
      status: (a.status as string) ?? "applied",
      quoted_rate_usd: (a.quoted_rate_usd as number | null) ?? null,
      pitch: (a.pitch as string | null) ?? "",
      created_at: a.created_at as string,
      engagement_id: engByApp.get(a.id as string) ?? null,
    });
  }

  let matches: HumanMatchView[] = [];
  try {
    const res = await tenantRpc(asTenantId(tenantId), "search_human_members", {
      p_discipline: null,
      p_skills: null,
      p_max_rate: null,
    });
    const rows = (res.data ?? []) as Array<Record<string, unknown>>;
    matches = rows.slice(0, 25).map((r) => {
      const handles = (r.handles ?? []) as Array<{ handle?: string; platform?: string }>;
      return {
        member_id: r.human_member_id as string,
        handle: handles[0]?.handle ?? (r.display_name as string) ?? "",
        platform: handles[0]?.platform ?? "",
        discipline: (r.discipline as string) ?? "",
        skills: (r.skills as string[] | null) ?? [],
        rate_usd: (r.rate_usd as number | null) ?? null,
        rate_unit: (r.rate_unit as string | null) ?? null,
      };
    });
  } catch {
    matches = [];
  }

  return {
    brief: {
      id: brief.id as string,
      title: (brief.title as string) ?? "",
      utm_campaign: (brief.utm_campaign as string | null) ?? null,
      status: (brief.status as string) ?? "draft",
      deliverables: (brief.deliverables as number | null) ?? null,
      created_at: brief.created_at as string,
      match_count: matches.length,
      application_count: applications.length,
      engagement_count: engByApp.size,
    },
    matches,
    applications,
  };
}

export async function getEngagement(
  accessToken: string,
  tenantId: string,
  engagementId: string,
): Promise<{
  engagement: HumanEngagementView;
  deliverables: never[];
  receipt: HumanReceiptView;
} | null> {
  const supabase = serverClientFromBearer(accessToken);
  const { data: eng } = await supabase
    .from("engagements")
    .select(
      "id, brief_id, human_member_id, status, agreed_rate_usd, created_at, utm_campaign",
    )
    .eq("id", engagementId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!eng) return null;

  const { data: brief } = await supabase
    .from("creator_briefs")
    .select("title")
    .eq("id", eng.brief_id as string)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const { handle, platform } = await primaryHandle(eng.human_member_id as string);

  return {
    engagement: {
      id: eng.id as string,
      brief_id: eng.brief_id as string,
      brief_title: (brief?.title as string | undefined) ?? "",
      member_handle: handle,
      member_platform: platform,
      status: (eng.status as string) ?? "active",
      agreed_rate_usd: (eng.agreed_rate_usd as number | null) ?? null,
      created_at: eng.created_at as string,
      utm_campaign: (eng.utm_campaign as string | null) ?? null,
    },
    deliverables: [],
    receipt: {
      available: false,
      reason: "Connect your operator database to attribute revenue to this engagement.",
      spend_usd: null,
      attributed_revenue_usd: null,
      attributed_conversions: null,
    },
  };
}
