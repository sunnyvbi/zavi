
import { isCreatorPath, plainNext } from "@/lib/safe-next";
import { apiFetch } from "@/lib/api";

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
  product_needed?: boolean;
  product_received_at?: string | null;
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
  due_after_accept?: string | null;
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
  business_name?: string | null;
  offer_proposed_by?: "tenant" | "creator" | null;
  revisions_used?: number;
  revisions_max?: number;
  change_request_note?: string | null;
  can_mark_product_received?: boolean;
  help_request?: { reason: string; opened_at: string } | null;
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

export type EarnMode = "affiliate" | "jobs" | "both";

export type CreatorSetup = {
  goal?: boolean;
  earn_mode?: EarnMode | null;
  dob: boolean;
  make: boolean;
  package: boolean;
  package_required?: boolean;
  done: number;
  total?: number;
  complete: boolean;
};

export type CreatorProfile = {
  age?: number | null;
  bio: string | null;
  intro_video_name: string | null;
  photo_url?: string | null;
  illustration_url?: string | null;
  niches: string[];
  country_code: string | null;
  accounts: { platform: string; handle: string; url: string | null; followers: number | null; label: string }[];
};

export type CreatorMe = {
  vetting_state: "pending" | "under_review" | "approved" | "rejected";
  setup: CreatorSetup;
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
    business_name?: string | null;
  }[];
  payout: {
    connected: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
    country: string | null;
    disabled_reason?: string | null;
  };
  payout_country_supported: boolean | null;
};

export type CreatorReviews = {
  aggregates: {
    review_count: number;
    avg_communication: number | null;
    avg_timeliness: number | null;
    avg_satisfaction: number | null;
    avg_overall: number | null;
  };
  reviews: {
    id: string;
    business_name: string;
    communication: number;
    timeliness: number;
    satisfaction: number;
    body: string | null;
    created_at: string;
  }[];
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
  business_name: string;
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: number | null;
  lane: string | null;
  budget_usd: number | null;
  delivery_days: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap: number | null;
  applicant_count: number;
  spots_left: number | null;
  open: boolean;
  closed_reason: string | null;
  spots_line: string;
  answer_by_line: string;
};

export type CreatorBriefBoard = {
  briefs: CreatorBriefCard[];
  applied_closed?: CreatorBriefCard[];
  order: string;
  count_line: string;
  lanes: string[];
  apply: { available: boolean; endpoint: string; method: "POST" };
};

export type CreatorQuoteFees = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
};

export type MyBriefApplication = {
  application_id: string;
  status: string;
  note: string;
  quoted_rate_usd: number | null;
  fees: CreatorQuoteFees | null;
  applied_at: string;
  hired_order_id?: string | null;
  hired_order_status?: string | null;
  business_note?: string | null;
};

export type OpenBriefDetail = {
  brief: Omit<CreatorBriefCard, "spots_line" | "answer_by_line">;
  spots_line: string;
  answer_by_line: string;
  my_application: MyBriefApplication | null;
};

export type CreatorThreadSummary = {
  thread_id: string;
  business_name: string;
  last_message_at: string;
  last_message: { body: string; sender_kind: string; created_at: string } | null;
  open_offer: {
    proposed_by: "tenant" | "creator";
    kind: string;
    terms: Record<string, unknown>;
    price_cents: number;
    creator_payout_cents: number;
    created_at: string;
  } | null;
};

export type ThreadMessage = {
  id: string;
  sender_kind: "tenant" | "creator" | "staff" | "system";
  body: string;
  created_at: string;
};

export type CreatorOffer = {
  id: string;
  thread_id: string | null;
  proposed_by: "tenant" | "creator";
  kind: string;
  terms: Record<string, unknown>;
  price_cents: number;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  product_needed?: boolean;
  fees: CreatorQuoteFees;
  expired: boolean;
  awaiting_payment?: boolean;
  closed_unpaid?: boolean;
};

