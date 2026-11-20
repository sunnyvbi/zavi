
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { deadlineCopy, type DeadlineAudience, type DeadlineCopy } from "./deadline-copy";
import { bookingDueAfterAccept, firstWord } from "./deadlines";
import { orderDeadlineForRow } from "./deadlines";
import {
  isNeverPaidOrder,
  MAX_REVISION_ROUNDS,
  revisionsUsed,
  type CreatorOrderSource,
  type CreatorOrderStatus,
} from "./order-state";
import {
  latestSubmissionAtByOrder,
  listCreatorJobs,
  listSubmissions,
  submissionRoundsByOrder,
  partialRefundsByOrder,
  loadBookableCreator,
  loadBookablePackage,
  loadCreatorJob,
  loadLatestDispute,
  type CreatorJobRow,
} from "./booking-db";
import {
  businessActionsFor,
  BUSINESS_ACTION_CONSEQUENCE,
  BUSINESS_ACTION_LABEL,
  type BusinessAction,
} from "./business-actions";
import { realCreatorThreadPort, type CreatorThreadView } from "./s7-ports";
import { changeNoteFromBody } from "./creator-area";
import { creatorInboxClient } from "@/services/tenant-client";
import { submissionRounds } from "./orders-db";
import { getOfferView } from "./offers";
import { loadCreatorJobReceipt, type CreatorJobReceipt } from "./receipt";
import {
  isPaidOrder,
  previewMedia,
  previewGaveUp,
  previewNeedsWork,
  requestSubmissionPreviews,
  type PreviewRequester,
} from "./submission-preview";

const DELIVERABLES_BUCKET = "creator-deliverables";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export type CreatorJobMoney = {
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  business_fee_label: string;
  creator_payout_cents: number;
  payout_status: string;
};

export type CreatorJobSummary = {
  id: string;
  source: CreatorOrderSource;
  status: CreatorOrderStatus;
  closed_reason: string | null;
  title: string;
  creator_display_name: string | null;
  creator_slug: string | null;
  human_member_id: string;
  brief_id: string | null;
  created_at: string;
  due_at: string | null;
  closed_at: string | null;
  money: CreatorJobMoney;
  deadline: DeadlineCopy | null;
  due_after_accept: string | null;
  awaiting_creator: boolean;
  extension_state: "requested" | "approved" | "declined" | null;
  extension_requested_due_at: string | null;
  product_needed: boolean;
  product_received_at: string | null;
  revisions_used?: number;
  refunded_cents?: number | null;
  offer_id: string | null;
  offer_expired?: boolean;
  awaiting_hire_approval?: boolean;
};

export type CreatorJobActionOption = {
  action: BusinessAction;
  label: string;
  consequence: string;
  wants_note: boolean;
};

export type CreatorJobSubmission = {
  id: string;
  version: number;
  position: number;
  kind: "video" | "image" | "raw_footage" | "other";
  mime_type: string | null;
  bytes: number | null;
  note: string | null;
  created_at: string;
  play_url: string | null;
  watermarked: boolean;
  preview: "ready" | "preparing" | "failed" | "unavailable" | null;
  preview_unavailable_reason?: "file_type" | "not_built" | null;
  download_url: string | null;
};

export type CreatorJobExtension = {
  state: "requested" | "approved" | "declined";
  requested_due_at: string | null;
};

export type CreatorJobRebook = {
  package_id: string;
  title: string;
  price_cents: number;
  currency: string;
};

export type CreatorJobChangeRequest = { round: number; note: string | null; created_at: string };

export type CreatorJobDetail = {
  job: CreatorJobSummary;
  package_snapshot: Record<string, unknown> | null;
  brief_snapshot: Record<string, unknown> | null;
  submissions: CreatorJobSubmission[];
  actions: CreatorJobActionOption[];
  rebook: CreatorJobRebook | null;
  extension: CreatorJobExtension | null;
  revisions: { used: number; left: number; max: number };
  dispute: {
    status: "open" | "resolved";
    opened_by: "tenant" | "creator";
    reason: string;
    outcome: "pay_full" | "pay_part" | "refund" | null;
    resolution_note: string | null;
    created_at: string;
  } | null;
  thread: CreatorThreadView;
  change_requests?: CreatorJobChangeRequest[];
  receipt?: CreatorJobReceipt | null;
};

