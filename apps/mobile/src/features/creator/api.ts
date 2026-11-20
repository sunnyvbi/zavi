import { ApiFetchError, apiJson } from "../../lib/api";

export type DeadlineCopy = {
  kind: string;
  deadline_at: string;
  deadline_text: string;
  consequence_text: string;
  line: string;
};

export type CreatorJob = {
  id: string;
  source: "booking" | "offer" | "applicant";
  status: string;
  closed_reason: string | null;
  created_at: string;
  due_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  extension_state: "requested" | "approved" | "declined" | null;
  extension_requested_due_at: string | null;
  package: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  currency: string;
  price_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
  amount_cents: number;
  part_paid: boolean;
  payout_status: string;
  payout_ready_at: string | null;
  deadline: DeadlineCopy | null;
  submissions: {
    id: string;
    version: number;
    position: number;
    kind: string;
    mime_type: string | null;
    bytes: number | null;
    note: string | null;
    created_at: string;
  }[];
  has_thread: boolean;
  thread?: {
    id: string;
    sender_kind: "tenant" | "creator" | "staff" | "system";
    body: string;
    created_at: string;
  }[];
};

export type CreatorAlert = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type CreatorMe = {
  creator: {
    id: string;
    display_name: string;
    slug: string | null;
    lanes: string[];
    city: string | null;
    country_code: string | null;
    missed_deadline_count: number;
  };
  payout_country_supported: boolean | null;
  payout_account: { details_submitted: boolean; payouts_enabled: boolean } | null;
};

export type CreatorEarnings = {
  held_cents: number;
  on_the_way_cents: number;
  paid_cents: number;
  currency: string;
  lines: {
    order_id: string;
    title: string | null;
    status: string;
    bucket: "held" | "on_the_way" | "paid";
    price_cents: number;
    creator_fee_cents: number;
    amount_cents: number;
    part_paid: boolean;
    currency: string;
    payout_ready_at: string | null;
    closed_at: string | null;
  }[];
  payout: {
    connected: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
    country: string | null;
  };
  payout_country_supported: boolean | null;
};

export type CreatorPackage = {
  id: string;
  kind: "ugc_video";
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  active: boolean;
  fees: {
    price_cents: number;
    business_fee_cents: number;
    business_total_cents: number;
    creator_fee_cents: number;
    creator_payout_cents: number;
  };
};

export type CreatorBriefCard = {
  id: string;
  title: string | null;
  brief_kind: string | null;
  lane: string | null;
  budget_usd: number | null;
  delivery_days: number | null;
  answer_by: string | null;
  applicant_cap: number | null;
  posted_at: string;
};

export type CreatorUploadSlot = {
  bucket: string;
  path: string;
  token: string;
  signed_url: string;
};

export type CreatorSubmissionFile = {
  kind: string;
  storage_path: string;
  mime_type: string;
  bytes: number;
};

export class CreatorApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CreatorApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiJson<T>(path, init ?? {});
  } catch (e) {
    if (e instanceof ApiFetchError) throw new CreatorApiError(e.code, e.message, e.status);
    throw new CreatorApiError("request_failed", "Something went wrong. Try again.", 0);
  }
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

const seg = (id: string) => encodeURIComponent(id);

export const creatorApi = {
  me: () => call<CreatorMe>("/api/creator/me"),
  inbox: () =>
    call<{ requests: CreatorJob[]; alerts: CreatorAlert[]; unread_alerts: number; order: string }>(
      "/api/creator/inbox",
    ),
  markAlertRead: (id: string) => post<{ ok: true }>(`/api/creator/notifications/${seg(id)}/read`),
  briefs: () =>
    call<{
      briefs: CreatorBriefCard[];
      order: string;
      count_line: string;
      apply: { available: boolean; endpoint: string; method: "POST" };
    }>("/api/creator/briefs"),
  jobs: (scope: "active" | "all" = "active") =>
    call<{ jobs: CreatorJob[]; scope: string; order: string }>(`/api/creator/jobs?scope=${scope}`),
  job: (id: string) => call<{ job: CreatorJob }>(`/api/creator/jobs/${seg(id)}`),
  accept: (id: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${seg(id)}/accept`),
  pass: (id: string, reason: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${seg(id)}/pass`, { reason }),
  requestExtension: (id: string, requested_due_at: string, note: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${seg(id)}/extension`, {
      requested_due_at,
      note,
    }),
  sendMessage: (id: string, body: string) =>
    post<{ message: { id: string; sender_kind: string; body: string; created_at: string } }>(
      `/api/creator/jobs/${seg(id)}/messages`,
      { body },
    ),
  uploadUrl: (id: string, content_type: string) =>
    post<CreatorUploadSlot>(`/api/creator/jobs/${seg(id)}/upload-url`, { content_type }),
  submit: (id: string, files: CreatorSubmissionFile[], note: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${seg(id)}/submissions`, {
      files,
      note,
    }),
  earnings: () => call<CreatorEarnings>("/api/creator/earnings"),
  onboardingLink: () => post<{ url: string }>("/api/creator/payouts/onboarding-link"),
  taxFormsLink: () => post<{ url: string }>("/api/creator/payouts/tax-forms-link"),
  storefront: () =>
    call<{ slug: string | null; packages: CreatorPackage[] }>(
      "/api/creator/storefront",
    ),
  savePackage: (
    id: string,
    patch: { price_cents?: number; title?: string; description?: string | null; active?: boolean },
  ) =>
    call<{ package: CreatorPackage }>(`/api/creator/storefront/packages/${seg(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.trunc(abs / 100);
  const rest = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rest === 0 ? `${sign}$${grouped}` : `${sign}$${grouped}.${String(rest).padStart(2, "0")}`;
}

export const STATUS_WORDS: Record<string, string> = {
  checkout_pending: "Waiting on payment",
  awaiting_acceptance: "Waiting on you",
  in_progress: "In progress",
  submitted: "Sent for review",
  revision_requested: "Changes asked for",
  cancel_requested: "Cancellation asked for",
  in_dispute: "Zavi is looking at it",
  completed: "Done",
  cancelled: "Cancelled",
};

export function statusWords(status: string): string {
  return STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

export function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "not set";
}

export function jobTitle(job: CreatorJob): string {
  const t = job.package?.["title"];
  return typeof t === "string" && t.trim() ? t : "A job";
}
