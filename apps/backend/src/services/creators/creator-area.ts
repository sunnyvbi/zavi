
import { creatorAreaClient, globalClient } from "@/services/tenant-client";
import { computeCreatorFees, type CreatorFeeBreakdown } from "./order-fees";
import { orderDeadlineForRow, deadlineCopy, type DeadlineAudience, type DeadlineCopy } from "./deadlines";
import { PAID_ORDER_FILTER, type CreatorOrderSource, type CreatorOrderStatus } from "./order-state";
import { ensureCreatorThread, postCreatorThreadMessage as postThreadMessageScrubbed } from "./thread";
import { BUSINESS_NAME_FALLBACK, BUSINESS_ONLY_EVENTS } from "./notify";

const ORDERS = "creator_orders";
const SUBMISSIONS = "creator_submissions";
const PACKAGES = "creator_packages";
const NOTIFICATIONS = "creator_notifications";
const THREAD_MESSAGES = "creator_thread_messages";
const BRIEFS = "creator_briefs";
const MEMBERS = "human_members";

const WHY = "creator reads and writes only their own rows, scoped by human_member_id";

function sb() {
  return creatorAreaClient(WHY);
}

export class CreatorAreaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CreatorAreaError";
  }
}

function fail(where: string, error: { message?: string } | null): never {
  console.error(`[creator-area] ${where} failed: ${error?.message ?? "unknown"}`);
  throw new CreatorAreaError("creator_area_unavailable", "That did not load. Try again.", 503);
}

const MEMBER_COLUMNS =
  "id, auth_user_id, display_name, vetting_state, slug, lanes, city, country_code, " +
  "missed_deadline_count, public_metrics, created_at";

export type CreatorAreaMember = {
  id: string;
  auth_user_id: string;
  display_name: string;
  vetting_state: "pending" | "under_review" | "approved" | "rejected";
  slug: string | null;
  lanes: string[] | null;
  city: string | null;
  country_code: string | null;
  missed_deadline_count: number | null;
  public_metrics: Record<string, unknown> | null;
  created_at: string;
};

export async function resolveCreatorByAuthUser(
  authUserId: string,
): Promise<CreatorAreaMember | null> {
  if (!authUserId || !authUserId.trim()) return null;
  const { data, error } = await globalClient()
    .from(MEMBERS)
    .select(MEMBER_COLUMNS)
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) fail("resolve creator", error);
  return (data as CreatorAreaMember | null) ?? null;
}

const ORDER_COLUMNS =
  "id, tenant_id, human_member_id, source, status, closed_reason, created_at, due_at, " +
  "extension_requested_due_at, extension_state, next_deadline_at, next_deadline_kind, " +
  "responded_at, accepted_at, cancel_requested_at, closed_at, payout_status, payout_ready_at, " +
  "payout_amount_cents, price_cents, business_fee_cents, creator_fee_cents, " +
  "business_total_cents, creator_payout_cents, package_snapshot, brief_snapshot, " +
  "thread_id, livemode, currency, product_needed, product_received_at, offer_id, chargeback_status";

export type CreatorAreaOrderRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  source: CreatorOrderSource;
  status: CreatorOrderStatus;
  closed_reason: string | null;
  created_at: string;
  due_at: string | null;
  extension_requested_due_at: string | null;
  extension_state: "requested" | "approved" | "declined" | null;
  next_deadline_at: string | null;
  next_deadline_kind: string | null;
  responded_at: string | null;
  accepted_at: string | null;
  cancel_requested_at: string | null;
  closed_at: string | null;
  payout_status: string;
  payout_ready_at: string | null;
  chargeback_status?: string | null;
  payout_amount_cents: number | null;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  package_snapshot: Record<string, unknown> | null;
  brief_snapshot: Record<string, unknown> | null;
  thread_id: string | null;
  livemode: boolean;
  currency: string;
  product_needed?: boolean;
  product_received_at?: string | null;
  offer_id?: string | null;
};

export const INBOX_STATUSES: readonly CreatorOrderStatus[] = ["awaiting_acceptance"] as const;

export const ACTIVE_JOB_STATUSES: readonly CreatorOrderStatus[] = [
  "in_progress",
  "submitted",
  "revision_requested",
  "cancel_requested",
  "in_dispute",
] as const;

const LIST_LIMIT = 100;