export type JobsViewDeps = {
  listJobs: typeof listCreatorJobs;
  loadJob: typeof loadCreatorJob;
  latestSubmissionAtByOrder: typeof latestSubmissionAtByOrder;
  submissionRoundsByOrder?: typeof submissionRoundsByOrder;
  partialRefundsByOrder?: typeof partialRefundsByOrder;
  listSubmissions: typeof listSubmissions;
  submissionRounds: typeof submissionRounds;
  loadDispute: typeof loadLatestDispute;
  loadCreator: typeof loadBookableCreator;
  loadPackage: typeof loadBookablePackage;
  thread: typeof realCreatorThreadPort;
  signUrl: (tenant_id: string, storage_path: string, download?: string) => Promise<string | null>;
  requestPreviews?: PreviewRequester;
  offerExpired?: (tenant_id: string, offer_id: string) => Promise<boolean>;
  loadReceipt?: typeof loadCreatorJobReceipt;
  changeRequests?: (order_id: string, human_member_id: string) => Promise<CreatorJobChangeRequest[]>;
  now: () => Date;
};

async function signDeliverable(tenant_id: string, storage_path: string, download?: string): Promise<string | null> {
  if (!storage_path.startsWith(`${tenant_id}/`)) return null;
  const { data, error } = await tenantStorage(asTenantId(tenant_id))
    .from(DELIVERABLES_BUCKET)
    .createSignedUrl(storage_path, SIGNED_URL_TTL_SECONDS, download ? { download } : undefined);
  if (error) return null;
  return data?.signedUrl ?? null;
}

async function listChangeRequests(order_id: string, human_member_id: string): Promise<CreatorJobChangeRequest[]> {
  const { data, error } = await creatorInboxClient("business job view: the change notes this tenant sent on its own order")
    .from("creator_notifications")
    .select("body, created_at")
    .eq("recipient_kind", "creator")
    .eq("human_member_id", human_member_id)
    .eq("order_id", order_id)
    .eq("kind", "revision_requested")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`change requests read failed: ${error.message}`);
  return ((data ?? []) as Array<{ body: string | null; created_at: string }>).map((r, i) => ({
    round: i + 1,
    note: changeNoteFromBody(r.body),
    created_at: r.created_at,
  }));
}

export const realJobsViewDeps: JobsViewDeps = {
  listJobs: listCreatorJobs,
  loadJob: loadCreatorJob,
  latestSubmissionAtByOrder,
  submissionRoundsByOrder,
  partialRefundsByOrder,
  listSubmissions,
  submissionRounds,
  loadDispute: loadLatestDispute,
  loadCreator: loadBookableCreator,
  loadPackage: loadBookablePackage,
  loadReceipt: loadCreatorJobReceipt,
  changeRequests: listChangeRequests,
  thread: realCreatorThreadPort,
  signUrl: signDeliverable,
  requestPreviews: requestSubmissionPreviews,
  offerExpired: async (tenant_id, offer_id) => {
    const offer = await getOfferView({ tenant_id, offer_id });
    return !offer || offer.expired;
  },
  now: () => new Date(),
};

function snapshotString(snap: Record<string, unknown> | null, key: string): string | null {
  const v = snap?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function toSummary(
  row: CreatorJobRow,
  last_submission_at: string | null,
  now: Date,
): CreatorJobSummary {
  const deadline =
    row.next_deadline_at && row.next_deadline_kind
      ? { kind: row.next_deadline_kind, deadline_at: row.next_deadline_at }
      : orderDeadlineForRow(
          {
            status: row.status,
            source: row.source,
            created_at: row.created_at,
            due_at: row.due_at,
            cancel_requested_at: row.cancel_requested_at,
            last_submission_at,
          },
          now,
        );
  const audience: DeadlineAudience = {
    side: "business",
    other_name: firstWord(snapshotString(row.package_snapshot, "creator_display_name")),
  };
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    closed_reason: row.closed_reason,
    title: snapshotString(row.package_snapshot, "title") ?? "Creator job",
    creator_display_name: snapshotString(row.package_snapshot, "creator_display_name"),
    creator_slug: snapshotString(row.package_snapshot, "creator_slug"),
    human_member_id: row.human_member_id,
    brief_id: row.brief_id ?? null,
    created_at: row.created_at,
    due_at: row.due_at,
    closed_at: row.closed_at ?? null,
    money: {
      currency: row.currency,
      price_cents: row.price_cents,
      business_fee_cents: row.business_fee_cents,
      business_total_cents: row.business_total_cents,
      business_fee_label: "10%",
      creator_payout_cents: row.payout_amount_cents ?? row.creator_payout_cents,
      payout_status: row.payout_status,
    },
    deadline: deadline ? deadlineCopy(deadline.kind, deadline.deadline_at, audience) : null,
    due_after_accept: bookingDueAfterAccept(row, audience),
    awaiting_creator: row.status === "awaiting_acceptance",
    extension_state: row.extension_state ?? null,
    extension_requested_due_at: row.extension_state === "requested" ? (row.extension_requested_due_at ?? null) : null,
    product_needed: row.product_needed === true,
    product_received_at: row.product_received_at ?? null,
    offer_id: row.offer_id ?? null,
  };
}

