
import {
  CREATOR_AD_METRICS_SCOPE_NOTE,
  CREATOR_AD_METRIC_FIELDS,
  type CreatorAdEvidence,
  type CreatorAdMetrics,
  creatorAdEvidence,
} from "@zavi/shared";
import { tenantClient, tenantStorage, type TenantId } from "@/services/tenant-client";
import { inngest } from "@/../workers/client";

export const DELIVERABLES_BUCKET = "creator-deliverables";

export const DOWNLOAD_URL_TTL_SECONDS = 300;

export const TWO_CLOCKS_WARNING =
  "Two clocks: if you run this from the creator's own handle with a partnership ad code, " +
  "Meta's grant on that code can end before the licence below does. Check the ad code's own end date.";

export type LibraryAssetRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  submission_id: string;
  human_member_id: string;
  rights_start_at: string;
  rights_end_at: string;
  utm_campaign: string;
  meta_ad_account_id: string | null;
  meta_video_id: string | null;
  meta_ad_id: string | null;
  meta_ad_set_id: string | null;
  meta_auto_paused_at: string | null;
  metrics: Partial<CreatorAdMetrics> | null;
  metrics_read_at: string | null;
  youtube_video_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LibraryAssetView = {
  id: string;
  order_id: string;
  submission_id: string;
  human_member_id: string;
  rights_start_at: string;
  rights_end_at: string;
  rights_expired: boolean;
  tracking_tag: string;
  two_clocks_warning: string | null;
  video: {
    kind: string;
    storage_path: string;
    mime_type: string | null;
    bytes: number | null;
  } | null;
  meta: {
    ad_account_id: string | null;
    video_id: string | null;
    ad_id: string | null;
    ad_set_id: string | null;
    auto_paused_at: string | null;
  } | null;
  ad_performance: LibraryAssetPerformance | null;
  youtube: { video_id: string } | null;
  creator_display_name: string | null;
  source_channel: string | null;
};

export type LibraryAssetPerformance = CreatorAdEvidence & {
  read_at: string;
  scope_note: string;
  numbers: CreatorAdMetrics | null;
};

const ASSET_COLUMNS =
  "id, tenant_id, order_id, submission_id, human_member_id, rights_start_at, rights_end_at, " +
  "utm_campaign, meta_ad_account_id, meta_video_id, meta_ad_id, meta_ad_set_id, " +
  "meta_auto_paused_at, metrics, metrics_read_at, youtube_video_id, created_at, updated_at";

type SubmissionRow = {
  id: string;
  order_id: string;
  version: number;
  position: number;
  kind: string;
  storage_path: string;
  mime_type: string | null;
  bytes: number | null;
};

type OrderRow = {
  id: string;
  human_member_id: string;
  status: string;
  closed_reason: string | null;
  closed_at: string | null;
  brief_id: string | null;
  package_snapshot: Record<string, unknown> | null;
};

export const ACCEPTED_REASONS = new Set([
  "approved",
  "auto_accepted",
  "mediation_pay_full",
  "mediation_pay_part",
]);

export type CreateAssetOutcome = {
  created: boolean;
  asset: LibraryAssetRow | null;
  skipped_reason?:
    | "order_not_found"
    | "order_not_accepted"
    | "no_valid_ad_rights_days"
    | "no_video_submission";
};

export function adRightsDaysFromSnapshot(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  if (s.kind !== "ugc_video") return null;
  const days = s.ad_rights_days;
  if (days === 30 || days === 90 || days === 365) return days;
  return null;
}

export function hasPartnershipAdCode(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const addons = (snapshot as Record<string, unknown>).addons;
  if (!Array.isArray(addons)) return false;
  return addons.some(
    (a) => a && typeof a === "object" && (a as Record<string, unknown>).code === "partnership_ad_code",
  );
}

export function rightsEndFrom(start: Date, adRightsDays: number): Date {
  return new Date(start.getTime() + adRightsDays * 24 * 60 * 60 * 1000);
}