export async function listCreatorOrders(
  memberId: string,
  statuses?: readonly CreatorOrderStatus[],
): Promise<CreatorAreaOrderRow[]> {
  let q = sb()
    .from(ORDERS)
    .select(ORDER_COLUMNS)
    .eq("human_member_id", memberId)
    .neq("status", "checkout_pending")
    .or(PAID_ORDER_FILTER)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (statuses && statuses.length > 0) q = q.in("status", statuses as string[]);
  const { data, error } = await q;
  if (error) fail("list orders", error);
  return (data as unknown as CreatorAreaOrderRow[] | null) ?? [];
}

export async function loadCreatorOrder(
  memberId: string,
  orderId: string,
): Promise<CreatorAreaOrderRow | null> {
  const { data, error } = await sb()
    .from(ORDERS)
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .eq("human_member_id", memberId)
    .neq("status", "checkout_pending")
    .or(PAID_ORDER_FILTER)
    .maybeSingle();
  if (error) fail("load order", error);
  return (data as CreatorAreaOrderRow | null) ?? null;
}

export type CreatorSubmissionRow = {
  id: string;
  order_id: string;
  version: number;
  position: number;
  kind: string;
  storage_path: string;
  mime_type: string | null;
  bytes: number | null;
  note: string | null;
  created_at: string;
};

const SUBMISSION_COLUMNS =
  "id, order_id, version, position, kind, storage_path, mime_type, bytes, note, created_at";

export async function listCreatorSubmissions(
  order: CreatorAreaOrderRow,
): Promise<CreatorSubmissionRow[]> {
  const { data, error } = await sb()
    .from(SUBMISSIONS)
    .select(SUBMISSION_COLUMNS)
    .eq("tenant_id", order.tenant_id)
    .eq("order_id", order.id)
    .order("version", { ascending: true })
    .order("position", { ascending: true })
    .limit(LIST_LIMIT);
  if (error) fail("list submissions", error);
  return (data as CreatorSubmissionRow[] | null) ?? [];
}

export async function nextSubmissionVersion(order: CreatorAreaOrderRow): Promise<number> {
  const rows = await listCreatorSubmissions(order);
  return rows.reduce((max, r) => Math.max(max, r.version), 0) + 1;
}

export type NewSubmissionFile = {
  kind: "video" | "image" | "raw_footage" | "other";
  storage_path: string;
  mime_type?: string | null;
  bytes?: number | null;
};

export async function insertCreatorSubmission(
  order: CreatorAreaOrderRow,
  version: number,
  files: NewSubmissionFile[],
  note: string | null,
): Promise<CreatorSubmissionRow[]> {
  const rows = files.map((f, i) => {
    assertCreatorDeliverablePath(order, f.storage_path);
    return {
      tenant_id: order.tenant_id,
      order_id: order.id,
      version,
      position: i,
      kind: f.kind,
      storage_path: f.storage_path,
      mime_type: f.mime_type ?? null,
      bytes: f.bytes ?? null,
      note: i === 0 ? note : null,
    };
  });
  const { data, error } = await sb().from(SUBMISSIONS).insert(rows).select(SUBMISSION_COLUMNS);
  if (error) fail("insert submission", error);
  return (data as CreatorSubmissionRow[] | null) ?? [];
}

export function assertCreatorDeliverablePath(order: CreatorAreaOrderRow, storagePath: string): void {
  const prefix = `${order.tenant_id}/${order.id}/`;
  if (!storagePath.startsWith(prefix) || storagePath.includes("..")) {
    throw new CreatorAreaError(
      "bad_storage_path",
      "That file does not belong to this job. Start the upload again.",
      400,
    );
  }
}

export async function deleteCreatorSubmissionVersion(
  order: CreatorAreaOrderRow,
  version: number,
): Promise<void> {
  const { error } = await sb()
    .from(SUBMISSIONS)
    .delete()
    .eq("tenant_id", order.tenant_id)
    .eq("order_id", order.id)
    .eq("version", version);
  if (error) fail("delete submission version", error);
}

export function creatorDeliverableUploadPath(
  order: CreatorAreaOrderRow,
  uuid: string,
  ext: string,
): string {
  return `${order.tenant_id}/${order.id}/${uuid}.${ext}`;
}

