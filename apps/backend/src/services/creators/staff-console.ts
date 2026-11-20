
import { globalClient, staffCrossTenantClient } from "@/services/tenant-client";
import { creatorPayoutCountrySupported } from "./payout-countries";
import type { CreatorOrderStatus, CreatorOrderTrigger } from "./order-state";

export const CREATOR_STAFF_PII_DENYLIST = [
  "tin",
  "tin_sha256",
  "payout_ref",
  "payout_ref_hash",
  "stripe_account_id",
  "bank_account",
  "bank_account_number",
  "routing_number",
  "iban",
  "date_of_birth",
  "dob",
  "stripe_payment_intent_id",
  "stripe_checkout_session_id",
  "stripe_transfer_id",
  "stripe_object_id",
] as const;

export class CreatorStaffError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "dispute_not_open"
      | "amounts_required"
      | "reason_required"
      | "store_error",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CreatorStaffError";
  }
}

function sb(reason: string) {
  return staffCrossTenantClient(reason);
}

function boom(what: string, error: { message?: string } | null): never {
  throw new CreatorStaffError(
    "store_error",
    `Could not read ${what}: ${error?.message ?? "unknown error"}`,
    503,
  );
}

export type StaffOrderMoneyView = {
  order_id: string;
  tenant_id: string;
  source: string;
  status: CreatorOrderStatus;
  closed_reason: string | null;
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  payout_amount_cents: number | null;
  payout_status: string;
  payout_ready_at: string | null;
  due_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  created_at: string;
  livemode: boolean;
};

export type StaffLedgerRow = {
  kind: string;
  cause: string;
  amount_cents: number;
  currency: string;
  actor_kind: string;
  livemode: boolean;
  created_at: string;
};

export type StaffCreatorSummary = {
  human_member_id: string;
  display_name: string;
  slug: string | null;
  vetting_state: string;
  city: string | null;
  country_code: string | null;
  payout_country_supported: boolean;
  missed_deadline_count: number;
  needs_staff_review: boolean;
};

export type StaffDisputeQueueItem = {
  dispute_id: string;
  kind: string;
  opened_by: string;
  reason: string;
  created_at: string;
  money_frozen: boolean;
  tenant_id: string;
  tenant_name: string | null;
  order: StaffOrderMoneyView;
  creator: StaffCreatorSummary;
};

export type StaffSubmissionView = {
  version: number;
  position: number;
  kind: string;
  storage_path: string;
  mime_type: string | null;
  bytes: number | null;
  note: string | null;
  created_at: string;
  signed_url: string | null;
};

export type StaffThreadMessageView = {
  sender_kind: string;
  body: string;
  created_at: string;
};

export type StaffDisputeDetail = {
  dispute: {
    dispute_id: string;
    kind: string;
    opened_by: string;
    opened_by_user_id: string | null;
    reason: string;
    status: string;
    outcome: string | null;
    resolution_note: string | null;
    resolved_at: string | null;
    created_at: string;
  };
  money_frozen: boolean;
  tenant_id: string;
  tenant_name: string | null;
  order: StaffOrderMoneyView;
  creator: StaffCreatorSummary;
  brief: {
    package_snapshot: Record<string, unknown> | null;
    brief_snapshot: Record<string, unknown> | null;
  };
  submissions: StaffSubmissionView[];
  thread: StaffThreadMessageView[];
  ledger: StaffLedgerRow[];
  pay_part_limits: { max_creator_amount_cents: number; max_refund_amount_cents: number; max_total_cents: number };
};

const ORDER_COLUMNS =
  "id,tenant_id,human_member_id,source,status,closed_reason,currency,price_cents," +
  "business_fee_cents,creator_fee_cents,business_total_cents,creator_payout_cents," +
  "payout_amount_cents,payout_status,payout_ready_at,due_at,accepted_at,closed_at," +
  "created_at,livemode,thread_id,package_snapshot,brief_snapshot";

type RawOrder = Record<string, unknown>;

