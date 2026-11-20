import type { ChannelMetric } from "./channelPage";

import type { ChannelSettingField } from "./channelSettings";

export const UGC_SLUG = "ugc";

export type CreatorSocial = { platform: string; handle: string; url: string | null; followers: number | null; label: string };

export type CreatorPackage = {
  id: string;
  kind: "ugc_video";
  title: string;
  price_cents: number;
  business_total_cents: number;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  description?: string | null;
};

export type CreatorCard = {
  human_member_id: string;
  display_name: string;
  city: string | null;
  country_code: string | null;
  bio: string | null;
  lanes?: string[];
  niches: string[];
  has_intro_video?: boolean;
  photo_url?: string | null;
  illustration_url?: string | null;
  bookable: boolean;
  socials: CreatorSocial[];
  packages: CreatorPackage[];
  rating: { average: number | null; count: number };
  invited?: boolean;
  status_label?: string;
};

export type CreatorSearchRow = {
  human_member_id: string;
  display_name: string;
  lanes: string[];
  niches: string[];
  platforms: string[];
  location: { city: string | null; country_code: string | null };
  bookable: boolean;
  not_bookable_message: string | null;
  handles?: CreatorSocial[];
  packages?: Array<{ id?: string; title?: string | null }>;
  from_price_cents?: number | null;
  from_price_business_total_cents: number | null;
  invited?: boolean;
  status_label?: string;
};

export type FilterOption<T extends string | number = string> = { value: T; label: string };

export type CreatorFilterOptions = {
  platforms: FilterOption[];
  niches: FilterOption[];
  lanes: FilterOption[];
  max_price_cents: FilterOption<number>[];
  max_delivery_days: FilterOption<number>[];
  min_followers: FilterOption<number>[];
  countries: FilterOption[];
};

export type CreatorFilterLabels = {
  platforms: { name: string; any: string };
  keyword: { name: string; placeholder: string };
  niches: { name: string };
  lanes: { name: string; any: string };
  max_price_cents: { name: string; any: string };
  max_delivery_days: { name: string; any: string };
  min_followers: { name: string; any: string; note?: string };
  countries: { name: string; any: string };
  order: { name: string };
};

export type CreatorSearchResponse = {
  creators: CreatorSearchRow[];
  invited?: CreatorSearchRow[];
  neutrality_note?: string;
  order_label?: string;
  order_options?: FilterOption[];
  filter_options?: CreatorFilterOptions;
  filter_labels?: CreatorFilterLabels;
  results_notes?: { summary: string; fee: string };
  self_reported_note?: string;
  page: { limit: number; offset: number; has_more: boolean };
};

export type ThreadSummary = {
  thread_id: string;
  human_member_id: string;
  display_name: string;
  last_message: { body: string; sender_kind: string; created_at: string } | null;
  last_message_at: string | null;
  unread_count?: number;
};

export type ThreadMessage = { id: string; sender_kind: string; body: string; created_at: string };

export type ThreadOffer = {
  id: string;
  proposed_by: "tenant" | "creator";
  kind?: string;
  terms?: Record<string, unknown> | null;
  price_cents: number;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  fees: { business_total_cents: number };
  expired: boolean;
  awaiting_payment?: boolean;
  closed_unpaid?: boolean;
};

export type Deadline = {
  line: string;
  kind?: string;
  deadline_at?: string;
  deadline_text?: string;
  consequence_text?: string;
};

export type JobMoney = {
  currency: string;
  business_total_cents: number;
  business_fee_label: string;
  price_cents?: number;
  business_fee_cents?: number;
  creator_payout_cents?: number;
  payout_status?: string;
};