export function creatorOrderDeadlineCopy(
  order: CreatorAreaOrderRow,
  lastSubmissionAt: string | null,
  now: Date = new Date(),
  businessName: string | null = null,
): DeadlineCopy | null {
  const audience: DeadlineAudience = { side: "creator", other_name: businessName };
  if (order.next_deadline_at && order.next_deadline_kind) {
    return deadlineCopy(order.next_deadline_kind as never, order.next_deadline_at, audience);
  }
  const d = orderDeadlineForRow(
    {
      status: order.status,
      source: order.source,
      created_at: order.created_at,
      due_at: order.due_at,
      cancel_requested_at: order.cancel_requested_at,
      last_submission_at: lastSubmissionAt,
    },
    now,
  );
  return d ? deadlineCopy(d.kind, d.deadline_at, audience) : null;
}

export function creatorOrderAmountCents(order: {
  id: string;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
  payout_amount_cents: number | null;
}): { fees: CreatorFeeBreakdown; amount_cents: number; part_paid: boolean } {
  const fees = computeCreatorFees(order.price_cents);
  if (
    order.creator_fee_cents !== fees.creator_fee_cents ||
    order.creator_payout_cents !== fees.creator_payout_cents
  ) {
    throw new CreatorAreaError(
      "order_fees_inconsistent",
      "This job's numbers do not add up. Zavi has been told and will sort it out.",
      500,
    );
  }
  const part = order.payout_amount_cents;
  return {
    fees,
    amount_cents: part ?? fees.creator_payout_cents,
    part_paid: part != null && part !== fees.creator_payout_cents,
  };
}

export type CreatorEarningsLine = {
  order_id: string;
  title: string | null;
  status: CreatorOrderStatus;
  bucket: "held" | "on_the_way" | "paid";
  price_cents: number;
  creator_fee_cents: number;
  amount_cents: number;
  part_paid: boolean;
  currency: string;
  payout_ready_at: string | null;
  closed_at: string | null;
  business_name: string | null;
};

export type CreatorEarnings = {
  held_cents: number;
  on_the_way_cents: number;
  paid_cents: number;
  currency: "usd";
  lines: CreatorEarningsLine[];
};

export function earningsBucket(
  order: CreatorAreaOrderRow,
): CreatorEarningsLine["bucket"] | null {
  if (order.chargeback_status === "open" && (order.payout_status === "ready" || order.payout_status === "awaiting_payout_account")) {
    return "held";
  }
  if (order.chargeback_status === "lost" && order.payout_status !== "transferred") {
    return null;
  }
  switch (order.payout_status) {
    case "transferred":
      return "paid";
    case "transferring":
      return "on_the_way";
    case "awaiting_payout_account":
      return "held";
    case "ready":
      return order.payout_ready_at && new Date(order.payout_ready_at) > new Date()
        ? "held"
        : "on_the_way";
    case "not_due":
      if (order.status === "cancelled") return null;
      if (order.status === "checkout_pending" || order.status === "awaiting_acceptance") {
        return null;
      }
      return "held";
    case "not_applicable":
    case "reversed":
    default:
      return null;
  }
}

const EARNING_PAYOUT_STATUSES = ["not_due", "ready", "awaiting_payout_account", "transferring", "transferred"] as const;
const EARNINGS_PAGE = 1000;

async function listEarningsOrders(memberId: string): Promise<CreatorAreaOrderRow[]> {
  const out: CreatorAreaOrderRow[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += EARNINGS_PAGE) {
    const { data, error } = await sb()
      .from(ORDERS)
      .select(ORDER_COLUMNS)
      .eq("human_member_id", memberId)
      .neq("status", "checkout_pending")
      .or(PAID_ORDER_FILTER)
      .in("payout_status", EARNING_PAYOUT_STATUSES as unknown as string[])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + EARNINGS_PAGE - 1);
    if (error) fail("list earnings", error);
    const page = (data as unknown as CreatorAreaOrderRow[] | null) ?? [];
    out.push(...page.filter((row) => !seen.has(row.id)));
    for (const row of page) seen.add(row.id);
    if (page.length < EARNINGS_PAGE) return out;
  }
}

function snapshotTitle(order: CreatorAreaOrderRow): string | null {
  const t = order.package_snapshot?.["title"];
  return typeof t === "string" && t.trim() ? t : null;
}