function orderView(row: RawOrder): StaffOrderMoneyView {
  return {
    order_id: String(row.id),
    tenant_id: String(row.tenant_id),
    source: String(row.source),
    status: row.status as CreatorOrderStatus,
    closed_reason: (row.closed_reason as string | null) ?? null,
    currency: String(row.currency ?? "usd"),
    price_cents: Number(row.price_cents ?? 0),
    business_fee_cents: Number(row.business_fee_cents ?? 0),
    creator_fee_cents: Number(row.creator_fee_cents ?? 0),
    business_total_cents: Number(row.business_total_cents ?? 0),
    creator_payout_cents: Number(row.creator_payout_cents ?? 0),
    payout_amount_cents:
      row.payout_amount_cents == null ? null : Number(row.payout_amount_cents),
    payout_status: String(row.payout_status ?? "not_due"),
    payout_ready_at: (row.payout_ready_at as string | null) ?? null,
    due_at: (row.due_at as string | null) ?? null,
    accepted_at: (row.accepted_at as string | null) ?? null,
    closed_at: (row.closed_at as string | null) ?? null,
    created_at: String(row.created_at),
    livemode: Boolean(row.livemode),
  };
}

const CREATOR_SUMMARY_COLUMNS =
  "id,display_name,slug,vetting_state,city,country_code,missed_deadline_count";

export const MISSED_DEADLINE_REVIEW_THRESHOLD = 2;

function creatorSummary(row: Record<string, unknown> | null, fallbackId: string): StaffCreatorSummary {
  const marks = Number(row?.missed_deadline_count ?? 0);
  const cc = (row?.country_code as string | null) ?? null;
  return {
    human_member_id: String(row?.id ?? fallbackId),
    display_name: String(row?.display_name ?? "(unknown creator)"),
    slug: (row?.slug as string | null) ?? null,
    vetting_state: String(row?.vetting_state ?? "pending"),
    city: (row?.city as string | null) ?? null,
    country_code: cc,
    payout_country_supported: creatorPayoutCountrySupported(cc),
    missed_deadline_count: marks,
    needs_staff_review: marks >= MISSED_DEADLINE_REVIEW_THRESHOLD,
  };
}

async function readCreatorSummaries(ids: string[]): Promise<Map<string, StaffCreatorSummary>> {
  const out = new Map<string, StaffCreatorSummary>();
  if (ids.length === 0) return out;
  const { data, error } = await globalClient()
    .from("human_members")
    .select(CREATOR_SUMMARY_COLUMNS)
    .in("id", ids);
  if (error) boom("those creators", error);
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    out.set(String(row.id), creatorSummary(row, String(row.id)));
  }
  return out;
}

async function readTenantNames(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const { data, error } = await sb(
    "staff mediation screen labels each dispute with the workspace it belongs to",
  )
    .from("tenants")
    .select("id,display_name")
    .in("id", ids);
  if (error) boom("those workspaces", error);
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    out.set(String(row.id), (row.display_name as string | null) ?? null);
  }
  return out;
}

const QUEUE_REASON = "staff mediation queue lists open creator disputes across every tenant";

export async function listOpenCreatorDisputes(limit = 100): Promise<StaffDisputeQueueItem[]> {
  const client = sb(QUEUE_REASON);

  const { data: disputes, error } = await client
    .from("creator_disputes")
    .select(
      "id,tenant_id,order_id,kind,opened_by,reason,status,created_at",
    )
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) boom("the dispute queue", error);

  const rows = (disputes ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const orderIds = [...new Set(rows.map((d) => String(d.order_id)))];
  const { data: orders, error: oErr } = await client
    .from("creator_orders")
    .select(ORDER_COLUMNS)
    .in("id", orderIds);
  if (oErr) boom("the orders behind those disputes", oErr);
  const orderById = new Map<string, RawOrder>(
    ((orders ?? []) as unknown as RawOrder[]).map((o) => [String(o.id), o]),
  );

  const creatorIds = [
    ...new Set(
      ((orders ?? []) as unknown as RawOrder[]).map((o) => String(o.human_member_id)).filter(Boolean),
    ),
  ];
  const creatorById = await readCreatorSummaries(creatorIds);
  const tenantNameById = await readTenantNames([...new Set(rows.map((d) => String(d.tenant_id)))]);

  const items: StaffDisputeQueueItem[] = [];
  for (const d of rows) {
    const order = orderById.get(String(d.order_id));
    if (!order) continue;
    items.push({
      dispute_id: String(d.id),
      kind: String(d.kind),
      opened_by: String(d.opened_by),
      reason: String(d.reason),
      created_at: String(d.created_at),
      money_frozen: true,
      tenant_id: String(d.tenant_id),
      tenant_name: tenantNameById.get(String(d.tenant_id)) ?? null,
      order: orderView(order),
      creator:
        creatorById.get(String(order.human_member_id)) ??
        creatorSummary(null, String(order.human_member_id)),
    });
  }
  return items;
}

