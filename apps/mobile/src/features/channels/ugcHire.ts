import { relativeTime } from "./channelPage";
import { followersNote, laneWords, platformName, ratingLine, termsLine } from "./creatorProfile";
import { briefRow, dayTimeUtc, firstName, money, shortDay, type Brief, type CreatorCard, type CreatorPackage } from "./ugc";
import { offerDue, offerHint, offerWhat } from "./ugcOffers";

const enc = encodeURIComponent;

export type CreatorFees = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_fee_cents?: number;
  creator_payout_cents?: number;
  zavi_gross_cents?: number;
  currency?: string;
};

export type VisibleBrief = {
  id: string;
  business_name?: string;
  title: string;
  angle?: string;
  hook?: string;
  format?: string;
  deliverables?: number | null;
  lane?: string | null;
  delivery_days?: number | null;
  posted_at: string | null;
  answer_by: string | null;
  applicant_cap?: number | null;
  applicant_count?: number;
  spots_left?: number | null;
  open: boolean;
  closed_reason: "cap_reached" | "answer_by_passed" | "filled" | null;
};

export type ApplicantView = {
  application_id: string;
  human_member_id: string;
  display_name: string;
  slug?: string | null;
  city: string | null;
  country_code: string | null;
  bookable: boolean;
  status: "applied" | "shortlisted" | "approved" | "rejected" | "withdrawn" | string;
  note: string;
  applied_at?: string;
  quoted_rate_usd?: number | null;
  fees: CreatorFees | null;
  hire_state?: "hired" | "cancelled" | "unpaid" | null;
};

export type BriefApplicantsResponse = {
  applicants: ApplicantView[];
  order: string;
  brief: VisibleBrief;
  applicant_count: number;
  spots_line: string;
  answer_by_line: string;
  decline_note: string;
  decline_note_is_default?: boolean;
};

export type BookingQuote = {
  source: "booking" | "offer" | "applicant";
  creator: { human_member_id: string; display_name: string; slug?: string | null; city: string | null; country_code: string | null; payout_supported?: boolean };
  job: { title: string; kind: "ugc_video"; delivery_days: number | null; package_id: string | null; offer_id: string | null; application_id: string | null; brief_id: string | null };
  brief_prefill?: { angle?: string | null } | null;
  money: { currency: string; price_cents: number; business_fee_cents: number; business_total_cents: number; business_fee_label?: string };
  due_at: string | null;
  due_after_accept: string | null;
  product_needed: boolean;
  needs_large_amount_confirm: boolean;
  large_amount_confirm_cents: number;
  blocked: { code: string; message: string } | null;
};

export type OfferView = {
  id: string;
  human_member_id: string;
  thread_id?: string | null;
  proposed_by: "tenant" | "creator";
  kind?: string;
  terms?: Record<string, unknown> | null;
  price_cents: number;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  created_at: string;
  product_needed?: boolean;
  fees: { price_cents: number; business_fee_cents: number; business_total_cents: number };
  expired: boolean;
  awaiting_payment?: boolean;
  closed_unpaid?: boolean;
};

export type HireBriefFacts = {
  deliverables: number | null;
  lane: string | null;
  format: string | null;
  delivery_days: number | null;
  product_needed?: boolean;
};

type Route = { pathname: string; params: Record<string, string> };

export const BRIEFS_EMPTY_TITLE = "No briefs yet";
export const BRIEFS_EMPTY_BODY =
  "Briefs are written by your growth agent when it finds a creative problem worth solving: fatigued ads, a missing angle, an objection nobody is answering. Ask the performance marketer to look at your ads and one will land here.";

const isOpen = (b: Pick<Brief, "closed_at" | "status">) => !b.closed_at && b.status !== "filled" && b.status !== "cancelled";

export function briefChip(b: Brief): { label: string; tone: "alert" | "soft" } {
  if (b.status === "cancelled") return { label: "Cancelled", tone: "soft" };
  if (!b.posted_at) return { label: "Draft", tone: "soft" };
  if (b.status === "filled") return { label: "Hired", tone: "soft" };
  if (!isOpen(b)) return { label: "Closed", tone: "soft" };
  return { label: "Open", tone: "alert" };
}

export type BriefListRow = { id: string; title: string; sub: string; line: string; chip: { label: string; tone: "alert" | "soft" }; to: Route };

