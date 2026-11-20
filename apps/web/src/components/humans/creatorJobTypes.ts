
export type DeadlineKind =
  | "accept"
  | "review"
  | "due"
  | "no_show_grace"
  | "cancel_response"
  | "offer_expiry"
  | "checkout_expiry";

export type DeadlineCopy = {
  kind: DeadlineKind;
  deadline_at: string;
  deadline_text: string;
  consequence_text: string;
  line: string;
};

export type CreatorOrderStatus =
  | "checkout_pending"
  | "awaiting_acceptance"
  | "in_progress"
  | "submitted"
  | "revision_requested"
  | "cancel_requested"
  | "in_dispute"
  | "completed"
  | "cancelled";

export type CreatorOrderSource = "booking" | "offer" | "applicant";

export type BusinessAction =
  | "approve"
  | "request_change"
  | "request_cancellation"
  | "withdraw"
  | "approve_extension"
  | "decline_extension"
  | "ask_zavi"
  | "ask_zavi_in_buffer";

export type BookingBlock = { code: string; message: string };

export type BookingBriefPrefill = {
  brief_id: string;
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: number | null;
};

export type CreatorBookingQuote = {
  source: CreatorOrderSource;
  creator: {
    human_member_id: string;
    display_name: string;
    slug: string | null;
    city: string | null;
    country_code: string | null;
    payout_supported: boolean;
  };
  job: {
    title: string;
    kind: string;
    delivery_days: number | null;
    package_id: string | null;
    offer_id: string | null;
    application_id: string | null;
    brief_id: string | null;
  };
  brief_prefill: BookingBriefPrefill | null;
  money: {
    currency: string;
    price_cents: number;
    business_fee_cents: number;
    business_total_cents: number;
    business_fee_label: string;
  };
  due_at: string | null;
  due_deadline: DeadlineCopy | null;
  due_after_accept?: string | null;
  product_needed?: boolean;
  accept_window: { hours: number; consequence_text: string } | null;
  charge_now_text?: string | null;
  needs_large_amount_confirm: boolean;
  large_amount_confirm_cents: number;
  blocked: BookingBlock | null;
};

export type CreatorOrderCreated = {
  order_id: string;
  checkout_url: string | null;
  quote: CreatorBookingQuote;
  reused_existing: boolean;
};

export type CreatorFulfilResult =
  | {
      state: "fulfilled";
      order_id: string;
      status: CreatorOrderStatus;
      payment_intent_id: string;
      hold_expires_at: string | null;
    }
  | { state: "already_done"; order_id: string; status: CreatorOrderStatus }
  | { state: "pending"; order_id: string; reason: string }
  | { state: "cancelled"; order_id: string; status: CreatorOrderStatus; message: string }
  | { state: "needs_staff"; order_id: string; message: string };

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
  human_member_id?: string;
  brief_id?: string | null;
  created_at: string;
  due_at: string | null;
  money: CreatorJobMoney;
  deadline: DeadlineCopy | null;
  due_after_accept?: string | null;
  awaiting_creator: boolean;
  extension_state?: "requested" | "approved" | "declined" | null;
  extension_requested_due_at?: string | null;
  product_needed?: boolean;
  product_received_at?: string | null;
  closed_at?: string | null;
  revisions_used?: number;
  refunded_cents?: number | null;
  offer_id?: string | null;
  offer_expired?: boolean;
  awaiting_hire_approval?: boolean;
};

export function isNeverPaidJob(j: Pick<CreatorJobSummary, "status" | "closed_reason">): boolean {
  return j.status === "checkout_pending" || (j.status === "cancelled" && j.closed_reason === "checkout_abandoned");
}

export type CreatorJobsResponse = { jobs: CreatorJobSummary[] };

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
  watermarked?: boolean;
  preview?: "ready" | "preparing" | "failed" | "unavailable" | null;
  preview_unavailable_reason?: "file_type" | "not_built" | null;
  download_url?: string | null;
};

export function submissionPreviewNote(s: Pick<CreatorJobSubmission, "watermarked" | "preview" | "download_url" | "preview_unavailable_reason">): string | null {
  if (s.download_url) return null;
  if (s.watermarked) return "This is a watermarked preview. The original, without the mark, unlocks to download and post once you approve and pay.";
  if (s.preview === "preparing") return "Zavi is putting a watermark on this file so you can review it. It shows here in a few minutes. The original unlocks to download and post once you approve and pay.";
  if (s.preview === "failed") return "The watermarked preview did not build yet. Zavi tries again on its own, so check back in a few minutes. The original unlocks once you approve and pay.";
  if (s.preview === "unavailable" && s.preview_unavailable_reason === "not_built") {
    return "Zavi could not build the watermarked preview after several tries, so nobody has checked this file yet. Before you approve, which pays the creator, message them or ask Zavi to step in. The original unlocks once you approve and pay.";
  }
  if (s.preview === "unavailable") return "Zavi could not make a watermarked preview of this file. Ask the creator to send it again as an MP4 or JPEG, or ask Zavi to step in. The original unlocks once you approve and pay.";
  return null;
}

export type CreatorThreadMessage = {
  id: string;
  sender_kind: "tenant" | "creator" | "staff" | "system";
  body: string;
  created_at: string;
};

export type CreatorThreadView = {
  available: boolean;
  thread_id: string | null;
  messages: CreatorThreadMessage[];
};

export type CreatorJobRebook = {
  package_id: string;
  title: string;
  price_cents: number;
  currency: string;
};

export type CreatorJobDetail = {
  job: CreatorJobSummary;
  package_snapshot: Record<string, unknown> | null;
  brief_snapshot: Record<string, unknown> | null;
  submissions: CreatorJobSubmission[];
  actions: CreatorJobActionOption[];
  rebook: CreatorJobRebook | null;
  revisions?: { used: number; left: number; max: number };
  extension: {
    state: "requested" | "approved" | "declined";
    requested_due_at: string | null;
  } | null;
  dispute: {
    status: "open" | "resolved";
    opened_by: "tenant" | "creator";
    reason: string;
    outcome: "pay_full" | "pay_part" | "refund" | null;
    resolution_note: string | null;
    created_at: string;
  } | null;
  thread: CreatorThreadView;
  change_requests?: { round: number; note: string | null; created_at: string }[];
  receipt?: CreatorJobReceipt | null;
};

export type CreatorJobReceipt = {
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  refunded_cents: number;
  paid_at: string;
  receipt_url: string | null;
  chargeback_status: "open" | "won" | "lost" | null;
};

export type CreatorActionResult = {
  ok: true;
  from: CreatorOrderStatus;
  to: CreatorOrderStatus;
  needs_staff_review: boolean;
  payout_waiting: boolean;
  library_asset_created: boolean;
  detail: CreatorJobDetail | null;
};