export async function createLibraryAssetOnApproval(
  tid: TenantId,
  order_id: string,
  opts: { now?: Date } = {},
): Promise<CreateAssetOutcome> {
  const db = tenantClient(tid);

  const { data: orderData, error: orderError } = await db
    .from("creator_orders")
    .select("id, human_member_id, status, closed_reason, closed_at, brief_id, package_snapshot")
    .eq("id", order_id)
    .maybeSingle();
  if (orderError) throw new Error(`creator library order read failed: ${orderError.message}`);
  const order = orderData as OrderRow | null;
  if (!order) return { created: false, asset: null, skipped_reason: "order_not_found" };

  if (order.status !== "completed" || !order.closed_reason || !ACCEPTED_REASONS.has(order.closed_reason)) {
    return { created: false, asset: null, skipped_reason: "order_not_accepted" };
  }

  const adRightsDays = adRightsDaysFromSnapshot(order.package_snapshot);
  if (adRightsDays === null) {
    return { created: false, asset: null, skipped_reason: "no_valid_ad_rights_days" };
  }

  const { data: subsData, error: subsError } = await db
    .from("creator_submissions")
    .select("id, order_id, version, position, kind, storage_path, mime_type, bytes")
    .eq("order_id", order_id)
    .eq("kind", "video")
    .order("version", { ascending: false })
    .order("position", { ascending: true });
  if (subsError) throw new Error(`creator library submission read failed: ${subsError.message}`);
  const allVideos = (subsData ?? []) as SubmissionRow[];
  if (allVideos.length === 0) return { created: false, asset: null, skipped_reason: "no_video_submission" };
  const accepted = allVideos.filter((v) => v.version === allVideos[0].version);

  const start = opts.now ?? (order.closed_at ? new Date(order.closed_at) : new Date());
  const end = rightsEndFrom(start, adRightsDays);

  let first: CreateAssetOutcome | null = null;
  let anyCreated = false;
  for (const submission of accepted) {
    const outcome = await insertAssetForSubmission(tid, order, submission, start, end);
    anyCreated = anyCreated || outcome.created;
    first = first ?? outcome;
  }
  return { ...(first as CreateAssetOutcome), created: anyCreated };
}

async function insertAssetForSubmission(
  tid: TenantId,
  order: OrderRow,
  submission: SubmissionRow,
  start: Date,
  end: Date,
): Promise<CreateAssetOutcome> {
  const db = tenantClient(tid);
  const existing = await findAssetBySubmission(tid, submission.id);
  if (existing) return { created: false, asset: existing };

  const trackingTag = await briefTrackingTagIfFree(tid, order.brief_id);

  const row: Record<string, unknown> = {
    order_id: order.id,
    submission_id: submission.id,
    human_member_id: order.human_member_id,
    rights_start_at: start.toISOString(),
    rights_end_at: end.toISOString(),
  };
  if (trackingTag) row.utm_campaign = trackingTag;

  const { data: inserted, error } = await db
    .from("creator_library_assets")
    .insert(row)
    .select(ASSET_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const raced = await findAssetBySubmission(tid, submission.id);
      if (raced) return { created: false, asset: raced };
      if (trackingTag) {
        const retryRow = { ...row };
        delete retryRow.utm_campaign;
        const { data: retry } = await db
          .from("creator_library_assets")
          .insert(retryRow)
          .select(ASSET_COLUMNS)
          .maybeSingle();
        if (retry) {
          const asset = retry as unknown as LibraryAssetRow;
          await scheduleRightsExpiry(asset.id, asset.rights_end_at);
          return { created: true, asset };
        }
      }
    }
    throw new Error(`creator library insert failed: ${error.message}`);
  }

  const asset = inserted as unknown as LibraryAssetRow;
  await scheduleRightsExpiry(asset.id, asset.rights_end_at);
  return { created: true, asset };
}

async function findAssetBySubmission(
  tid: TenantId,
  submission_id: string,
): Promise<LibraryAssetRow | null> {
  const { data } = await tenantClient(tid)
    .from("creator_library_assets")
    .select(ASSET_COLUMNS)
    .eq("submission_id", submission_id)
    .maybeSingle();
  return (data as LibraryAssetRow | null) ?? null;
}