export async function getCreatorDisputeDetail(dispute_id: string): Promise<StaffDisputeDetail> {
  const client = sb("staff mediation screen reads one creator dispute in whatever tenant owns it");

  const { data: d, error } = await client
    .from("creator_disputes")
    .select(
      "id,tenant_id,order_id,kind,opened_by,opened_by_user_id,reason,status,outcome," +
        "creator_amount_cents,refund_amount_cents,resolution_note,resolved_at,created_at",
    )
    .eq("id", dispute_id)
    .maybeSingle();
  if (error) boom("that dispute", error);
  const dispute = d as Record<string, unknown> | null;
  if (!dispute) throw new CreatorStaffError("not_found", "No creator dispute with that id.", 404);

  const tenant_id = String(dispute.tenant_id);
  const order_id = String(dispute.order_id);

  const { data: o, error: oErr } = await client
    .from("creator_orders")
    .select(ORDER_COLUMNS)
    .eq("id", order_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (oErr) boom("the order behind that dispute", oErr);
  const order = o as RawOrder | null;
  if (!order) throw new CreatorStaffError("not_found", "That dispute's order is missing.", 404);

  const [submissions, thread, ledger, creators, tenantNames] = await Promise.all([
    readSubmissions(client, tenant_id, order_id),
    readThread(client, tenant_id, (order.thread_id as string | null) ?? null),
    readLedger(client, tenant_id, order_id),
    readCreatorSummaries([String(order.human_member_id)]),
    readTenantNames([tenant_id]),
  ]);

  const view = orderView(order);
  return {
    dispute: {
      dispute_id: String(dispute.id),
      kind: String(dispute.kind),
      opened_by: String(dispute.opened_by),
      opened_by_user_id: (dispute.opened_by_user_id as string | null) ?? null,
      reason: String(dispute.reason),
      status: String(dispute.status),
      outcome: (dispute.outcome as string | null) ?? null,
      resolution_note: (dispute.resolution_note as string | null) ?? null,
      resolved_at: (dispute.resolved_at as string | null) ?? null,
      created_at: String(dispute.created_at),
    },
    money_frozen: String(dispute.status) === "open",
    tenant_id,
    tenant_name: tenantNames.get(tenant_id) ?? null,
    order: view,
    creator:
      creators.get(String(order.human_member_id)) ??
      creatorSummary(null, String(order.human_member_id)),
    brief: {
      package_snapshot: (order.package_snapshot as Record<string, unknown> | null) ?? null,
      brief_snapshot: (order.brief_snapshot as Record<string, unknown> | null) ?? null,
    },
    submissions,
    thread,
    ledger,
    pay_part_limits: {
      max_creator_amount_cents: view.creator_payout_cents,
      max_refund_amount_cents: view.business_total_cents,
      max_total_cents: view.business_total_cents,
    },
  };
}

const DELIVERABLES_BUCKET = "creator-deliverables";
const SIGNED_URL_TTL_SECONDS = 600;

async function readSubmissions(
  client: ReturnType<typeof staffCrossTenantClient>,
  tenant_id: string,
  order_id: string,
): Promise<StaffSubmissionView[]> {
  const { data, error } = await client
    .from("creator_submissions")
    .select("version,position,kind,storage_path,mime_type,bytes,note,created_at")
    .eq("tenant_id", tenant_id)
    .eq("order_id", order_id)
    .order("version", { ascending: true })
    .order("position", { ascending: true });
  if (error) boom("the submissions on that order", error);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return Promise.all(
    rows.map(async (r) => ({
      version: Number(r.version),
      position: Number(r.position),
      kind: String(r.kind),
      storage_path: String(r.storage_path),
      mime_type: (r.mime_type as string | null) ?? null,
      bytes: r.bytes == null ? null : Number(r.bytes),
      note: (r.note as string | null) ?? null,
      created_at: String(r.created_at),
      signed_url: await signDeliverable(client, String(r.storage_path)),
    })),
  );
}

async function signDeliverable(
  client: ReturnType<typeof staffCrossTenantClient>,
  path: string,
): Promise<string | null> {
  try {
    const { data, error } = await client.storage
      .from(DELIVERABLES_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) return null;
    return (data as { signedUrl?: string } | null)?.signedUrl ?? null;
  } catch {
    return null;
  }
}

async function readThread(
  client: ReturnType<typeof staffCrossTenantClient>,
  tenant_id: string,
  thread_id: string | null,
): Promise<StaffThreadMessageView[]> {
  if (!thread_id) return [];
  const { data, error } = await client
    .from("creator_thread_messages")
    .select("sender_kind,body,created_at")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .order("created_at", { ascending: true });
  if (error) boom("the job thread", error);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((m) => ({
    sender_kind: String(m.sender_kind),
    body: String(m.body),
    created_at: String(m.created_at),
  }));
}

async function readLedger(
  client: ReturnType<typeof staffCrossTenantClient>,
  tenant_id: string,
  order_id: string,
): Promise<StaffLedgerRow[]> {
  const { data, error } = await client
    .from("creator_money_events")
    .select("kind,cause,amount_cents,currency,actor_kind,livemode,created_at")
    .eq("tenant_id", tenant_id)
    .eq("order_id", order_id)
    .order("created_at", { ascending: true });
  if (error) boom("the money ledger for that order", error);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    kind: String(r.kind),
    cause: String(r.cause),
    amount_cents: Number(r.amount_cents),
    currency: String(r.currency ?? "usd"),
    actor_kind: String(r.actor_kind),
    livemode: Boolean(r.livemode),
    created_at: String(r.created_at),
  }));
}