export function briefListRow(b: Brief, now: number = Date.now()): BriefListRow {
  const written = relativeTime(b.created_at ?? null, now);
  const sub = [written ? `Written ${written}` : "", b.utm_campaign ?? ""].filter(Boolean).join(" · ");
  const lane = b.posted_at ? briefRow(b) : null;
  return {
    id: b.id,
    title: b.title || "Untitled brief",
    sub,
    line: lane ? lane.line : "Not posted yet",
    chip: briefChip(b),
    to: b.posted_at ? { pathname: "/channels/ugc/applicants/[id]", params: { id: b.id } } : { pathname: "/channels/ugc/brief/[id]", params: { id: b.id } },
  };
}

export const NEW_BRIEF_ROUTE: Route = { pathname: "/channels/ugc/brief/[id]", params: { id: "new" } };

const HIREABLE = new Set(["applied", "shortlisted"]);

export const applicantsPath = (briefId: string) => `/api/humans/briefs/${enc(briefId)}/applicants`;
export const closeBriefPath = (briefId: string) => `/api/humans/briefs/${enc(briefId)}/close`;

export const APPLICANTS_EMPTY = "No applications yet. Creators who fit the brief get an email, and applications show up here.";

export function closedReasonLine(brief: Pick<VisibleBrief, "open" | "posted_at" | "closed_reason">): string | null {
  if (brief.open) return null;
  if (!brief.posted_at) return "This brief has not been posted yet, so no creator can see it.";
  switch (brief.closed_reason) {
    case "cap_reached":
      return "Closed to new applications: the application limit was reached.";
    case "answer_by_passed":
      return "Closed: the answer-by date passed and everyone who applied has been told.";
    case "filled":
      return "Closed: you hired someone and everyone else has been told.";
    default:
      return "Closed to new applications.";
  }
}

export function applicantOutcome(a: Pick<ApplicantView, "status" | "hire_state">): string {
  if (a.status !== "approved") return "Not hired";
  if (a.hire_state === "cancelled") return "Hired, then cancelled";
  if (a.hire_state === "unpaid") return "Hire not paid, nothing charged";
  return "Hired";
}

export function applicantsLead(d: Pick<BriefApplicantsResponse, "applicants" | "brief" | "decline_note">): string {
  const n = d.applicants.length;
  const by = shortDay(d.brief.answer_by);
  return (
    `${n} ${n === 1 ? "creator" : "creators"} applied.` +
    (by ? ` Answer everyone by ${by}.` : "") +
    ` The brief closes only after your hire payment goes through; then everyone else gets your note: “${d.decline_note}”`
  );
}

export function applicantsStatus(d: BriefApplicantsResponse): { chip: string; open: boolean; spots: string; answerBy: string; closed: string | null; order: string } {
  return {
    chip: d.brief.open ? "Open for applications" : "Closed to new applications",
    open: d.brief.open,
    spots: d.spots_line,
    answerBy: d.answer_by_line,
    closed: closedReasonLine(d.brief),
    order: d.order,
  };
}

export type ApplicantCardView = {
  key: string;
  name: string;
  first: string;
  location: string;
  price: string | null;
  youPay: string | null;
  note: string;
  outcome: string | null;
  notBookable: string | null;
  hire: { label: string; to: Route } | null;
  finishPaying: { label: string; to: Route } | null;
  message: { label: string; to: Route };
};

export function applicantCard(a: ApplicantView, briefId: string, briefOpen: boolean, canWrite: boolean, pendingOrderId: string | null): ApplicantCardView {
  const first = firstName(a.display_name || "Creator");
  const hireable = HIREABLE.has(a.status) && a.bookable && a.fees !== null && briefOpen && canWrite;
  const unpaid = a.status === "approved" && a.hire_state === "unpaid";
  return {
    key: a.application_id,
    name: a.display_name || "A Zavi creator",
    first,
    location: [a.city, a.country_code].filter(Boolean).join(", "),
    price: a.fees ? money(a.fees.price_cents) : null,
    youPay: a.fees ? `You pay ${money(a.fees.business_total_cents)}` : null,
    note: a.note ? `“${a.note}”` : "They did not leave a note.",
    outcome: HIREABLE.has(a.status) ? null : applicantOutcome(a),
    notBookable: a.bookable ? null : "Zavi cannot pay creators in this creator's country yet, so they cannot be hired.",
    hire:
      hireable && a.fees
        ? { label: `Hire and pay ${money(a.fees.business_total_cents)}`, to: { pathname: "/channels/ugc/hire", params: { application: a.application_id, brief: briefId } } }
        : null,
    finishPaying: unpaid && pendingOrderId && canWrite ? { label: "Finish paying", to: { pathname: "/channels/ugc/job/[id]", params: { id: pendingOrderId } } } : null,
    message: { label: `Message ${first}`, to: { pathname: "/channels/ugc/thread/[id]", params: { id: a.human_member_id } } },
  };
}