export async function creatorEarnings(
  memberId: string,
  businessName: (tenant_id: string) => Promise<string> = async () => "",
): Promise<CreatorEarnings> {
  const orders = await listEarningsOrders(memberId);
  const names = new Map<string, Promise<string>>();
  const nameOf = (tid: string) => {
    if (!names.has(tid)) names.set(tid, businessName(tid).catch(() => ""));
    return names.get(tid)!;
  };
  const lines: CreatorEarningsLine[] = [];
  let held = 0;
  let onTheWay = 0;
  let paid = 0;

  for (const o of orders) {
    const bucket = earningsBucket(o);
    if (!bucket) {
      if (o.status === "checkout_pending" || o.status === "awaiting_acceptance") {
        creatorOrderAmountCents(o);
      }
      continue;
    }
    const { fees, amount_cents, part_paid } = creatorOrderAmountCents(o);
    if (bucket === "held") held += amount_cents;
    else if (bucket === "on_the_way") onTheWay += amount_cents;
    else paid += amount_cents;
    if (lines.length >= LIST_LIMIT) continue;
    lines.push({
      order_id: o.id,
      title: snapshotTitle(o),
      status: o.status,
      bucket,
      price_cents: o.price_cents,
      creator_fee_cents: fees.creator_fee_cents,
      amount_cents,
      part_paid,
      currency: o.currency,
      payout_ready_at: o.payout_ready_at,
      closed_at: o.closed_at,
      business_name: (await nameOf(o.tenant_id)) || null,
    });
  }

  return { held_cents: held, on_the_way_cents: onTheWay, paid_cents: paid, currency: "usd", lines };
}

export type CreatorNotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
};

const NOTIFICATION_COLUMNS = "id, kind, title, body, link_path, order_id, read_at, created_at";

export async function listCreatorNotifications(
  memberId: string,
  limit = 50,
  businessName: (tenant_id: string) => Promise<string> = async () => "",
): Promise<CreatorNotificationRow[]> {
  const { data, error } = await sb()
    .from(NOTIFICATIONS)
    .select(NOTIFICATION_COLUMNS)
    .eq("recipient_kind", "creator")
    .eq("human_member_id", memberId)
    .not("kind", "in", `(${BUSINESS_ONLY_EVENTS.join(",")})`)
    .not("kind", "like", "reminder_review_%")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, LIST_LIMIT));
  if (error) fail("list notifications", error);
  const rows = (data as CreatorNotificationRow[] | null) ?? [];
  return nameTheBusiness(memberId, rows, businessName);
}

const OLD_BUSINESS_PLACEHOLDER = /\bThe business\b/;

async function nameTheBusiness(
  memberId: string,
  rows: CreatorNotificationRow[],
  businessName: (tenant_id: string) => Promise<string>,
): Promise<CreatorNotificationRow[]> {
  const stale = rows.filter((r) => OLD_BUSINESS_PLACEHOLDER.test(`${r.title}\n${r.body ?? ""}`));
  if (stale.length === 0) return rows;
  const orderIds = Array.from(new Set(stale.map((r) => r.order_id).filter((id): id is string => Boolean(id))));
  const tenantOf = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data } = await sb().from(ORDERS).select("id, tenant_id").eq("human_member_id", memberId).in("id", orderIds);
    for (const o of (data ?? []) as { id: string; tenant_id: string }[]) tenantOf.set(o.id, o.tenant_id);
  }
  const names = new Map<string, string>();
  for (const tid of Array.from(new Set(tenantOf.values()))) {
    names.set(tid, (await businessName(tid).catch(() => "")).trim());
  }
  const fill = (text: string, who: string) => text.split("The business").join(who);
  return rows.map((r) => {
    const tid = r.order_id ? tenantOf.get(r.order_id) : undefined;
    const who = (tid && names.get(tid)) || BUSINESS_NAME_FALLBACK;
    return { ...r, title: fill(r.title, who), body: r.body === null ? null : fill(r.body, who) };
  });
}

export async function markCreatorNotificationRead(
  memberId: string,
  notificationId: string,
): Promise<boolean> {
  const { data, error } = await sb()
    .from(NOTIFICATIONS)
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("recipient_kind", "creator")
    .eq("human_member_id", memberId)
    .select("id");
  if (error) fail("mark notification read", error);
  return Array.isArray(data) && data.length > 0;
}

export type CreatorThreadMessageRow = {
  id: string;
  sender_kind: "tenant" | "creator" | "staff" | "system";
  body: string;
  created_at: string;
};