export type NewOffer = {
  kind: "ugc_video";
  terms: Record<string, unknown>;
  price_cents: number;
  delivery_days: number;
  note?: string;
};

export class CreatorApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init ?? {});
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new CreatorApiError(
      err?.code ?? "request_failed",
      err?.message ?? "Something went wrong. Try again.",
      res.status,
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

export type CreatorAffiliate = {
  code: string;
  clicks_30d: number;
  signups: number;
  paying: number;
  pending_cents: number;
  payable_cents: number;
  paid_cents: number;
  open_payout: { state: string; amount_cents: number } | null;
  entries: Array<{
    created_at: string;
    kind: "commission" | "adjustment" | "recovered";
    amount_cents: number;
    month_index: number | null;
    rate: number | null;
    matures_at: string;
    paid: boolean;
  }>;
  payout: { connected: boolean; payouts_enabled: boolean; disconnected: boolean };
};

export const creatorApi = {
  me: () => call<CreatorMe>("/api/creator/me"),
  home: () =>
    call<{ home: "/workspace" | "/creator" | "/start"; has_company: boolean; in_any_company: boolean; is_creator: boolean }>(
      "/api/creator/home",
    ),
  signup: (display_name: string) => post<{ ok: true; created: boolean }>("/api/creator/signup", { display_name }),
  profile: () => call<CreatorProfile>("/api/creator/profile"),
  saveProfile: (patch: { display_name?: string; bio?: string | null; intro_video_path?: string | null; photo_path?: string | null; country_code?: string }) =>
    call<{ ok: true }>("/api/creator/profile", { method: "PATCH", body: JSON.stringify(patch) }),
  setupDob: (date_of_birth: string) => post<{ ok: true; setup: CreatorSetup }>("/api/creator/setup/dob", { date_of_birth }),
  setupEarn: (affiliate: boolean, jobs: boolean) => post<{ ok: true; setup: CreatorSetup }>("/api/creator/setup/earn", { affiliate, jobs }),
  setupAge: (age: number) => post<{ ok: true; setup: CreatorSetup }>("/api/creator/setup/dob", { age }),
  setupMake: (
    accounts: { platform: string; handle: string; followers: number }[],
    niches?: string[],
  ) => post<{ ok: true; setup: CreatorSetup }>("/api/creator/setup/make", niches ? { accounts, niches } : { accounts }),
  addPackage: (pkg: Record<string, unknown>) => post<{ ok: true; setup: CreatorSetup }>("/api/creator/packages", { package: pkg }),
  introUploadUrl: (content_type: string) =>
    post<{ path: string; token: string; signed_url: string }>("/api/humans/media-upload-url", { kind: "intro", content_type }),
  photoUploadUrl: (content_type: string, size_bytes: number) =>
    post<{ path: string; token: string; signed_url: string }>("/api/humans/media-upload-url", {
      kind: "photo",
      content_type,
      size_bytes,
    }),
  inbox: () =>
    call<{ requests: CreatorJob[]; alerts: CreatorAlert[]; unread_alerts: number; order: string }>(
      "/api/creator/inbox",
    ),
  markAlertRead: (id: string) => post<{ ok: true }>(`/api/creator/notifications/${id}/read`),
  briefs: () => call<CreatorBriefBoard>("/api/creator/briefs"),
  threads: () => call<{ threads: CreatorThreadSummary[]; order: string }>("/api/creator/threads"),
  threadMessages: (threadId: string) =>
    call<{ ok: true; messages: ThreadMessage[] }>(`/api/creators/threads/${encodeURIComponent(threadId)}/messages`),
  sendThreadMessage: (threadId: string, body: string) =>
    post<{ ok: true; message: ThreadMessage }>(`/api/creators/threads/${encodeURIComponent(threadId)}/messages`, { body }),
  threadOffers: (threadId: string) =>
    call<{ ok: true; offers: CreatorOffer[] }>(`/api/creators/threads/${encodeURIComponent(threadId)}/offers`),
  sendOffer: (threadId: string, offer: NewOffer) =>
    post<{ ok: true; offer: CreatorOffer }>(`/api/creators/threads/${encodeURIComponent(threadId)}/offers`, offer),
  acceptOffer: (offerId: string) =>
    post<{ ok: true; offer: CreatorOffer; order: { order_id: string; status: string } }>(
      `/api/creators/offers/${encodeURIComponent(offerId)}/accept`,
      {},
    ),
  declineOffer: (offerId: string) =>
    post<{ ok: true; offer: CreatorOffer }>(`/api/creators/offers/${encodeURIComponent(offerId)}/decline`, {}),
  withdrawOffer: (offerId: string) =>
    post<{ ok: true; offer: CreatorOffer }>(`/api/creators/offers/${encodeURIComponent(offerId)}/withdraw`, {}),
  openBrief: (id: string) =>
    call<OpenBriefDetail>(`/api/humans/open-briefs/${encodeURIComponent(id)}`),
  briefQuote: (id: string, quoted_rate_usd: string) =>
    call<{ fees: CreatorQuoteFees; explain: string }>(
      `/api/humans/open-briefs/${encodeURIComponent(id)}/quote?quoted_rate_usd=${encodeURIComponent(quoted_rate_usd)}`,
    ),
  applyToBrief: (id: string, quoted_rate_usd: string, note: string) =>
    post<{ ok: true; application_id: string; fees: CreatorQuoteFees; answer_by_line: string }>(
      `/api/humans/open-briefs/${encodeURIComponent(id)}/apply`,
      { quoted_rate_usd, note },
    ),
  jobs: (scope: "active" | "all" = "active") =>
    call<{ jobs: CreatorJob[]; scope: string; order: string }>(`/api/creator/jobs?scope=${scope}`),
  job: (id: string) => call<{ job: CreatorJob }>(`/api/creator/jobs/${id}`),
  accept: (id: string) => post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/accept`),
  productReceived: (id: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/product-received`),
  pass: (id: string, reason: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/pass`, { reason }),
  askZaviForHelp: (id: string, reason: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/dispute`, { reason }),
  answerCancellation: (id: string, answer: "agree" | "decline" | "dispute", reason?: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/cancellation`, reason ? { answer, reason } : { answer }),
  requestExtension: (id: string, requested_due_at: string, note: string) =>
    post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/extension`, {
      requested_due_at,
      note,
    }),
  sendMessage: (id: string, body: string) =>
    post<{ message: { id: string; sender_kind: string; body: string; created_at: string } }>(
      `/api/creator/jobs/${id}/messages`,
      { body },
    ),
  uploadUrl: (id: string, content_type: string) =>
    post<{ bucket: string; path: string; token: string; signed_url: string }>(
      `/api/creator/jobs/${id}/upload-url`,
      { content_type },
    ),
  submit: (
    id: string,
    files: { kind: string; storage_path: string; mime_type: string; bytes: number }[],
    note: string,
  ) => post<{ ok: true; job: CreatorJob | null }>(`/api/creator/jobs/${id}/submissions`, { files, note }),
  earnings: () => call<CreatorEarnings>("/api/creator/earnings"),
  reviews: () => call<CreatorReviews>("/api/creator/reviews"),
  affiliate: () => call<CreatorAffiliate>("/api/creator/affiliate"),
  payoutRefresh: () =>
    post<{ payout: { transfers_active: boolean; payouts_enabled: boolean; details_submitted: boolean; disabled_reason?: string | null; action_required?: boolean }; released_payouts: number }>(
      "/api/creator/payouts/refresh",
    ),
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
    call<{ package: CreatorPackage }>(`/api/creator/storefront/packages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: abs % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
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

export function landingFor(home: "/workspace" | "/creator" | "/start", next: string | null): string {
  if (home !== "/creator") return home;
  const plain = plainNext(next);
  return isCreatorPath(plain) ? (plain as string) : "/creator";
}
