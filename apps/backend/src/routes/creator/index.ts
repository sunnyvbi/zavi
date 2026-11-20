
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { creatorBoard } from "@/services/creators/brief-applications";
import {
  CreatorAreaError,
  ACTIVE_JOB_STATUSES,
  assertCreatorDeliverablePath,
  INBOX_STATUSES,
  creatorDeliverableUploadPath,
  creatorEarnings,
  creatorOrderAmountCents,
  creatorOrderDeadlineCopy,
  insertCreatorSubmission,
  latestChangeRequestNote,
  listCreatorThreadsForMember,
  offerProposedBy,
  deleteCreatorSubmissionVersion,
  listCreatorNotifications,
  listCreatorOrders,
  listCreatorPackages,
  listCreatorSubmissions,
  listCreatorThreadMessages,
  creatorJobThreadId,
  loadCreatorOrder,
  markCreatorNotificationRead,
  nextSubmissionVersion,
  postCreatorThreadMessage,
  updateCreatorPackage,
  type CreatorAreaOrderRow,
} from "@/services/creators/creator-area";
import { applyCreatorOrderTransition } from "@/services/creators/order-transitions";
import { MAX_REVISION_ROUNDS, revisionsUsed } from "@/services/creators/order-state";
import { resolveBusinessName } from "@/services/creators/briefs-db";
import { openCreatorHelpRequest, submissionRounds } from "@/services/creators/orders-db";
import { bookingDueAfterAccept } from "@/services/creators/deadlines";
import {
  computeCreatorFees,
  createCreatorExpressLoginLink,
  createCreatorOnboardingLink,
  CREATOR_PAYOUT_DISCONNECTED,
  creatorPayoutCountrySupported,
  ensureCreatorPayoutAccount,
  platformKeyLivemode,
  refreshCreatorPayoutAccount,
} from "@/services/creators";
import { loadCreatorPayoutAccount } from "@/services/creators/db";
import { realPayoutReleaseDeps, releaseParkedPayouts } from "@/services/creators/payout-release";
import { humanApplicantStorage } from "@/services/tenant-client";
import { requireCreator, sendCreatorError, type CreatorPrincipal } from "./auth";
import { loadCreatorReputation } from "@/services/humans/creatorReviews";
import { refreshSetup, setupStore } from "@/services/creators/creator-setup";
import { requestSubmissionPreviews } from "@/services/creators/submission-preview";
import { logEvent } from "@/services/logging/logEvent";
import { scrubContact } from "@/services/creators/contact-scrub";

const DELIVERABLES_BUCKET = "creator-deliverables";

const DELIVERABLE_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function bad(res: Response, code: string, message: string, status = 400): void {
  res.status(status).json({ error: { code, message } });
}

const DELIVERY_OPEN_STATUSES = new Set(["in_progress", "revision_requested"]);

function refuseUnlessOpenForDelivery(order: CreatorAreaOrderRow, res: Response): boolean {
  if (DELIVERY_OPEN_STATUSES.has(order.status)) return false;
  bad(res, "not_open_for_delivery", "This job is not waiting for a delivery right now.", 409);
  return true;
}

async function storedDeliverable(
  authUserId: string,
  order: CreatorAreaOrderRow,
  storagePath: string,
): Promise<{ bytes: number; mime_type: string | null }> {
  assertCreatorDeliverablePath(order, storagePath);
  const { data, error } = await humanApplicantStorage(authUserId).from(DELIVERABLES_BUCKET).info(storagePath);
  const missing = new CreatorAreaError("upload_missing", "That file did not finish uploading. Upload it again.", 400);
  if (error) {
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    if (status === 400 || status === 404 || String(statusCode) === "404") throw missing;
    console.error(`[creator] deliverable lookup failed: ${error.message}`);
    throw new CreatorAreaError("upload_check_failed", "We could not check that upload. Try again.", 502);
  }
  const bytes = data?.size ?? data?.metadata?.size;
  if (typeof bytes !== "number" || bytes <= 0) throw missing;
  return { bytes, mime_type: data?.contentType ?? data?.metadata?.mimetype ?? null };
}