export type JobSummary = {
  id: string;
  source?: "booking" | "offer" | "applicant";
  status: string;
  closed_reason: string | null;
  title: string;
  creator_display_name: string | null;
  creator_slug?: string | null;
  human_member_id?: string;
  brief_id?: string | null;
  created_at: string;
  due_at: string | null;
  closed_at?: string | null;
  money: JobMoney;
  deadline: Deadline | null;
  due_after_accept?: string | null;
  awaiting_creator: boolean;
  extension_state?: "requested" | "approved" | "declined" | null;
  extension_requested_due_at?: string | null;
  product_needed?: boolean;
  product_received_at?: string | null;
  offer_id?: string | null;
  revisions_used?: number;
  refunded_cents?: number | null;
  offer_expired?: boolean;
};

export type BusinessAction =
  | "approve"
  | "request_change"
  | "request_cancellation"
  | "revoke_cancellation"
  | "withdraw"
  | "approve_extension"
  | "decline_extension"
  | "ask_zavi"
  | "ask_zavi_in_buffer";

export type JobAction = { action: BusinessAction | string; label: string; consequence: string; wants_note?: boolean };

export type Submission = {
  id: string;
  version: number;
  position?: number;
  kind: "video" | "image" | "raw_footage" | "other" | string;
  mime_type?: string | null;
  bytes?: number | null;
  note: string | null;
  created_at?: string;
  play_url: string | null;
  watermarked?: boolean;
  preview?: "ready" | "preparing" | "failed" | "unavailable" | null;
  download_url?: string | null;
};

export type JobReceipt = {
  currency?: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  refunded_cents: number;
  paid_at: string;
  receipt_url: string | null;
  chargeback_status?: "open" | "won" | "lost" | null;
};

export function previewNote(s: { watermarked?: boolean; preview?: "ready" | "preparing" | "failed" | "unavailable" | null; download_url?: string | null }): string | null {
  if (s.download_url) return null;
  if (s.watermarked) return "Watermarked preview. The original unlocks to download and post once you approve and pay.";
  if (s.preview === "unavailable") return "Zavi could not make a watermarked preview of this file. Ask the creator to send it again, or ask Zavi to step in. The original unlocks once you approve and pay.";
  if (s.preview === "preparing" || s.preview === "failed") return "Zavi is putting a watermark on this file. Check back in a few minutes. The original unlocks once you approve and pay.";
  return null;
}

export type JobDetail = {
  job: JobSummary;
  package_snapshot?: Record<string, unknown> | null;
  brief_snapshot?: Record<string, unknown> | null;
  submissions: Submission[];
  actions: JobAction[];
  rebook?: { package_id: string; title: string; price_cents: number; currency: string } | null;
  revisions?: { used: number; left: number; max: number };
  extension?: { state: string | null; requested_due_at: string | null } | null;
  dispute: {
    status: "open" | "resolved";
    reason: string;
    opened_by?: "tenant" | "creator";
    outcome?: "pay_full" | "pay_part" | "refund" | null;
    resolution_note?: string | null;
    created_at?: string;
  } | null;
  thread?: { available: boolean; thread_id: string | null; messages: ThreadMessage[] };
  change_requests?: Array<{ round: number; note: string | null; created_at: string }>;
  receipt?: JobReceipt | null;
};