export async function listBusinessJobs(
  tenant_id: string,
  deps: JobsViewDeps = realJobsViewDeps,
): Promise<{ jobs: CreatorJobSummary[] }> {
  const rows = (await deps.listJobs(tenant_id)).filter((r) => !isNeverPaidOrder(r));
  const submitted = rows.filter((r) => r.status === "submitted").map((r) => r.id);
  const latest = await deps.latestSubmissionAtByOrder(tenant_id, submitted);
  const reviewing = rows.filter((r) => r.status === "submitted" || r.status === "revision_requested").map((r) => r.id);
  const rounds = deps.submissionRoundsByOrder
    ? await deps.submissionRoundsByOrder(tenant_id, reviewing).catch(() => new Map<string, number>())
    : new Map<string, number>();
  const partial = rows.filter((r) => r.closed_reason === "mediation_pay_part").map((r) => r.id);
  const refunds =
    partial.length > 0 && deps.partialRefundsByOrder
      ? await deps.partialRefundsByOrder(tenant_id, partial).catch(() => null)
      : null;
  const now = deps.now();
  return {
    jobs: rows.map((r) => {
      let summary = toSummary(r, latest.get(r.id) ?? null, now);
      const n = rounds.get(r.id);
      if (n !== undefined) summary = { ...summary, revisions_used: Math.min(revisionsUsed(n, r.status), MAX_REVISION_ROUNDS) };
      if (r.closed_reason === "mediation_pay_part") summary = { ...summary, refunded_cents: refunds?.get(r.id) ?? null };
      return summary;
    }),
  };
}

const WANTS_NOTE: ReadonlySet<BusinessAction> = new Set([
  "request_change",
  "request_cancellation",
  "ask_zavi",
  "ask_zavi_in_buffer",
]);

async function resolveRebook(
  row: CreatorJobRow,
  deps: JobsViewDeps,
): Promise<CreatorJobRebook | null> {
  if (row.status !== "completed") return null;
  if (row.source !== "booking" || !row.package_id) return null;
  const pkg = await deps.loadPackage(row.package_id).catch(() => null);
  if (!pkg || !pkg.active) return null;
  return {
    package_id: pkg.id,
    title: pkg.title,
    price_cents: pkg.price_cents,
    currency: pkg.currency,
  };
}