export async function creatorJobThreadId(order: CreatorAreaOrderRow): Promise<string | null> {
  if (order.thread_id) return order.thread_id;
  const { data, error } = await sb()
    .from("creator_threads")
    .select("id")
    .eq("tenant_id", order.tenant_id)
    .eq("human_member_id", order.human_member_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) fail("load job thread", error);
  return (data as { id?: string } | null)?.id ?? null;
}

export async function listCreatorThreadMessages(
  order: CreatorAreaOrderRow,
  limit = 100,
): Promise<CreatorThreadMessageRow[]> {
  const thread_id = await creatorJobThreadId(order);
  if (!thread_id) return [];
  const { data, error } = await sb()
    .from(THREAD_MESSAGES)
    .select("id, sender_kind, body, created_at")
    .eq("tenant_id", order.tenant_id)
    .eq("thread_id", thread_id)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, LIST_LIMIT));
  if (error) fail("list thread messages", error);
  return [...((data as CreatorThreadMessageRow[] | null) ?? [])].reverse();
}

export const CREATOR_CAN_OPEN_THREAD: ReadonlySet<CreatorOrderStatus> = new Set<CreatorOrderStatus>([
  "in_progress",
  "submitted",
  "revision_requested",
  "cancel_requested",
  "in_dispute",
]);

export async function postCreatorThreadMessage(
  order: CreatorAreaOrderRow,
  body: string,
  sender_user_id: string,
): Promise<CreatorThreadMessageRow> {
  let thread_id = await creatorJobThreadId(order);
  if (!thread_id && CREATOR_CAN_OPEN_THREAD.has(order.status)) {
    try {
      const thread = await ensureCreatorThread({
        tenant_id: order.tenant_id,
        human_member_id: order.human_member_id,
        started_by: "creator",
        started_by_user_id: sender_user_id,
      });
      thread_id = thread.id;
    } catch (e) {
      fail("open job thread", { message: (e as Error)?.message });
    }
  }
  if (!thread_id) {
    throw new CreatorAreaError(
      "no_thread",
      "You can message the business once you have accepted the job.",
      409,
    );
  }
  try {
    const row = await postThreadMessageScrubbed({
      access: {
        tenant_id: order.tenant_id,
        thread_id,
        human_member_id: order.human_member_id,
        sender_kind: "creator",
      },
      sender_user_id,
      body,
    });
    return row as CreatorThreadMessageRow;
  } catch (e) {
    fail("post thread message", { message: (e as Error)?.message });
  }
}

export type CreatorThreadListRow = {
  thread_id: string;
  tenant_id: string;
  last_message_at: string;
  last_message: { body: string; sender_kind: string; created_at: string } | null;
  open_offer: {
    proposed_by: "tenant" | "creator";
    kind: string;
    terms: Record<string, unknown>;
    price_cents: number;
    created_at: string;
  } | null;
};