async function dropVersionUnlessSubmitted(
  me: CreatorPrincipal,
  order: CreatorAreaOrderRow,
  version: number,
): Promise<void> {
  try {
    const fresh = await loadCreatorOrder(me.member_id, order.id);
    if (!fresh || fresh.status === "submitted") return;
    await deleteCreatorSubmissionVersion(order, version);
  } catch (e) {
    console.error(`[creator] submission cleanup after a failed submit did not run: ${(e as Error).message}`);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function jobView(order: CreatorAreaOrderRow, withThread: boolean) {
  const submissions = await listCreatorSubmissions(order);
  const lastAt = submissions.length ? submissions[submissions.length - 1].created_at : null;
  const { fees, amount_cents, part_paid } = creatorOrderAmountCents(order);
  const threadId = withThread ? await creatorJobThreadId(order) : order.thread_id;
  const thread = withThread ? await listCreatorThreadMessages(order) : undefined;
  const [rounds, business_name, offer_proposed_by, change_request_note, help_request] = await Promise.all([
    submissionRounds(order.tenant_id, order.id).catch(() => new Set(submissions.map((s) => s.version)).size),
    resolveBusinessName(order.tenant_id).catch(() => ""),
    order.source === "offer" ? offerProposedBy(order).catch(() => null) : Promise.resolve(null),
    order.status === "revision_requested"
      ? latestChangeRequestNote(order).catch(() => null)
      : Promise.resolve(null),
    order.status === "in_dispute" ? openCreatorHelpRequest(order.tenant_id, order.id).catch(() => null) : Promise.resolve(null),
  ]);

  const deadline = creatorOrderDeadlineCopy(order, lastAt, new Date(), business_name || null);

  return {
    id: order.id,
    source: order.source,
    status: order.status,
    closed_reason: order.closed_reason,
    created_at: order.created_at,
    due_at: order.due_at,
    accepted_at: order.accepted_at,
    closed_at: order.closed_at,
    extension_state: order.extension_state,
    extension_requested_due_at: order.extension_requested_due_at,
    product_needed: order.product_needed === true,
    product_received_at: order.product_received_at ?? null,
    can_mark_product_received:
      order.status === "in_progress" && order.product_needed === true && !order.product_received_at,
    package: order.package_snapshot,
    brief: order.brief_snapshot,
    currency: order.currency,
    price_cents: order.price_cents,
    creator_fee_cents: fees.creator_fee_cents,
    creator_payout_cents: fees.creator_payout_cents,
    amount_cents,
    part_paid,
    payout_status: order.payout_status,
    payout_ready_at: order.payout_ready_at,
    deadline,
    due_after_accept: bookingDueAfterAccept(order, { side: "creator" }),
    submissions: submissions.map((s) => ({
      id: s.id,
      version: s.version,
      position: s.position,
      kind: s.kind,
      mime_type: s.mime_type,
      bytes: s.bytes,
      note: s.note,
      created_at: s.created_at,
    })),
    has_thread: threadId != null,
    ...(thread ? { thread } : {}),
    business_name: business_name || null,
    offer_proposed_by,
    revisions_used: Math.min(revisionsUsed(rounds, order.status), MAX_REVISION_ROUNDS),
    revisions_max: MAX_REVISION_ROUNDS,
    change_request_note,
    help_request,
  };
}

export async function getCreatorMe(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const country = me.member.country_code;
    let payoutAccount: { details_submitted: boolean; payouts_enabled: boolean } | null = null;
    try {
      const row = await loadCreatorPayoutAccount(me.member_id, platformKeyLivemode());
      if (row) {
        payoutAccount = {
          details_submitted: row.details_submitted,
          payouts_enabled: row.payouts_enabled,
        };
      }
    } catch {
      payoutAccount = null;
    }
    const setup = await refreshSetup(me.member_id);
    if (me.email) await setupStore.syncEmail(me.member_id, me.email).catch(() => false);
    const vetting_state =
      me.member.vetting_state === "pending" && setup.complete ? "approved" : me.member.vetting_state;
    res.json({
      vetting_state,
      setup,
      creator: {
        id: me.member_id,
        display_name: me.member.display_name,
        slug: me.member.slug,
        lanes: me.member.lanes ?? [],
        city: me.member.city,
        country_code: country,
        missed_deadline_count: me.member.missed_deadline_count ?? 0,
      },
      payout_country_supported: country ? creatorPayoutCountrySupported(country) : null,
      payout_account: payoutAccount,
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorInbox(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const [pending, alerts] = await Promise.all([
      listCreatorOrders(me.member_id, INBOX_STATUSES),
      listCreatorNotifications(me.member_id, 30, resolveBusinessName),
    ]);
    const requests = await Promise.all(pending.map((o) => jobView(o, false)));
    res.json({
      requests,
      alerts,
      unread_alerts: alerts.filter((a) => a.read_at === null).length,
      order: "newest first",
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorNotificationRead(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const id = str(req.params?.notificationId);
  if (!id) return bad(res, "validation", "Which alert?");
  try {
    const ok = await markCreatorNotificationRead(me.member_id, id);
    if (!ok) return bad(res, "not_found", "That alert is not in your inbox.", 404);
    res.json({ ok: true });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorThreads(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const rows = await listCreatorThreadsForMember(me.member_id);
    const names = new Map<string, string>();
    for (const tid of Array.from(new Set(rows.map((r) => r.tenant_id)))) {
      names.set(tid, await resolveBusinessName(tid).catch(() => ""));
    }
    res.json({
      threads: rows.map((r) => ({
        thread_id: r.thread_id,
        business_name: names.get(r.tenant_id) || "A Zavi business",
        last_message_at: r.last_message_at,
        last_message: r.last_message,
        open_offer: r.open_offer
          ? {
              ...r.open_offer,
              creator_payout_cents: computeCreatorFees(r.open_offer.price_cents).creator_payout_cents,
            }
          : null,
      })),
      order: "newest first",
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorBriefs(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    res.json(await creatorBoard({ member: me.member }));
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorJobs(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const scope = str(req.query?.scope) || "active";
    const statuses = scope === "all" && me.member.vetting_state !== "rejected" ? undefined : ACTIVE_JOB_STATUSES;
    const orders = await listCreatorOrders(me.member_id, statuses);
    const jobs = await Promise.all(orders.map((o) => jobView(o, false)));
    res.json({ jobs, scope, order: "newest first" });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export const NO_JOB_HERE = "There is no job here. An order only becomes a job once the business has paid for it.";

async function orderFromPath(
  me: CreatorPrincipal,
  req: Request,
  res: Response,
): Promise<CreatorAreaOrderRow | null> {
  const id = str(req.params?.orderId);
  if (!id) {
    bad(res, "validation", "Which job?");
    return null;
  }
  const order = await loadCreatorOrder(me.member_id, id);
  if (!order) {
    bad(res, "not_found", NO_JOB_HERE, 404);
    return null;
  }
  return order;
}

export async function getCreatorJob(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    res.json({ job: await jobView(order, true) });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

async function runTransition(
  me: CreatorPrincipal,
  order: CreatorAreaOrderRow,
  res: Response,
  trigger: Parameters<typeof applyCreatorOrderTransition>[0]["trigger"],
  extra: Partial<Parameters<typeof applyCreatorOrderTransition>[0]> = {},
): Promise<boolean> {
  const result = await applyCreatorOrderTransition({
    tenant_id: order.tenant_id,
    order_id: order.id,
    trigger,
    actor: "creator",
    actor_user_id: me.auth_user_id,
    ...extra,
  });
  if (!result.ok) {
    const status = result.code === "order_not_found" ? 404 : result.code === "conflict" ? 409 : 400;
    res.status(status).json({ error: { code: result.code, message: result.message } });
    return false;
  }
  const fresh = await loadCreatorOrder(me.member_id, order.id);
  res.json({
    ok: true,
    from: result.from,
    to: result.to,
    payout_waiting: result.payout_waiting,
    job: fresh ? await jobView(fresh, false) : null,
  });
  return true;
}

export async function postCreatorAccept(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, "creator_accept");
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorPass(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = str(body.reason);
  if (reason.length > 2000) {
    return bad(res, "validation", "That reason is too long. Keep it under 2000 characters.");
  }
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, "creator_pass", { note: reason || null });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

const CANCELLATION_ANSWER: Record<string, "cancel_agreed" | "cancel_declined" | "cancel_disputed"> = {
  agree: "cancel_agreed",
  decline: "cancel_declined",
  dispute: "cancel_disputed",
};

export async function postCreatorCancellationResponse(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const answer = str(body.answer);
  const trigger = CANCELLATION_ANSWER[answer];
  if (!trigger) {
    return bad(
      res,
      "validation",
      "Say whether you agree, decline or want Zavi to step in: answer must be 'agree', 'decline' or 'dispute'.",
    );
  }
  const reason = str(body.reason);
  if (reason.length > 2000) {
    return bad(res, "validation", "That reason is too long. Keep it under 2000 characters.");
  }
  if (trigger === "cancel_disputed" && !reason) {
    return bad(res, "validation", "Tell Zavi why you disagree, so a person has something to read.");
  }
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, trigger, {
      note: reason || null,
      ...(trigger === "cancel_disputed"
        ? {
            dispute: {
              kind: "cancel_dispute" as const,
              opened_by: "creator" as const,
              opened_by_user_id: me.auth_user_id,
              reason,
            },
          }
        : {}),
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorProductReceived(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, "product_received");
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorDispute(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const reason = str((req.body as Record<string, unknown> | undefined)?.reason);
  if (!reason) return bad(res, "validation", "Tell Zavi what is wrong, so a person has something to read.");
  if (reason.length > 2000) {
    return bad(res, "validation", "That reason is too long. Keep it under 2000 characters.");
  }
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, "open_dispute", {
      note: reason,
      dispute: { kind: "step_in", opened_by: "creator", opened_by_user_id: me.auth_user_id, reason },
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorExtension(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requested = str(body.requested_due_at);
  if (!requested) return bad(res, "validation", "Pick the new date you are asking for.");
  if (Number.isNaN(new Date(requested).getTime())) {
    return bad(res, "validation", "That date did not make sense.");
  }
  const note = str(body.note);
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    await runTransition(me, order, res, "request_extension", {
      requested_due_at: new Date(requested).toISOString(),
      note: note || null,
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorMessage(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const body = str((req.body as Record<string, unknown>)?.body);
  if (!body) return bad(res, "validation", "Type a message first.");
  if (body.length > 4000) return bad(res, "validation", "That message is too long.");
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    const message = await postCreatorThreadMessage(order, body, me.auth_user_id);
    res.json({ message });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorUploadUrl(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const contentType = str((req.body as Record<string, unknown>)?.content_type);
  const ext = DELIVERABLE_MIME[contentType];
  if (!ext) {
    return bad(
      res,
      "unsupported_media_type",
      "Upload an MP4, MOV or WebM video, or a PNG, JPEG or WebP image.",
      400,
    );
  }
  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    if (refuseUnlessOpenForDelivery(order, res)) return;
    const path = creatorDeliverableUploadPath(order, randomUUID(), ext);
    const { data, error } = await humanApplicantStorage(me.auth_user_id)
      .from(DELIVERABLES_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      console.error(`[creator] signed upload url failed: ${error?.message ?? "no data"}`);
      return bad(res, "upload_url_failed", "We could not start that upload. Try again.", 502);
    }
    res.json({
      bucket: DELIVERABLES_BUCKET,
      path: data.path ?? path,
      token: data.token,
      signed_url: data.signedUrl,
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorSubmission(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  if (rawFiles.length === 0) return bad(res, "validation", "Attach at least one file.");
  if (rawFiles.length > 50) return bad(res, "validation", "That is too many files for one send.");
  const rawNote = str(body.note) || null;
  if (rawNote && rawNote.length > 2000) return bad(res, "validation", "That note is too long.");
  const scrubbedNote = rawNote ? scrubContact(rawNote) : null;
  const note = scrubbedNote ? scrubbedNote.body : null;

  const files = [];
  for (const raw of rawFiles) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const kind = str(f.kind) || "video";
    if (!["video", "image", "raw_footage", "other"].includes(kind)) {
      return bad(res, "validation", "That file type is not one we take.");
    }
    const storage_path = str(f.storage_path);
    if (!storage_path) return bad(res, "validation", "One of those files did not finish uploading.");
    files.push({ kind: kind as "video" | "image" | "raw_footage" | "other", storage_path });
  }

  try {
    const order = await orderFromPath(me, req, res);
    if (!order) return;
    if (refuseUnlessOpenForDelivery(order, res)) return;
    const stored = [];
    for (const f of files) stored.push({ ...f, ...(await storedDeliverable(me.auth_user_id, order, f.storage_path)) });
    if (scrubbedNote && scrubbedNote.removed.length > 0) {
      void logEvent({
        level: "info",
        source: "creator/submissions",
        code: "creator.contact_scrubbed",
        message: `contact details removed from a creator submission note (${scrubbedNote.removed.join(", ")})`,
        tenant_id: order.tenant_id,
      }).catch(() => undefined);
    }
    const version = await nextSubmissionVersion(order);
    await insertCreatorSubmission(order, version, stored, note);
    let submitted: boolean;
    try {
      submitted = await runTransition(me, order, res, "submit", { note, submission_version: version });
    } catch (e) {
      await dropVersionUnlessSubmitted(me, order, version);
      throw e;
    }
    if (!submitted) {
      await deleteCreatorSubmissionVersion(order, version).catch((e) =>
        console.error(`[creator] orphan submission cleanup failed: ${(e as Error).message}`),
      );
      return;
    }
    await requestSubmissionPreviews({ tenant_id: order.tenant_id, order_id: order.id, version }).catch((e) =>
      console.warn(`[creator] watermark preview not queued: ${(e as Error).message}`),
    );
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorReviews(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const rep = await loadCreatorReputation(me.member_id);
    res.json({
      aggregates: rep.aggregates,
      reviews: rep.reviews.map((r) => ({
        id: r.id,
        business_name: r.business_name,
        communication: r.communication,
        timeliness: r.timeliness,
        satisfaction: r.satisfaction,
        body: r.body,
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorEarnings(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const earnings = await creatorEarnings(me.member_id, resolveBusinessName);
    let payout: {
      connected: boolean;
      details_submitted: boolean;
      payouts_enabled: boolean;
      country: string | null;
      disabled_reason: string | null;
    } = { connected: false, details_submitted: false, payouts_enabled: false, country: null, disabled_reason: null };
    try {
      const row = await loadCreatorPayoutAccount(me.member_id, platformKeyLivemode());
      if (row) {
        payout = {
          connected: true,
          details_submitted: row.details_submitted,
          payouts_enabled: row.payouts_enabled,
          country: row.country,
          disabled_reason: row.disabled_reason ?? null,
        };
      }
    } catch {
    }
    const country = me.member.country_code;
    res.json({
      ...earnings,
      payout,
      payout_country_supported: country ? creatorPayoutCountrySupported(country) : null,
      fee_note: `Zavi keeps ${computeCreatorFees(10000).creator_fee_cents / 100}% of your price.`,
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorOnboardingLink(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  if (me.member.vetting_state === "rejected") {
    const inFlight: CreatorAreaOrderRow["status"][] = ["in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute"];
    let owed: boolean;
    try {
      const orders = await listCreatorOrders(me.member_id, [...inFlight, "completed"]);
      owed = orders.some(
        (o) =>
          inFlight.includes(o.status) ||
          (o.status === "completed" && !["transferred", "reversed", "not_applicable"].includes(o.payout_status)),
      );
    } catch (e) {
      return sendCreatorError(res, e);
    }
    if (!owed) {
      return bad(res, "not_approved", "Your creator account is closed and no payment is owed to you.", 403);
    }
  } else if (me.member.vetting_state !== "approved") {
    return bad(res, "not_approved", "Finish your profile before setting up payouts.", 409);
  }
  const country = me.member.country_code;
  if (!country) {
    return bad(res, "no_country", "Add your country to your profile before setting up payouts.", 409);
  }
  if (!creatorPayoutCountrySupported(country)) {
    return bad(
      res,
      "creator_payout_country_unsupported",
      "Zavi cannot pay creators in your country yet, so payouts cannot be set up.",
      409,
    );
  }
  try {
    const account = await ensureCreatorPayoutAccount({
      human_member_id: me.member_id,
      country,
    });
    const url = await createCreatorOnboardingLink(account.stripe_account_id);
    res.json({ url });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string" && code.startsWith("stripe_")) {
      await logEvent({
        level: "error",
        source: "creator.payouts",
        code: "creator_payout_setup_stripe_refused",
        message: `${code}: ${String((e as Error).message ?? "").slice(0, 400)}`,
        meta: { human_member_id: me.member_id, country },
      }).catch(() => {});
      return bad(
        res,
        "payout_setup_unavailable",
        "Payout setup is not available right now. Your earnings are safe with Zavi, and the Zavi team has been told. Try again later.",
        503,
      );
    }
    sendCreatorError(res, e);
  }
}

export async function postCreatorTaxFormsLink(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const account = await loadCreatorPayoutAccount(me.member_id, platformKeyLivemode());
    if (!account) {
      return bad(res, "no_payout_account", "Set up payouts first, then your tax forms live there.", 409);
    }
    const url = await createCreatorExpressLoginLink(account.stripe_account_id);
    res.json({ url });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function postCreatorPayoutRefresh(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const account = await loadCreatorPayoutAccount(me.member_id, platformKeyLivemode());
    if (!account) return bad(res, "no_payout_account", "Payouts are not set up yet.", 409);
    if (account.disabled_reason === CREATOR_PAYOUT_DISCONNECTED) {
      return res.json({
        payout: {
          transfers_active: false,
          payouts_enabled: false,
          details_submitted: account.details_submitted ?? false,
          disabled_reason: CREATOR_PAYOUT_DISCONNECTED,
        },
        released_payouts: 0,
      }) as unknown as void;
    }
    const status = await refreshCreatorPayoutAccount(account.stripe_account_id);
    let released_payouts = 0;
    if (status.transfers_active) {
      try {
        const result = await releaseParkedPayouts(me.member_id, platformKeyLivemode(), realPayoutReleaseDeps);
        released_payouts = result.released;
      } catch {
      }
    }
    res.json({ payout: { ...status, disabled_reason: account.disabled_reason ?? null }, released_payouts });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function getCreatorStorefront(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const packages = await listCreatorPackages(me.member_id);
    res.json({
      slug: me.member.slug,
      packages: packages.map((p) => ({ ...p, fees: computeCreatorFees(p.price_cents) })),
    });
  } catch (e) {
    sendCreatorError(res, e);
  }
}

export async function patchCreatorPackage(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const id = str(req.params?.packageId);
  if (!id) return bad(res, "validation", "Which package?");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { price_cents?: number; title?: string; description?: string | null; active?: boolean } = {};

  if (body.price_cents !== undefined) {
    const cents = body.price_cents;
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents > 10_000_000) {
      return bad(res, "validation", "Set a price between $0.01 and $100,000.");
    }
    patch.price_cents = cents;
  }
  if (body.title !== undefined) {
    const t = str(body.title);
    if (t.length < 1 || t.length > 120) return bad(res, "validation", "Give the package a short name.");
    patch.title = t;
  }
  if (body.description !== undefined) {
    const d = str(body.description);
    if (d.length > 2000) return bad(res, "validation", "That description is too long.");
    patch.description = d || null;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return bad(res, "validation", "Say on or off.");
    patch.active = body.active;
  }
  if (Object.keys(patch).length === 0) return bad(res, "validation", "Nothing to change.");

  try {
    const updated = await updateCreatorPackage(me.member_id, id, patch);
    if (!updated) return bad(res, "not_found", "That package is not yours.", 404);
    res.json({ package: { ...updated, fees: computeCreatorFees(updated.price_cents) } });
  } catch (e) {
    if (e instanceof CreatorAreaError) return sendCreatorError(res, e);
    sendCreatorError(res, e);
  }
}