export async function getBusinessJob(
  tenant_id: string,
  order_id: string,
  deps: JobsViewDeps = realJobsViewDeps,
  auth_user_id: string | null = null,
): Promise<CreatorJobDetail | null> {
  const row = await deps.loadJob(tenant_id, order_id);
  if (!row) return null;

  const [submissionRows, rounds, dispute, thread, creator] = await Promise.all([
    deps.listSubmissions(tenant_id, order_id),
    deps.submissionRounds(tenant_id, order_id),
    deps.loadDispute(tenant_id, order_id),
    auth_user_id
      ? deps.thread
          .readThread({ auth_user_id, tenant_id, order_id, thread_id: row.thread_id })
          .catch(() => ({ available: false, thread_id: null, messages: [] }))
      : Promise.resolve({ available: false, thread_id: null, messages: [] }),
    deps.loadCreator(row.human_member_id),
  ]);

  const last_submission_at = submissionRows[0]?.created_at ?? null;
  const summary = toSummary(row, last_submission_at, deps.now());
  if (!summary.creator_display_name && creator) {
    summary.creator_display_name = creator.display_name || null;
    summary.creator_slug = creator.slug;
  }

  const rebook = await resolveRebook(row, deps);

  const change_requests = deps.changeRequests
    ? await deps.changeRequests(order_id, row.human_member_id).catch(() => [])
    : [];

  const receipt =
    row.status !== "checkout_pending" && deps.loadReceipt
      ? await deps.loadReceipt(tenant_id, order_id).catch(() => null)
      : null;

  if (row.status === "checkout_pending" && row.agent_run_id) summary.awaiting_hire_approval = true;
  if (row.status === "checkout_pending" && row.source === "offer") {
    summary.offer_expired =
      row.offer_id && deps.offerExpired ? await deps.offerExpired(tenant_id, row.offer_id).catch(() => true) : true;
  }

  const used = Math.min(revisionsUsed(rounds, row.status), MAX_REVISION_ROUNDS);
  const revisions = { used, left: MAX_REVISION_ROUNDS - used, max: MAX_REVISION_ROUNDS };

  const paid = isPaidOrder(row) && dispute?.status !== "open";
  const now = deps.now();
  const needsPreview = new Set<number>();
  const submissions: CreatorJobSubmission[] = [];
  for (const s of submissionRows) {
    const base = {
      id: s.id,
      version: s.version,
      position: s.position,
      kind: s.kind,
      mime_type: s.mime_type,
      bytes: s.bytes,
      note: s.note,
      created_at: s.created_at,
    };
    if (paid) {
      const ext = s.storage_path.split(".").pop() ?? "mp4";
      submissions.push({
        ...base,
        play_url: await deps.signUrl(tenant_id, s.storage_path),
        watermarked: false,
        preview: null,
        download_url: await deps.signUrl(tenant_id, s.storage_path, `zavi-job-${order_id.slice(0, 8)}-v${s.version}-${s.position + 1}.${ext}`),
      });
      continue;
    }
    const media = previewMedia(s.mime_type, s.storage_path);
    const ready = media !== null && s.preview_state === "ready" && !!s.preview_path;
    const previewRow = { preview_state: s.preview_state ?? null, preview_updated_at: s.preview_updated_at ?? null, preview_attempts: s.preview_attempts ?? 0 };
    if (media !== null && !ready && previewNeedsWork(previewRow, now)) {
      needsPreview.add(s.version);
    }
    submissions.push({
      ...base,
      play_url: ready ? await deps.signUrl(tenant_id, s.preview_path as string) : null,
      watermarked: ready,
      preview:
        media === null || previewGaveUp(previewRow, now)
          ? "unavailable"
          : ready
            ? "ready"
            : s.preview_state === "failed"
              ? "failed"
              : "preparing",
      preview_unavailable_reason: media === null ? "file_type" : previewGaveUp(previewRow, now) ? "not_built" : null,
      download_url: null,
    });
  }
  if (deps.requestPreviews) {
    for (const version of needsPreview) {
      await deps.requestPreviews({ tenant_id, order_id, version }).catch(() => {});
    }
  }

  return {
    job: summary,
    package_snapshot: row.package_snapshot,
    brief_snapshot: row.brief_snapshot,
    submissions,
    actions: businessActionsFor(row.status, row.source, row.extension_state, {
      closed_reason: row.closed_reason,
      closed_at: row.closed_at ?? null,
      payout_status: row.payout_status,
      now: deps.now(),
    })
      .filter((action) => action !== "request_change" || revisions.left > 0)
      .filter((action) => action !== "ask_zavi_in_buffer" || dispute?.status !== "open")
      .map((action) => ({
      action,
      label: BUSINESS_ACTION_LABEL[action],
      consequence: BUSINESS_ACTION_CONSEQUENCE[action],
      wants_note: WANTS_NOTE.has(action),
    })),
    rebook,
    revisions,
    extension: row.extension_state
      ? { state: row.extension_state, requested_due_at: row.extension_requested_due_at }
      : null,
    dispute: dispute
      ? {
          status: dispute.status,
          opened_by: dispute.opened_by,
          reason: dispute.reason,
          outcome: dispute.outcome,
          resolution_note: dispute.resolution_note,
          created_at: dispute.created_at,
        }
      : null,
    thread,
    change_requests,
    receipt,
  };
}