export type MediationOutcome = "pay_full" | "pay_part" | "refund";

export const MEDIATION_TRIGGER: Record<MediationOutcome, CreatorOrderTrigger> = {
  pay_full: "mediation_pay_full",
  pay_part: "mediation_pay_part",
  refund: "mediation_refund",
};

export type MediationTarget = {
  tenant_id: string;
  order_id: string;
  human_member_id: string;
  trigger: CreatorOrderTrigger;
};

export async function resolveMediationTarget(
  dispute_id: string,
  outcome: MediationOutcome,
): Promise<MediationTarget> {
  const client = sb("staff mediation resolves the tenant and order from the dispute row itself");
  const { data, error } = await client
    .from("creator_disputes")
    .select("id,tenant_id,order_id,status")
    .eq("id", dispute_id)
    .maybeSingle();
  if (error) boom("that dispute", error);
  const row = data as Record<string, unknown> | null;
  if (!row) throw new CreatorStaffError("not_found", "No creator dispute with that id.", 404);
  if (String(row.status) !== "open") {
    throw new CreatorStaffError(
      "dispute_not_open",
      "That dispute has already been decided. Money only moves once per job.",
      409,
    );
  }

  const tenant_id = String(row.tenant_id);
  const order_id = String(row.order_id);
  const { data: o, error: oErr } = await client
    .from("creator_orders")
    .select("human_member_id")
    .eq("id", order_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (oErr) boom("the order behind that dispute", oErr);
  const order = o as { human_member_id?: string } | null;
  if (!order) throw new CreatorStaffError("not_found", "That dispute's order is missing.", 404);

  return {
    tenant_id,
    order_id,
    human_member_id: String(order.human_member_id),
    trigger: MEDIATION_TRIGGER[outcome],
  };
}

export type StaffPackageView = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  active: boolean;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: unknown;
};