export function applicationAnswered(a: Pick<ApplicantView, "status" | "hire_state">): string | null {
  return HIREABLE.has(a.status) ? null : `${applicantOutcome(a)}.`;
}

export function canAnswerEveryone(d: Pick<BriefApplicantsResponse, "applicants" | "brief">, canWrite: boolean): boolean {
  return canWrite && d.brief.open && d.applicants.some((a) => a.status === "applied");
}

export function answerEveryoneCopy(answerBy: string | null): { lead: string; body: string } {
  const by = shortDay(answerBy);
  return {
    lead: `Not hiring anybody from this brief? You can answer everyone now instead of waiting${by ? ` for ${by}` : ""}.`,
    body: "Your note goes to everyone still waiting and the brief closes. Notes cannot be taken back.",
  };
}

export const CLOSE_DIALOG = {
  title: "Answer everyone and close?",
  message: "Your note goes to everyone still waiting and the brief closes. Notes cannot be taken back.",
  confirmLabel: "Answer everyone",
  cancelLabel: "Not now",
};

export const closedMessage = (r: { undo_message?: string | null } | null | undefined) => r?.undo_message || "The brief is closed.";

const grouped = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export { termsLine };

export type CreatorSummaryView = {
  rating: string;
  reviewed: boolean;
  lanes: string;
  socials: Array<{ key: string; handle: string; followers: string | null; url: string | null; platform: string; viewLabel: string }>;
  followersNote: string | null;
  packages: Array<{ id: string; head: string; terms: string }>;
};

export function creatorSummary(c: CreatorCard): CreatorSummaryView {
  const rating = ratingLine(c.rating);
  return {
    rating: rating.text,
    reviewed: rating.reviewed,
    lanes: laneWords(c.lanes ?? []).join(" · "),
    socials: c.socials.map((s) => ({
      key: `${s.platform}:${s.handle}`,
      handle: s.platform === "linkedin" ? s.handle : `@${s.handle}`,
      followers: s.followers !== null && Number.isFinite(s.followers) ? `${grouped(s.followers)} followers` : null,
      url: s.url,
      platform: s.platform,
      viewLabel: `View on ${platformName(s.platform)}`,
    })),
    followersNote: c.socials.length ? followersNote(c.socials) : null,
    packages: c.packages.map((p) => ({ id: p.id, head: `${p.title}, ${money(p.price_cents)}`, terms: termsLine(p) })),
  };
}

export type HireMode = "package" | "application" | "offer";
export type HireParams = { package?: string; application?: string; brief?: string; offer?: string };

export function hireMode(p: HireParams): HireMode | null {
  if (p.application) return "application";
  if (p.offer) return "offer";
  if (p.package) return "package";
  return null;
}

export const QUOTE_PATH = "/api/humans/orders/quote";
export const offerPath = (offerId: string) => `/api/creators/offers/${enc(offerId)}`;

export function quoteBody(mode: "package" | "application", p: HireParams, product: boolean): { target: { package_id: string } | { application_id: string }; product_needed?: true } {
  if (mode === "application") return { target: { application_id: p.application ?? "" } };
  return product ? { target: { package_id: p.package ?? "" }, product_needed: true } : { target: { package_id: p.package ?? "" } };
}