async function briefTrackingTagIfFree(tid: TenantId, brief_id: string | null): Promise<string | null> {
  if (!brief_id) return null;
  const db = tenantClient(tid);
  const { data: brief } = await db
    .from("creator_briefs")
    .select("utm_campaign")
    .eq("id", brief_id)
    .maybeSingle();
  const tag = (brief as { utm_campaign?: string } | null)?.utm_campaign;
  if (!tag) return null;
  const { data: taken } = await db
    .from("creator_library_assets")
    .select("id")
    .eq("utm_campaign", tag)
    .maybeSingle();
  return taken ? null : tag;
}

export async function scheduleRightsExpiry(asset_id: string, rights_end_at: string): Promise<void> {
  await inngest.send({
    name: "creator/rights_expiry.scheduled",
    data: { asset_id, rights_end_at },
  });
}

export async function listLibraryAssets(tid: TenantId, limit = 100): Promise<LibraryAssetView[]> {
  const { data } = await tenantClient(tid)
    .from("creator_library_assets")
    .select(ASSET_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  const rows = (data ?? []) as LibraryAssetRow[];
  if (rows.length === 0) return [];
  const usable = await usableOrderIds(tid, rows.map((r) => r.order_id));
  const views: LibraryAssetView[] = [];
  for (const row of rows) {
    if (usable.has(row.order_id)) views.push(await toView(tid, row));
  }
  return views;
}

function isAcceptedOrder(order: { status: string; closed_reason: string | null }): boolean {
  return order.status === "completed" && order.closed_reason !== null && ACCEPTED_REASONS.has(order.closed_reason);
}

async function usableOrderIds(tid: TenantId, order_ids: string[]): Promise<Set<string>> {
  const ids = [...new Set(order_ids)];
  if (ids.length === 0) return new Set();
  const db = tenantClient(tid);
  const { data: orders, error: orderError } = await db
    .from("creator_orders")
    .select("id, status, closed_reason")
    .in("id", ids);
  if (orderError) throw new Error(`creator library order gate read failed: ${orderError.message}`);
  const accepted = ((orders ?? []) as Array<{ id: string; status: string; closed_reason: string | null }>)
    .filter(isAcceptedOrder)
    .map((o) => o.id);
  if (accepted.length === 0) return new Set();
  const { data: disputes, error: disputeError } = await db
    .from("creator_disputes")
    .select("order_id")
    .in("order_id", accepted)
    .eq("status", "open");
  if (disputeError) throw new Error(`creator library dispute gate read failed: ${disputeError.message}`);
  const disputed = new Set(((disputes ?? []) as Array<{ order_id: string }>).map((d) => d.order_id));
  return new Set(accepted.filter((id) => !disputed.has(id)));
}

export async function getLibraryAsset(tid: TenantId, asset_id: string): Promise<LibraryAssetView | null> {
  const row = await getLibraryAssetRow(tid, asset_id);
  return row ? toView(tid, row) : null;
}

export async function getLibraryAssetRow(
  tid: TenantId,
  asset_id: string,
): Promise<LibraryAssetRow | null> {
  const { data } = await tenantClient(tid)
    .from("creator_library_assets")
    .select(ASSET_COLUMNS)
    .eq("id", asset_id)
    .maybeSingle();
  const row = (data as LibraryAssetRow | null) ?? null;
  if (!row) return null;
  return (await usableOrderIds(tid, [row.order_id])).has(row.order_id) ? row : null;
}

export async function setLibraryAssetYoutubeVideoId(
  tid: TenantId,
  asset_id: string,
  youtube_video_id: string,
): Promise<LibraryAssetRow | null> {
  const { data, error } = await tenantClient(tid)
    .from("creator_library_assets")
    .update({ youtube_video_id })
    .eq("id", asset_id)
    .select(ASSET_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new Error(`creator library youtube id update failed: ${error.message}`);
  }
  return (data as LibraryAssetRow | null) ?? null;
}

async function toView(tid: TenantId, row: LibraryAssetRow): Promise<LibraryAssetView> {
  const { data: subData } = await tenantClient(tid)
    .from("creator_submissions")
    .select("id, order_id, version, position, kind, storage_path, mime_type, bytes")
    .eq("id", row.submission_id)
    .maybeSingle();
  const submission = subData as SubmissionRow | null;

  const { data: orderData } = await tenantClient(tid)
    .from("creator_orders")
    .select("id, package_snapshot, brief_id")
    .eq("id", row.order_id)
    .maybeSingle();
  const order = orderData as { package_snapshot?: unknown; brief_id?: string | null } | null;
  const snapshot = order?.package_snapshot;
  const source_channel = await briefSourceChannel(tid, order?.brief_id ?? null);

  const hasMeta = Boolean(row.meta_ad_id || row.meta_video_id);
  return {
    id: row.id,
    order_id: row.order_id,
    submission_id: row.submission_id,
    human_member_id: row.human_member_id,
    rights_start_at: row.rights_start_at,
    rights_end_at: row.rights_end_at,
    rights_expired: Date.parse(row.rights_end_at) <= Date.now(),
    tracking_tag: row.utm_campaign,
    two_clocks_warning: hasPartnershipAdCode(snapshot) ? TWO_CLOCKS_WARNING : null,
    video: submission
      ? {
          kind: submission.kind,
          storage_path: submission.storage_path,
          mime_type: submission.mime_type,
          bytes: submission.bytes,
        }
      : null,
    meta: hasMeta
      ? {
          ad_account_id: row.meta_ad_account_id,
          video_id: row.meta_video_id,
          ad_id: row.meta_ad_id,
          ad_set_id: row.meta_ad_set_id,
          auto_paused_at: row.meta_auto_paused_at,
        }
      : null,
    ad_performance: performanceFrom(row),
    youtube: row.youtube_video_id ? { video_id: row.youtube_video_id } : null,
    creator_display_name: snapshotCreatorName(snapshot),
    source_channel,
  };
}

export function snapshotCreatorName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const n = (snapshot as Record<string, unknown>).creator_display_name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

async function briefSourceChannel(tid: TenantId, brief_id: string | null): Promise<string | null> {
  if (!brief_id) return null;
  const { data, error } = await tenantClient(tid)
    .from("creator_briefs")
    .select("source_channel")
    .eq("id", brief_id)
    .maybeSingle();
  if (error) throw new Error(`creator brief source_channel read failed: ${error.message}`);
  const ch = (data as { source_channel?: string | null } | null)?.source_channel;
  return typeof ch === "string" && ch ? ch : null;
}

export function performanceFrom(row: LibraryAssetRow): LibraryAssetPerformance | null {
  if (!row.metrics || !row.metrics_read_at) return null;
  const evidence = creatorAdEvidence(Number(row.metrics.conversions ?? 0));
  const numbers = CREATOR_AD_METRIC_FIELDS.reduce((acc, field) => {
    const v = Number(row.metrics?.[field] ?? 0);
    acc[field] = Number.isFinite(v) ? v : 0;
    return acc;
  }, {} as CreatorAdMetrics);
  return {
    ...evidence,
    read_at: row.metrics_read_at,
    scope_note: CREATOR_AD_METRICS_SCOPE_NOTE,
    numbers: evidence.enough_evidence ? numbers : null,
  };
}

export async function signedDownloadUrl(
  tid: TenantId,
  asset_id: string,
): Promise<{ url: string; expires_in: number; filename: string } | null> {
  const row = await getLibraryAssetRow(tid, asset_id);
  if (!row) return null;

  const { data: subData } = await tenantClient(tid)
    .from("creator_submissions")
    .select("id, order_id, version, position, kind, storage_path, mime_type, bytes")
    .eq("id", row.submission_id)
    .maybeSingle();
  const submission = subData as SubmissionRow | null;
  if (!submission) return null;

  assertPathOwnedBy(tid, submission.storage_path);

  const { data, error } = await tenantStorage(tid)
    .from(DELIVERABLES_BUCKET)
    .createSignedUrl(submission.storage_path, DOWNLOAD_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(`signed download url failed: ${error?.message ?? "no url returned"}`);
  }
  return {
    url: data.signedUrl,
    expires_in: DOWNLOAD_URL_TTL_SECONDS,
    filename: submission.storage_path.split("/").pop() ?? "creator-video",
  };
}

export function assertPathOwnedBy(tid: string, storage_path: string): void {
  if (!storage_path.startsWith(`${tid}/`)) {
    throw new Error(
      `creator library: storage path does not belong to tenant ${tid} — refusing to sign it.`,
    );
  }
}