export type StaffCreatorProfile = {
  human_member_id: string;
  slug: string | null;
  lanes: string[];
  city: string | null;
  country_code: string | null
;
  payout_country_supported: boolean;
  intro_video_path: string | null;
  sample_video_paths: string[];
  self_reported_audience: {
    label: "Self-reported, not checked by Zavi";
    verified: false;
    metrics: Record<string, unknown>;
  };
  packages: StaffPackageView[];
  is_18_plus: boolean | null;
  payout_account: {
    exists: boolean;
    livemode: boolean | null;
    country: string | null;
    details_submitted: boolean;
    payouts_enabled: boolean;
    disabled_reason: string | null;
  };
  marks: {
    missed_deadline_count: number;
    needs_staff_review: boolean;
    threshold: number;
    derived_from: "no_show order transitions";
  };
};

export function yearsOldOn(dateOfBirth: string | null | undefined, asOf: Date): number | null {
  if (!dateOfBirth) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateOfBirth));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = asOf.getUTCFullYear() - y;
  const beforeBirthday =
    asOf.getUTCMonth() + 1 < mo || (asOf.getUTCMonth() + 1 === mo && asOf.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export async function getStaffCreatorProfile(
  human_member_id: string,
  now: Date = new Date(),
): Promise<StaffCreatorProfile> {
  const g = globalClient();

  const { data: m, error } = await g
    .from("human_members")
    .select(
      "id,slug,lanes,city,country_code,missed_deadline_count,intro_video_path," +
        "sample_video_paths,public_metrics",
    )
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) boom("that creator", error);
  const member = m as Record<string, unknown> | null;
  if (!member) throw new CreatorStaffError("not_found", "No creator with that id.", 404);

  const { data: pii, error: pErr } = await g
    .from("human_member_pii")
    .select("date_of_birth, age_years")
    .eq("human_member_id", human_member_id)
    .maybeSingle();
  if (pErr) boom("the 18+ check for that creator", pErr);
  const p = pii as { date_of_birth?: string | null; age_years?: number | null } | null;
  const age = yearsOldOn(p?.date_of_birth, now) ?? (typeof p?.age_years === "number" ? p.age_years : null);

  const { data: pkgs, error: kErr } = await g
    .from("creator_packages")
    .select(
      "id,kind,title,description,price_cents,currency,delivery_days,active,video_count," +
        "video_length_seconds,ad_rights_days,addons",
    )
    .eq("human_member_id", human_member_id)
    .order("created_at", { ascending: true });
  if (kErr) boom("that creator's packages", kErr);

  const { data: acct, error: aErr } = await g
    .from("creator_payout_accounts")
    .select("livemode,country,details_submitted,payouts_enabled,disabled_reason")
    .eq("human_member_id", human_member_id)
    .order("livemode", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (aErr) boom("that creator's payout state", aErr);
  const account = acct as Record<string, unknown> | null;

  const marks = Number(member.missed_deadline_count ?? 0);
  const cc = (member.country_code as string | null) ?? null;

  return {
    human_member_id: String(member.id),
    slug: (member.slug as string | null) ?? null,
    lanes: ((member.lanes as string[] | null) ?? []).slice(),
    city: (member.city as string | null) ?? null,
    country_code: cc,
    payout_country_supported: creatorPayoutCountrySupported(cc),
    intro_video_path: (member.intro_video_path as string | null) ?? null,
    sample_video_paths: ((member.sample_video_paths as string[] | null) ?? []).slice(),
    self_reported_audience: {
      label: "Self-reported, not checked by Zavi",
      verified: false,
      metrics: (member.public_metrics as Record<string, unknown> | null) ?? {},
    },
    packages: ((pkgs ?? []) as unknown as Array<Record<string, unknown>>).map((p) => ({
      id: String(p.id),
      kind: String(p.kind),
      title: String(p.title),
      description: (p.description as string | null) ?? null,
      price_cents: Number(p.price_cents),
      currency: String(p.currency ?? "usd"),
      delivery_days: Number(p.delivery_days),
      active: Boolean(p.active),
      video_count: p.video_count == null ? null : Number(p.video_count),
      video_length_seconds:
        p.video_length_seconds == null ? null : Number(p.video_length_seconds),
      ad_rights_days: p.ad_rights_days == null ? null : Number(p.ad_rights_days),
      addons: p.addons ?? [],
    })),
    is_18_plus: age === null ? null : age >= 18,
    payout_account: {
      exists: account != null,
      livemode: account == null ? null : Boolean(account.livemode),
      country: account == null ? null : ((account.country as string | null) ?? null),
      details_submitted: Boolean(account?.details_submitted),
      payouts_enabled: Boolean(account?.payouts_enabled),
      disabled_reason: (account?.disabled_reason as string | null) ?? null,
    },
    marks: {
      missed_deadline_count: marks,
      needs_staff_review: marks >= MISSED_DEADLINE_REVIEW_THRESHOLD,
      threshold: MISSED_DEADLINE_REVIEW_THRESHOLD,
      derived_from: "no_show order transitions",
    },
  };
}

export const REMOVAL_CANCELS_ORDER_STATUSES: readonly CreatorOrderStatus[] = [
  "checkout_pending",
  "awaiting_acceptance",
];

export const REMOVAL_WITHDRAWS_APPLICATION_STATUSES = ["applied", "shortlisted"] as const;

export const REMOVAL_WITHDRAWS_OFFER_STATUSES = ["open"] as const;

export type PendingOrderRef = { tenant_id: string; order_id: string; status: CreatorOrderStatus };

export async function listRemovablePendingOrders(
  human_member_id: string,
): Promise<PendingOrderRef[]> {
  const { data, error } = await sb(
    "creator removal finds that creator's pending requests in every tenant so their holds drop",
  )
    .from("creator_orders")
    .select("id,tenant_id,status")
    .eq("human_member_id", human_member_id)
    .in("status", REMOVAL_CANCELS_ORDER_STATUSES as unknown as string[])
    .order("created_at", { ascending: true });
  if (error) boom("that creator's pending requests", error);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    tenant_id: String(r.tenant_id),
    order_id: String(r.id),
    status: r.status as CreatorOrderStatus,
  }));
}