export async function listCreatorThreadsForMember(
  memberId: string,
  now: Date = new Date(),
): Promise<CreatorThreadListRow[]> {
  const { data: threads, error } = await sb()
    .from("creator_threads")
    .select("id, tenant_id, last_message_at, created_at")
    .eq("human_member_id", memberId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) fail("list threads", error);
  const rows = (threads ?? []) as Array<{
    id: string;
    tenant_id: string;
    last_message_at: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const lastMessages = Promise.all(
    ids.map((id) =>
      sb()
        .from(THREAD_MESSAGES)
        .select("thread_id, body, sender_kind, created_at")
        .eq("thread_id", id)
        .order("created_at", { ascending: false })
        .limit(1),
    ),
  ).then((rs) => {
    const bad = rs.find((r) => r.error);
    return { data: bad ? null : rs.flatMap((r) => (r.data ?? []) as unknown[]), error: bad?.error ?? null };
  });
  const [msgs, offers] = await Promise.all([
    lastMessages,
    sb()
      .from("creator_offers")
      .select("thread_id, proposed_by, kind, terms, price_cents, expires_at, created_at")
      .eq("human_member_id", memberId)
      .eq("status", "open")
      .in("thread_id", ids)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (msgs.error) fail("list thread messages", msgs.error);
  if (offers.error) fail("list thread offers", offers.error);

  const last = new Map<string, { body: string; sender_kind: string; created_at: string }>();
  for (const m of (msgs.data ?? []) as Array<{ thread_id: string; body: string; sender_kind: string; created_at: string }>) {
    if (!last.has(m.thread_id)) last.set(m.thread_id, { body: m.body, sender_kind: m.sender_kind, created_at: m.created_at });
  }
  const open = new Map<string, NonNullable<CreatorThreadListRow["open_offer"]>>();
  for (const o of (offers.data ?? []) as Array<{
    thread_id: string;
    proposed_by: "tenant" | "creator";
    kind: string;
    terms: Record<string, unknown> | null;
    price_cents: number;
    expires_at: string;
    created_at: string;
  }>) {
    if (now.getTime() >= new Date(o.expires_at).getTime()) continue;
    if (!open.has(o.thread_id)) {
      open.set(o.thread_id, {
        proposed_by: o.proposed_by,
        kind: o.kind,
        terms: o.terms ?? {},
        price_cents: o.price_cents,
        created_at: o.created_at,
      });
    }
  }
  return rows.map((r) => ({
    thread_id: r.id,
    tenant_id: r.tenant_id,
    last_message_at: r.last_message_at ?? r.created_at,
    last_message: last.get(r.id) ?? null,
    open_offer: open.get(r.id) ?? null,
  }));
}

export async function offerProposedBy(order: CreatorAreaOrderRow): Promise<"tenant" | "creator" | null> {
  if (!order.offer_id) return null;
  const { data, error } = await sb()
    .from("creator_offers")
    .select("proposed_by")
    .eq("id", order.offer_id)
    .eq("human_member_id", order.human_member_id)
    .maybeSingle();
  if (error) fail("load offer side", error);
  const side = (data as { proposed_by?: string } | null)?.proposed_by;
  return side === "tenant" || side === "creator" ? side : null;
}

export async function latestChangeRequestNote(order: CreatorAreaOrderRow): Promise<string | null> {
  const { data, error } = await sb()
    .from(NOTIFICATIONS)
    .select("body, created_at")
    .eq("human_member_id", order.human_member_id)
    .eq("order_id", order.id)
    .eq("kind", "revision_requested")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) fail("load change request", error);
  return changeNoteFromBody(((data ?? []) as Array<{ body: string | null }>)[0]?.body ?? "");
}

export function changeNoteFromBody(body: string | null): string | null {
  const first = (body ?? "").split("\n\n")[0]?.trim() ?? "";
  if (!first || / asked for changes on .*The notes are in the job thread\.$/.test(first)) return null;
  return first;
}

export type CreatorPackageRow = {
  id: string;
  human_member_id: string;
  kind: "ugc_video";
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: unknown;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const PACKAGE_COLUMNS = "*";

function toPackageRow(r: Record<string, unknown>): CreatorPackageRow {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const txt = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: String(r.id),
    human_member_id: String(r.human_member_id),
    kind: "ugc_video",
    title: String(r.title ?? ""),
    description: txt(r.description),
    price_cents: Number(r.price_cents ?? 0),
    currency: String(r.currency ?? "usd"),
    delivery_days: Number(r.delivery_days ?? 0),
    video_count: num(r.video_count),
    video_length_seconds: num(r.video_length_seconds),
    ad_rights_days: num(r.ad_rights_days),
    addons: r.addons ?? [],
    active: r.active === true,
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

export async function listCreatorPackages(memberId: string): Promise<CreatorPackageRow[]> {
  const { data, error } = await sb()
    .from(PACKAGES)
    .select(PACKAGE_COLUMNS)
    .eq("human_member_id", memberId)
    .eq("kind", "ugc_video")
    .order("created_at", { ascending: true })
    .limit(LIST_LIMIT);
  if (error) fail("list packages", error);
  return ((data as unknown as Array<Record<string, unknown>> | null) ?? []).map(toPackageRow);
}

export async function updateCreatorPackage(
  memberId: string,
  packageId: string,
  patch: { price_cents?: number; title?: string; description?: string | null; active?: boolean },
): Promise<CreatorPackageRow | null> {
  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.price_cents !== undefined) next.price_cents = patch.price_cents;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.active !== undefined) next.active = patch.active;

  const { data, error } = await sb()
    .from(PACKAGES)
    .update(next)
    .eq("id", packageId)
    .eq("human_member_id", memberId)
    .eq("kind", "ugc_video")
    .select(PACKAGE_COLUMNS)
    .maybeSingle();
  if (error) fail("update package", error);
  return data ? toPackageRow(data as unknown as Record<string, unknown>) : null;
}