export type HireContext = {
  mode: HireMode;
  quote: BookingQuote | null;
  offer: OfferView | null;
  card: Pick<CreatorCard, "display_name" | "city" | "packages"> | null;
  bench: HireBriefFacts | null;
  packageId?: string;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function whoOf(ctx: Pick<HireContext, "quote" | "card">): { name: string; first: string; known: boolean } {
  const known = ctx.quote?.creator.display_name || ctx.card?.display_name || "";
  return known ? { name: known, first: firstName(known), known: true } : { name: "the creator", first: "the creator", known: false };
}

export const hireLoadingTitle = "Checkout";

export function hireTitle(ctx: HireContext): string {
  const { name, first } = whoOf(ctx);
  if (ctx.mode === "application") return `Hire ${name}`;
  if (ctx.mode === "offer") return ctx.offer?.proposed_by === "tenant" ? `${cap(first)} accepted. Pay to start` : `Accept ${first}'s offer`;
  return `Book ${name}`;
}

export function offerWhen(o: Pick<OfferView, "delivery_days" | "terms">): string {
  const due = offerDue(o);
  return /^\d/.test(due) ? `delivered in ${due}` : `due ${due}`;
}

export const offerTerms = (o: OfferView) => `${offerWhat(o)} · ${offerWhen(o)} · 2 rounds of changes`;

export function jobCard(ctx: HireContext): { title: string; terms: string; who: string } {
  const { name } = whoOf(ctx);
  const city = ctx.quote?.creator.city ?? ctx.card?.city ?? null;
  const pkg = ctx.mode === "package" ? ctx.card?.packages.find((x) => x.id === ctx.packageId) : undefined;
  let title = "";
  let terms = "";
  if (ctx.mode === "application") {
    title = ctx.quote?.job.title ?? "";
    if (ctx.bench) {
      const n = ctx.bench.deliverables ?? 1;
      terms = [`${n} ${n === 1 ? "UGC video" : "UGC videos"}`, ctx.bench.format, ctx.bench.delivery_days ? `delivered in ${ctx.bench.delivery_days} days after hire` : null, "2 rounds of changes"]
        .filter(Boolean)
        .join(" · ");
    }
  } else if (ctx.mode === "offer") {
    title = ctx.offer?.proposed_by === "tenant" ? `Your custom offer to ${name}` : `Custom offer from ${name}`;
    terms = ctx.offer ? offerTerms(ctx.offer) : "";
  } else {
    title = pkg?.title ?? ctx.quote?.job.title ?? "";
    terms = pkg ? termsLine(pkg) : "";
  }
  return { title, terms, who: `${name}${city ? ` · ${city}` : ""}` };
}

export type ModeCard =
  | { kind: "application"; noteTitle: string; note: string; product: string }
  | { kind: "offer"; heading: string; terms: string; product: string }
  | { kind: "package"; showLabel: string; productQuestion: string; productYesNote: string };

export function modeCard(ctx: HireContext, appNote: string | null): ModeCard {
  const { first } = whoOf(ctx);
  if (ctx.mode === "application") {
    const product = ctx.bench?.product_needed ?? ctx.quote?.product_needed ?? false;
    return {
      kind: "application",
      noteTitle: `${cap(first)}'s note`,
      note: appNote ? `“${appNote}”` : "They did not leave a note.",
      product: product ? "Yes, from your brief." : "No, from your brief.",
    };
  }
  if (ctx.mode === "offer") {
    const o = ctx.offer;
    const at = o ? dayTimeUtc(o.created_at) : "";
    return {
      kind: "offer",
      heading: o?.proposed_by === "tenant" ? `The offer, as you sent it on ${at}` : `The offer, as ${first} sent it on ${at}`,
      terms: o ? offerTerms(o) : "",
      product: o?.product_needed ? "Yes, from the offer." : "No, from the offer.",
    };
  }
  return {
    kind: "package",
    showLabel: "What the video should show",
    productQuestion: `Do you need to send ${first} a product?`,
    productYesNote: "Share the delivery address in the job chat after hire. The due date starts when the creator marks Product received.",
  };
}

export const SHOW_MAX = 4000;

export type Money3 = { price_cents: number; business_fee_cents: number; business_total_cents: number };

export function moneyOf(ctx: Pick<HireContext, "mode" | "quote" | "offer">): Money3 | null {
  if (ctx.mode === "offer") return ctx.offer ? ctx.offer.fees : null;
  return ctx.quote ? ctx.quote.money : null;
}

export type Row = { label: string; value: string; strong?: boolean };

export function summaryRows(ctx: HireContext, m: Money3, product: boolean): Row[] {
  const { first } = whoOf(ctx);
  const rows: Row[] = [
    { label: ctx.mode === "application" ? `${cap(first)}'s price` : ctx.mode === "offer" ? "Offer" : "Package", value: money(m.price_cents) },
    { label: "Zavi fee (10%)", value: money(m.business_fee_cents) },
  ];
  if (ctx.mode === "package" && ctx.quote?.due_after_accept && !product) rows.push({ label: "Due", value: ctx.quote.due_after_accept });
  rows.push({ label: "Total", value: money(m.business_total_cents), strong: true });
  return rows;
}

export function shieldNote(ctx: HireContext): string {
  const { first } = whoOf(ctx);
  const First = cap(first);
  if (ctx.mode === "application") {
    return `Charged now. When the payment goes through, ${first} is hired, the brief closes and everyone else gets your note. If it doesn't go through, the brief stays open and nobody is told anything.`;
  }
  if (ctx.mode === "offer") return "Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.";
  const due = ctx.quote?.due_after_accept;
  return `Your card is held now, not charged. ${First} has 72 hours to accept. If ${first} accepts, you are charged and the job starts${due ? `, due ${due}` : ""}. If ${first} declines or doesn't answer, the hold is released.`;
}

export function withPaymentFlags(o: OfferView, listed: ReadonlyArray<Pick<OfferView, "id" | "awaiting_payment" | "closed_unpaid">> | null | undefined): OfferView {
  const f = listed?.find((x) => x.id === o.id);
  return f ? { ...o, awaiting_payment: f.awaiting_payment, closed_unpaid: f.closed_unpaid } : o;
}

export const OFFER_PAID = "Paid. The job has started and is in Your creators.";
export const OFFER_CHECKING = "Checking whether this offer is paid…";

export function offerBlock(o: OfferView): string | null {
  if (o.status === "accepted") {
    if (o.expired || o.closed_unpaid === true) return "This offer has expired. Ask the creator to send a new one.";
    if (o.awaiting_payment === undefined) return OFFER_CHECKING;
    if (o.awaiting_payment === false) return OFFER_PAID;
    return null;
  }
  if (o.status !== "open") return `This offer was already ${o.status}.`;
  if (o.expired) return "This offer has expired. Ask the creator to send a new one.";
  if (o.proposed_by === "tenant") return "The creator has not accepted this offer yet. You can pay once they accept it.";
  return null;
}

export function blockOf(ctx: Pick<HireContext, "mode" | "quote" | "offer">): string | null {
  if (ctx.mode === "offer") return ctx.offer ? offerBlock(ctx.offer) : null;
  return ctx.quote?.blocked?.message ?? null;
}

export function largeConfirm(ctx: Pick<HireContext, "mode" | "quote">, m: Money3 | null): string | null {
  if (ctx.mode === "offer" || !ctx.quote?.needs_large_amount_confirm || !m) return null;
  return `This is over ${money(ctx.quote.large_amount_confirm_cents)}. I want Zavi to hold ${money(m.business_total_cents)} on this card.`;
}

export function payLabel(mode: HireMode, m: Money3 | null): string {
  const total = money(m?.business_total_cents);
  return mode === "package" ? `Hold ${total}` : `Pay ${total}`;
}

export const PAY_BUSY = "Opening the payment page";
export const NO_CHECKOUT = "Zavi could not open the payment page. Nothing was charged. Try again in a moment.";
export const priceMovedNote = (total: number) => `The price changed to ${money(total)}. Check it and pay again.`;

export type PayRequest = { path: string; body: Record<string, unknown> };

export function payRequest(
  ctx: Pick<HireContext, "mode" | "quote" | "offer">,
  p: HireParams,
  opts: { confirmed: boolean; show: string; product: boolean },
): PayRequest | null {
  const confirmed = opts.confirmed && Boolean(ctx.quote?.needs_large_amount_confirm);
  if (ctx.mode === "package") {
    if (!ctx.quote || !p.package) return null;
    const show = opts.show.trim();
    return {
      path: "/api/humans/orders",
      body: {
        target: { package_id: p.package },
        due_at: ctx.quote.due_at ?? undefined,
        large_amount_confirmed: confirmed ? true : undefined,
        return_path: "ugc",
        brief_title: show ? ctx.quote.job.title : undefined,
        brief: show || undefined,
        product_needed: opts.product,
      },
    };
  }
  if (ctx.mode === "application") {
    const brief = p.brief || ctx.quote?.job.brief_id || "";
    if (!brief || !p.application) return null;
    return { path: `/api/humans/briefs/${enc(brief)}/hire`, body: { application_id: p.application, large_amount_confirmed: confirmed ? true : undefined } };
  }
  if (!ctx.offer) return null;
  return ctx.offer.status === "accepted"
    ? { path: `/api/creators/offers/${enc(ctx.offer.id)}/checkout`, body: {} }
    : { path: `/api/creators/offers/${enc(ctx.offer.id)}/accept`, body: {} };
}

export type PayAnswer = { orderId: string | null; url: string | null; money: Money3 | null };

type AnyBody = {
  order_id?: string | null;
  checkout_url?: string | null;
  quote?: { money?: Money3 } | null;
  fees?: Money3 | null;
  order?: { order_id?: string | null; checkout_url?: string | null } | null;
};

export function readPayAnswer(mode: HireMode, body: unknown): PayAnswer {
  const b = (body ?? {}) as AnyBody;
  const pick = (m: Money3 | null | undefined): Money3 | null =>
    m && Number.isFinite(m.business_total_cents) ? { price_cents: m.price_cents, business_fee_cents: m.business_fee_cents, business_total_cents: m.business_total_cents } : null;
  if (mode === "offer") {
    if (b.order) return { orderId: b.order.order_id ?? null, url: b.order.checkout_url ?? null, money: null };
    return { orderId: b.order_id ?? null, url: b.checkout_url ?? null, money: null };
  }
  return { orderId: b.order_id ?? null, url: b.checkout_url ?? null, money: pick(mode === "package" ? b.quote?.money : b.fees) };
}

export function priceMoved(shownTotal: number | null | undefined, answered: Money3 | null): boolean {
  return answered !== null && typeof shownTotal === "number" && answered.business_total_cents !== shownTotal;
}

const PENDING_KEEP = 50;
export const pendingHireKey = (tenant: string) => `zavi.ugc.pendingHire.${tenant}`;

export function readPendingHires(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(v as Record<string, unknown>)) if (typeof id === "string" && id) out[k] = id;
    return out;
  } catch {
    return {};
  }
}