export type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  read_at: string | null;
  created_at: string;
};

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const rest = abs % 100;
  return `${sign}$${grouped(Math.trunc(abs / 100))}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

export function formatCents(cents: number | null | undefined, currency = "usd"): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const unit = currency.toLowerCase() === "usd" ? "$" : `${currency.toUpperCase()} `;
  return `${sign}${unit}${grouped(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

export function messageStamp(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (!sameDay) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function longDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function locationLine(loc: { city: string | null; country_code: string | null }): string | null {
  const parts = [loc.city, loc.country_code].filter((p): p is string => !!p && p.trim() !== "");
  return parts.length ? parts.join(", ") : null;
}

export function nicheLabel(n: string): string {
  const s = n.replace(/[_-]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function packageFacts(p: CreatorPackage): string {
  const parts: string[] = [];
  if (p.video_count) parts.push(`${p.video_count} video${p.video_count === 1 ? "" : "s"}`);
  if (p.video_length_seconds) parts.push(`${p.video_length_seconds}s`);
  parts.push(`${p.delivery_days} day${p.delivery_days === 1 ? "" : "s"}`);
  if (p.ad_rights_days) parts.push(`${p.ad_rights_days}-day ad rights`);
  return parts.join(" · ");
}

const STATUS_LABEL: Record<string, string> = {
  checkout_pending: "Payment not finished",
  awaiting_acceptance: "Waiting for the creator",
  in_progress: "In progress",
  submitted: "Ready for your review",
  revision_requested: "Changes requested",
  cancel_requested: "Cancellation requested",
  in_dispute: "Zavi is stepping in",
  completed: "Done",
  cancelled: "Cancelled",
};

export function jobStatusLabel(j: Pick<JobSummary, "status" | "closed_reason">): string {
  if (j.status === "cancelled" && j.closed_reason === "checkout_abandoned") return "Not paid";
  return STATUS_LABEL[j.status] ?? j.status.replace(/_/g, " ");
}

export function jobIsDone(j: Pick<JobSummary, "status">): boolean {
  return j.status === "completed" || j.status === "cancelled";
}

export function jobNeedsYou(j: JobSummary): boolean {
  return j.status === "submitted" || (j.status !== "cancelled" && j.extension_state === "requested");
}

export function isNeverPaid(j: Pick<JobSummary, "status" | "closed_reason">): boolean {
  return j.status === "checkout_pending" || (j.status === "cancelled" && j.closed_reason === "checkout_abandoned");
}

export type Order = "newest" | "a_to_z";

export type FindFilters = {
  platform: string;
  keyword: string;
  niches: string[];
  lane: string;
  maxPriceCents: number | null;
  maxDeliveryDays: number | null;
  minFollowers: number | null;
  country: string;
  order: Order | string;
};

export const NO_FILTERS: FindFilters = {
  platform: "",
  keyword: "",
  niches: [],
  lane: "",
  maxPriceCents: null,
  maxDeliveryDays: null,
  minFollowers: null,
  country: "",
  order: "newest",
};

export function searchPath(f: Partial<FindFilters> & { order: string }): string {
  const q = new URLSearchParams({ order: f.order, limit: "100" });
  if (f.platform) q.set("platform", f.platform);
  if (f.niches?.length) q.set("niches", f.niches.join(","));
  if (f.lane) q.set("lane", f.lane);
  if (f.maxPriceCents) q.set("max_price_cents", String(f.maxPriceCents));
  if (f.maxDeliveryDays) q.set("max_delivery_days", String(f.maxDeliveryDays));
  if (f.country) q.set("country_code", f.country);
  return `/api/humans/creators/search?${q.toString()}`;
}

export function matchesKeyword(c: CreatorSearchRow, keyword: string): boolean {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    c.display_name,
    ...c.niches,
    ...c.platforms,
    ...(c.handles ?? []).map((h) => h.handle),
    ...(c.packages ?? []).map((p) => p.title ?? ""),
    c.location.city ?? "",
    c.location.country_code ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function matchesLocally(c: CreatorSearchRow, f: Pick<FindFilters, "keyword" | "minFollowers">): boolean {
  if (f.minFollowers) {
    const most = Math.max(0, ...(c.handles ?? []).map((h) => h.followers ?? 0));
    if (most < f.minFollowers) return false;
  }
  return matchesKeyword(c, f.keyword);
}

export function activeCount(f: FindFilters): number {
  return (
    (f.platform ? 1 : 0) +
    (f.keyword.trim() ? 1 : 0) +
    f.niches.length +
    (f.lane ? 1 : 0) +
    (f.maxPriceCents ? 1 : 0) +
    (f.maxDeliveryDays ? 1 : 0) +
    (f.minFollowers ? 1 : 0) +
    (f.country ? 1 : 0)
  );
}

export function pillLabel<T extends string | number>(list: readonly FilterOption<T>[], value: T | null | "", name: string): string {
  if (value === null || value === "") return name;
  return list.find((o) => o.value === value)?.label ?? name;
}

export function resultsLine(shown: number, orderLabel: string | undefined, summary: string | undefined): string {
  return [`${shown} ${shown === 1 ? "creator" : "creators"}`, orderLabel, summary].filter(Boolean).join(" · ");
}

export function resultsParts(shown: number, orderLabel: string | undefined): { count: string; order: string | null } {
  return { count: `${shown} ${shown === 1 ? "creator" : "creators"}`, order: orderLabel ?? null };
}

export function nicheChips(niches: readonly string[], max = 3): { shown: string[]; more: number } {
  return { shown: niches.slice(0, max), more: Math.max(0, niches.length - max) };
}

export function noticeTarget(link: string | null): { pathname: string; params: Record<string, string> } | null {
  if (!link) return null;
  const q = link.includes("?") ? new URLSearchParams(link.slice(link.indexOf("?") + 1)) : new URLSearchParams();
  const drawer = q.get("drawer");
  const job = q.get("job");
  const creator = q.get("creator");
  const brief = q.get("brief");
  if ((drawer === "job" || drawer === "review") && job) return { pathname: "/channels/ugc/job/[id]", params: { id: job } };
  if (drawer === "thread" && creator) return { pathname: "/channels/ugc/thread/[id]", params: { id: creator } };
  if (drawer === "inbox") return { pathname: "/channels/ugc/inbox", params: {} };
  if (drawer === "applicants" && brief) return { pathname: "/channels/ugc/applicants/[id]", params: { id: brief } };
  if (drawer === "brief") return { pathname: "/channels/ugc/brief/[id]", params: { id: brief ?? "new" } };
  if (drawer === "find") return { pathname: "/channels/ugc/find", params: {} };
  if (drawer === "hire") {
    const offer = q.get("offer");
    const pkg = q.get("package");
    const application = q.get("application");
    if (offer) return { pathname: "/channels/ugc/hire", params: { offer } };
    if (pkg) return { pathname: "/channels/ugc/hire", params: { package: pkg } };
    if (application && brief) return { pathname: "/channels/ugc/hire", params: { application, brief } };
  }
  return null;
}

export type Brief = {
  id: string;
  title: string;
  status: string;
  application_count: number | null;
  created_at?: string;
  posted_at?: string | null;
  answer_by?: string | null;
  closed_at?: string | null;
  utm_campaign?: string | null;
  lane?: string | null;
  deliverables?: number | null;
  budget_usd?: number | null;
  delivery_days?: number | null;
  applicant_cap?: number | null;
  ad_rights_days?: number | null;
  source_channel?: string | null;
};

export function shortDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const briefIsOpen = (b: Brief) => !b.closed_at && b.status !== "filled" && b.status !== "cancelled";

const HIRED = new Set(["in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute", "completed"]);

export function latestVideoCount(submissions: ReadonlyArray<{ kind: string; version: number }>): number {
  const videos = submissions.filter((s) => s.kind === "video");
  const top = videos.reduce((m, s) => Math.max(m, s.version), 0);
  return videos.filter((s) => s.version === top).length;
}

export function deliveryOrderIds(jobs: readonly JobSummary[], library: ReadonlyArray<{ order_id?: string }>): string[] {
  return [...new Set<string>([...jobs.filter((j) => j.status === "submitted").map((j) => j.id), ...library.map((a) => a.order_id).filter((x): x is string => !!x)])];
}

export function videosDelivered(
  jobs: readonly JobSummary[],
  library: ReadonlyArray<{ id: string; order_id?: string }>,
  counts: Readonly<Record<string, number>>,
): number | null {
  const delivered = new Set<string>([...library.map((a) => a.order_id ?? `asset:${a.id}`), ...jobs.filter((j) => j.status === "submitted").map((j) => j.id)]);
  let videos = 0;
  for (const id of delivered) {
    const n = counts[id];
    if (!n) return null;
    videos += n;
  }
  return videos;
}

export function hubNumbers(briefs: Brief[], jobs: JobSummary[], videos: number | null): ChannelMetric[] {
  const hired = jobs.filter((j) => HIRED.has(j.status));
  let spent: number | null = 0;
  for (const j of hired) {
    const refunded = j.closed_reason === "mediation_pay_part" ? j.refunded_cents : 0;
    if (typeof refunded !== "number") {
      spent = null;
      break;
    }
    spent += j.money.business_total_cents - refunded;
  }
  const metric = (key: string, value: number | null, unit: string | null, why: string): ChannelMetric => ({
    key,
    value: value ?? Number.NaN,
    unit,
    grounded: true,
    prev_value: null,
    day: "",
    ...(value === null ? { unmeasured: why } : {}),
  });
  return [
    metric("briefs_out", briefs.filter((b) => b.posted_at && briefIsOpen(b)).length, null, ""),
    metric("creators_hired", new Set(hired.map((j) => j.human_member_id ?? j.id)).size, null, ""),
    metric("videos_delivered", videos, null, "Could not read every delivery just now."),
    metric("spent", spent === null ? null : spent / 100, "usd", "Could not read a refund just now."),
  ];
}

export type LaneRow = {
  id: string;
  kind: "Brief" | "Job";
  title: string;
  status: string;
  tone: "open" | "action" | "quiet";
  line: string;
  done: boolean;
  jobId: string | null;
  briefId: string | null;
};

const CLOSED_WORD: Record<string, string> = {
  approved: "Approved",
  auto_accepted: "Accepted automatically",
  mediation_pay_full: "Zavi decided",
  mediation_pay_part: "Zavi decided",
  mediation_refund: "Zavi decided: refund",
  declined: "Declined",
  expired: "No answer",
  withdrawn: "You cancelled",
  no_show: "Not delivered, refunded",
  cancel_agreed: "Cancelled, refunded",
  cancel_no_response: "Cancelled, refunded",
  payment_failed: "Payment failed",
  creator_removed: "Creator removed",
};

const DEADLINE_WORD: Record<string, string> = {
  review: "Review by",
  accept: "Answer by",
  due: "Due",
  no_show_grace: "Last day",
  cancel_response: "Answer by",
  offer_expiry: "Answer by",
};

export function briefRow(b: Brief): LaneRow | null {
  if (!b.posted_at) return null;
  const n = b.application_count ?? 0;
  const base = { id: `brief-${b.id}`, kind: "Brief" as const, title: b.title || "Untitled brief", jobId: null, briefId: b.id };
  if (!briefIsOpen(b)) {
    const closed = shortDay(b.closed_at);
    return { ...base, status: b.status === "filled" ? "Hired" : "Closed", tone: "quiet", line: `${n} applied${closed ? ` · closed ${closed}` : ""}`, done: true };
  }
  const by = shortDay(b.answer_by);
  return { ...base, status: "Open", tone: "open", line: `${n} applied${by ? ` · answer by ${by}` : ""}`, done: false };
}

export function jobRow(j: JobSummary): LaneRow | null {
  if (isNeverPaid(j)) return null;
  const who = j.creator_display_name || "Creator";
  const n = firstName(who);
  const dl = j.deadline;
  const at = dl && dl.deadline_at ? (dl.kind === "due" ? shortDay(dl.deadline_at) : dayTimeUtc(dl.deadline_at)) : "";
  const when = at ? `${DEADLINE_WORD[dl?.kind ?? ""] ?? "By"} ${at}` : "";
  const changes = typeof j.revisions_used === "number" ? `${j.revisions_used} of 2 changes used` : "";
  const base = { id: `job-${j.id}`, kind: "Job" as const, title: `${who}: ${j.title}`, jobId: j.id, briefId: null };
  switch (j.status) {
    case "completed":
    case "cancelled": {
      const closed = shortDay(j.closed_at);
      return { ...base, status: CLOSED_WORD[j.closed_reason ?? ""] ?? (j.status === "completed" ? "Done" : "Cancelled"), tone: "quiet", line: closed ? `Closed ${closed}` : "", done: true };
    }
    case "awaiting_acceptance":
      return { ...base, status: `Waiting for ${n}`, tone: "action", line: when, done: false };
    case "in_progress":
      if (j.product_needed && !j.product_received_at) {
        return { ...base, status: "Waiting for your product", tone: "action", line: `Send ${n} the product. The due date starts when ${n} marks it received.`, done: false };
      }
      return { ...base, status: "In progress", tone: "open", line: when, done: false };
    case "submitted":
      return { ...base, status: "Delivered, review it", tone: "action", line: [when, changes].filter(Boolean).join(" · "), done: false };
    case "revision_requested":
      return { ...base, status: "Changes requested", tone: "open", line: when, done: false };
    case "cancel_requested":
      return { ...base, status: "You asked to cancel", tone: "quiet", line: when, done: false };
    case "in_dispute":
      return { ...base, status: "Zavi is stepping in", tone: "quiet", line: "Zavi staff are looking at this job.", done: false };
    default:
      return { ...base, status: j.status, tone: "quiet", line: when, done: false };
  }
}

export function laneRows(briefs: Brief[], jobs: JobSummary[]): LaneRow[] {
  const all = [
    ...briefs.map(briefRow).filter((r): r is LaneRow => r !== null),
    ...jobs.map((j) => jobRow(j as never)).filter((r): r is LaneRow => r !== null),
  ];
  const rank = (r: LaneRow) => (!r.done ? 0 : r.kind === "Job" ? 1 : 2);
  return [0, 1, 2].flatMap((k) => all.filter((r) => rank(r) === k));
}

export type HireCard = { id: string; kind: string; title: string; lead: string; button: string; to: "web" | "find" | "job" | "brief" | "applicants"; jobId?: string; briefId?: string; dismiss?: "Reject" | "Not now" };

export function hireCards(briefs: Brief[], jobs: JobSummary[], bookable: number): HireCard[] {
  const cards: HireCard[] = [];
  const draft = briefs.find((b) => !b.posted_at && b.status !== "cancelled");
  if (draft) {
    cards.push({ id: `draft-${draft.id}`, kind: "Brief", title: `Post this brief to Zavi creators: ${draft.title || "Untitled brief"}`, lead: "Zavi wrote the brief. Review it and post it so creators can apply.", button: "Review and post", to: "brief", briefId: draft.id, dismiss: "Reject" });
  }
  for (const b of briefs) {
    const n = b.application_count ?? 0;
    if (b.posted_at && briefIsOpen(b) && n > 0) {
      cards.push({ id: `applied-${b.id}`, kind: "Applicants", title: `${n} ${n === 1 ? "creator" : "creators"} applied to ${b.title || "your brief"}: pick one`, lead: "Compare them and hire one.", button: "See all applicants", to: "applicants", briefId: b.id });
    }
  }
  if (bookable > 0) {
    cards.push({ id: "book", kind: "Book", title: "Or book a creator directly", lead: `${bookable} ${bookable === 1 ? "creator is" : "creators are"} ready to book.`, button: "Find creators", to: "find" });
  }
  for (const j of jobs) {
    if (!isNeverPaid(j) && (j.status === "awaiting_acceptance" || j.status === "in_progress" || j.status === "revision_requested")) {
      cards.push({ id: `waiting-${j.id}`, kind: "Waiting", title: `Waiting on ${j.creator_display_name || "the creator"}: ${j.title}`, lead: j.deadline?.line ?? "", button: "Open job", to: "job", jobId: j.id });
    }
  }
  return cards;
}

export type LibraryAsset = {
  id: string;
  order_id?: string;
  submission_id?: string;
  human_member_id?: string;
  created_at?: string;
  rights_start_at: string;
  rights_end_at: string;
  rights_expired: boolean;
  tracking_tag?: string;
  two_clocks_warning?: string | null;
  video?: { kind?: string; storage_path?: string; mime_type: string | null; bytes: number | null } | null;
  meta: { ad_id: string | null; ad_account_id?: string | null; video_id?: string | null; ad_set_id?: string | null; auto_paused_at?: string | null } | null;
  ad_performance?: {
    enough_evidence: boolean;
    conversions: number | null;
    needed_conversions: number;
    progress_label: string | null;
    read_at: string | null;
    scope_note: string | null;
    numbers: {
      spend_usd: number | null;
      impressions: number | null;
      clicks: number | null;
      reach: number | null;
      conversions: number | null;
      purchases: number | null;
      purchase_value_usd: number | null;
    } | null;
  } | null;
  youtube: { video_id: string } | null;
  creator_display_name?: string | null;
  source_channel?: string | null;
};

export type VideoSpec = { name: string; placement: string; use: "ad" | "post"; push: "meta" | "youtube" | null };

const DAY_MS = 86_400_000;
export const READY_CARD_DAYS = 30;

export function assetIsReady(a: LibraryAsset, now: Date): boolean {
  if (a.rights_expired || a.meta?.ad_id) return false;
  const since = Date.parse(a.created_at ?? a.rights_start_at);
  return Number.isFinite(since) && now.getTime() - since <= READY_CARD_DAYS * DAY_MS;
}

function rightsLine(a: LibraryAsset): string {
  const d = Math.round((Date.parse(a.rights_end_at) - Date.parse(a.rights_start_at)) / DAY_MS);
  const base = Number.isFinite(d) && d > 0 ? `${d} days` : `until ${shortDay(a.rights_end_at)}`;
  return a.creator_display_name ? `${base}, from ${a.creator_display_name}` : base;
}

export type VideoCard = { id: string; assetId: string; kind: string; title: string; lead: string; rights: string; webOnly: boolean };

export function videoCard(a: LibraryAsset, spec: VideoSpec | null): VideoCard {
  const full = a.creator_display_name || "Your creator";
  const name = firstName(full);
  if (!spec) {
    return {
      id: `ugc-use-${a.id}`,
      assetId: a.id,
      kind: "To do",
      title: `Use ${name}'s video in your ads`,
      lead: "You approved the video. Download it and run it where it fits.",
      rights: rightsLine(a),
      webOnly: false,
    };
  }
  const lead =
    spec.push === "meta"
      ? `You approved ${full}'s video in UGC. Use in Meta Ads opens the ad form: pick the ad set and Zavi creates the ad in Meta, paused until you turn it on.`
      : spec.push === "youtube"
        ? `You approved ${full}'s video in UGC. Upload it to your YouTube, paste the link, and Zavi proposes the video ad for you to approve.`
        : spec.use === "ad"
          ? `You approved ${full}'s video in UGC. Download it and upload it as a new ad in ${spec.placement}.`
          : `You approved ${full}'s video in UGC. Download it and post it on ${spec.placement.replace(/^Your /, "your ")}.`;
  return {
    id: `${spec.name}-ready-${a.id}`,
    assetId: a.id,
    kind: spec.use === "ad" ? "Ad" : "Post",
    title: `${name}'s video is ready: ${spec.use === "ad" ? "run it as an ad" : "post it"}`,
    lead,
    rights: rightsLine(a),
    webOnly: spec.push !== null,
  };
}

export function readyVideoCards(library: LibraryAsset[], slug: string, spec: VideoSpec | null, now: Date = new Date()): VideoCard[] {
  return library
    .filter((a) => assetIsReady(a, now) && (slug === UGC_SLUG || a.source_channel === slug))
    .map((a) => videoCard(a, slug === UGC_SLUG ? null : spec));
}

export const UGC_SETTINGS: ChannelSettingField[] = [
  {
    kind: "choice",
    id: "run_surface",
    label: "Where the asset will run",
    help: "This decides which rights the creator has to grant, so it has to be settled before anyone films.",
    options: [
      { value: "own_ad_account", label: "Our own ad account" },
      { value: "own_organic", label: "Our own organic accounts and site" },
    ],
  },
  {
    kind: "list",
    id: "claims_off_limits",
    label: "Things a creator must never say",
    help: "Add them one at a time, in plain words. These go into the brief the creator shoots from.",
  },
];