export async function listUntouchedInFlightOrders(
  human_member_id: string,
): Promise<PendingOrderRef[]> {
  const { data, error } = await sb(
    "creator removal reports which in-progress jobs it is leaving to finish and pay out",
  )
    .from("creator_orders")
    .select("id,tenant_id,status")
    .eq("human_member_id", human_member_id)
    .not("status", "in", `(${[...REMOVAL_CANCELS_ORDER_STATUSES, "completed", "cancelled"].join(",")})`)
    .order("created_at", { ascending: true });
  if (error) boom("that creator's in-progress jobs", error);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    tenant_id: String(r.tenant_id),
    order_id: String(r.id),
    status: r.status as CreatorOrderStatus,
  }));
}

export async function withdrawOpenApplications(human_member_id: string): Promise<number> {
  const { data, error } = await sb(
    "creator removal withdraws that creator's open brief applications in every tenant",
  )
    .from("brief_applications")
    .update({ status: "withdrawn", updated_at: new Date().toISOString() })
    .eq("human_member_id", human_member_id)
    .in("status", REMOVAL_WITHDRAWS_APPLICATION_STATUSES as unknown as string[])
    .select("id");
  if (error) boom("that creator's applications", error);
  return ((data ?? []) as unknown[]).length;
}

export async function withdrawOpenOffers(human_member_id: string): Promise<number> {
  const { data, error } = await sb(
    "creator removal withdraws that creator's open custom offers so none can still be booked",
  )
    .from("creator_offers")
    .update({ status: "withdrawn", updated_at: new Date().toISOString() })
    .eq("human_member_id", human_member_id)
    .in("status", REMOVAL_WITHDRAWS_OFFER_STATUSES as unknown as string[])
    .select("id");
  if (error) boom("that creator's custom offers", error);
  return ((data ?? []) as unknown[]).length;
}