export function withPendingHire(raw: string | null | undefined, applicationId: string, orderId: string): string {
  const entries = Object.entries(readPendingHires(raw)).filter(([k]) => k !== applicationId);
  entries.push([applicationId, orderId]);
  return JSON.stringify(Object.fromEntries(entries.slice(-PENDING_KEEP)));
}

export type OfferCardActions =
  | { kind: "answer"; decline: string; accept: string; to: Route }
  | { kind: "pay"; title: string; body: string; label: string; to: Route }
  | null;

export function offerCardActions(
  o: Pick<OfferView, "id" | "proposed_by" | "status" | "expired" | "awaiting_payment" | "closed_unpaid"> & { fees: { business_total_cents: number } },
  first: string,
): OfferCardActions {
  const to: Route = { pathname: "/channels/ugc/hire", params: { offer: o.id } };
  const mine = o.proposed_by === "tenant";
  if (o.status === "accepted" && o.awaiting_payment && o.closed_unpaid !== true) {
    return {
      kind: "pay",
      title: `${mine ? `${first} accepted` : "You accepted"}. Pay to start`,
      body: "Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.",
      label: `Pay ${money(o.fees.business_total_cents)}`,
      to,
    };
  }
  if (!mine && o.status === "open" && !o.expired) return { kind: "answer", decline: "Decline", accept: "Accept and pay", to };
  return null;
}

export function offerCardHint(o: Parameters<typeof offerHint>[0], first: string): string | null {
  if (o.status === "accepted" && o.awaiting_payment && o.closed_unpaid !== true) return null;
  if (o.proposed_by === "creator" && o.status === "open" && !o.expired) {
    return `Accept and pay charges your card now and the job starts. No 72 hour wait, because ${first} made the offer.`;
  }
  return offerHint(o, first);
}

export const offerDeclinePath = (offerId: string) => `/api/creators/offers/${enc(offerId)}/decline`;

export const seeApplicantsLabel = (n: number) => `See ${n} ${n === 1 ? "applicant" : "applicants"}`;
export const applicantsRoute = (briefId: string): Route => ({ pathname: "/channels/ugc/applicants/[id]", params: { id: briefId } });

export const REPOST_DIALOG = {
  title: "Close and repost?",
  message: "This closes the brief and sends every pending applicant your note, then opens an editable copy to post again. Continue?",
  confirmLabel: "Close and repost",
  cancelLabel: "Not now",
};

export const bookLabel = (p: Pick<CreatorPackage, "business_total_cents">) => `Book · ${money(p.business_total_cents)}`;
export const bookRoute = (p: Pick<CreatorPackage, "id">): Route => ({ pathname: "/channels/ugc/hire", params: { package: p.id } });
