import {
  dayTimeUtc,
  firstName,
  formatCents,
  isNeverPaid,
  longDay,
  messageStamp,
  money,
  shortDay,
  type BusinessAction,
  type JobAction,
  type JobDetail,
  type JobReceipt,
  type JobSummary,
  type Submission,
  type ThreadMessage,
} from "./ugc";
import { termsLine as packageTermsLine } from "./creatorProfile";

const enc = encodeURIComponent;

function who(j: Pick<JobSummary, "creator_display_name">): { n: string; N: string } {
  const full = (j.creator_display_name ?? "").trim();
  return full ? { n: firstName(full), N: firstName(full) } : { n: "the creator", N: "The creator" };
}

export function creatorFirst(j: Pick<JobSummary, "creator_display_name">): string {
  return who(j).n;
}

export function screenTitle(d: JobDetail | null | undefined): string {
  if (!d) return "Job";
  const j = d.job;
  if (isNeverPaid(j)) return "Payment not finished";
  if (j.status === "submitted") return `Review ${who(j).n}'s video`;
  return `Job #${j.id.slice(0, 8)}`;
}

export function headerTitle(j: JobSummary): string {
  return `${j.creator_display_name || "Creator"}: ${j.title}`;
}

export function headerSub(j: JobSummary): string {
  return `${money(j.money.business_total_cents)} with Zavi's fee${isNeverPaid(j) ? "" : ` · Job #${j.id.slice(0, 8)}`}`;
}

export const STAGES = ["Booked", "Accepted", "Delivered", "Paid"] as const;

export function isAcceptedJob(j: Pick<JobSummary, "status" | "closed_reason">): boolean {
  return j.status === "completed" && (j.closed_reason === "approved" || j.closed_reason === "auto_accepted");
}

export function stageOf(status: string, closed_reason: string | null = null): number | null {
  switch (status) {
    case "awaiting_acceptance":
      return 1;
    case "in_progress":
    case "revision_requested":
    case "cancel_requested":
    case "in_dispute":
      return 2;
    case "submitted":
      return 3;
    case "completed":
      return isAcceptedJob({ status, closed_reason }) ? STAGES.length : null;
    default:
      return null;
  }
}

export type PaymentProblem = { problem: "needs_staff" | "cancelled"; message: string };

export type PaymentState = "confirming" | "slow" | "left" | "viewer" | PaymentProblem;

export type FulfilAnswer =
  | { state: "fulfilled"; order_id?: string; status?: string }
  | { state: "already_done"; order_id?: string; status?: string }
  | { state: "pending"; order_id?: string; reason: string }
  | { state: "cancelled"; order_id?: string; status?: string; message: string }
  | { state: "needs_staff"; order_id?: string; message: string };

export const FULFIL_POLL_MS = 2500;
export const FULFIL_MAX_TRIES = 12;

export type FulfilPoll = {
  tries: number;
  running: boolean;
  lastReason: string | null;
  problem: PaymentProblem | null;
  settled: boolean;
};

export const POLL_IDLE: FulfilPoll = { tries: 0, running: false, lastReason: null, problem: null, settled: false };

export function pollStarted(): FulfilPoll {
  return { tries: 0, running: true, lastReason: null, problem: null, settled: false };
}

export function pollAfterTry(p: FulfilPoll, answer: FulfilAnswer | null): { poll: FulfilPoll; next: "wait" | "refetch" | "stop" } {
  if (answer && answer.state !== "pending") {
    const problem =
      answer.state === "cancelled" || answer.state === "needs_staff"
        ? { problem: answer.state, message: typeof answer.message === "string" ? answer.message : "" }
        : null;
    return { poll: { ...p, tries: p.tries + 1, running: false, settled: true, problem }, next: "refetch" };
  }
  const tries = p.tries + 1;
  const lastReason = answer ? answer.reason : null;
  const running = tries < FULFIL_MAX_TRIES;
  return { poll: { ...p, tries, lastReason, running }, next: running ? "wait" : "stop" };
}

const LEFT_REASONS = new Set(["no_checkout", "no_payment_intent"]);

export function paymentState(p: FulfilPoll): PaymentState {
  if (p.problem) return p.problem;
  if (p.running || p.settled || p.tries < FULFIL_MAX_TRIES) return "confirming";
  return p.lastReason !== null && LEFT_REASONS.has(p.lastReason) ? "left" : "slow";
}

export const fulfilPath = (orderId: string) => `/api/humans/orders/${enc(orderId)}/fulfil`;

export function checkoutPath(j: Pick<JobSummary, "id" | "source" | "offer_id">): string {
  return j.source === "offer" && j.offer_id
    ? `/api/creators/offers/${enc(j.offer_id)}/checkout`
    : `/api/humans/orders/${enc(j.id)}/checkout`;
}

export const NO_CHECKOUT_URL = "Zavi could not open the payment page. Nothing was charged. Try again in a moment.";

export type Tone = "zinc" | "green" | "amber" | "red" | "blue";
export type FactIcon = "lock" | "due" | "release" | "mail";
export type Fact = { icon: FactIcon; text: string; sub?: string };
export type StatusButton = { kind: "pay" | "resume" | "check"; label: string; busyLabel: string };

export type JobView = {
  chip: [Tone, string];
  title: string;
  body: string[];
  facts?: Fact[];
  work: boolean;
  button?: StatusButton;
};

const BUSY_OPENING = "Opening the payment page";

const REASON: Record<string, [string, string, string]> = {
  checkout_abandoned: ["Closed, not paid", "The payment was never finished", "Nothing was charged."],
  payment_failed: ["Payment failed, job cancelled", "The charge didn't go through", "The job is cancelled. Nothing was charged."],
  declined: ["Declined, hold released", "passed on this booking", "Nothing was charged and the hold on your card is released."],
  expired: ["No answer, hold released", "didn't answer in 72 hours", "Nothing was charged and the hold on your card is released."],
  withdrawn: ["You cancelled, hold released", "You cancelled before the creator accepted", "Nothing was charged and the hold on your card is released."],
  creator_removed: ["Creator removed, hold released", "is no longer on Zavi", "Nothing was charged and the hold on your card is released."],
  no_show: ["Not delivered, refunded", "didn't deliver in time", "The job is cancelled and your payment is refunded in full."],
  cancel_agreed: ["Cancelled, refunded", "agreed to cancel", "Your payment is refunded in full, including the 10% Zavi fee."],
  cancel_no_response: ["Cancelled, refunded", "didn't answer the cancellation", "72 hours without an answer counts as agreeing. Your payment is refunded in full, including the 10% Zavi fee."],
  mediation_refund: ["Zavi decided: refund", "Zavi decided you are refunded", "Your payment is refunded in full."],
  mediation_pay_full: ["Zavi decided: pay in full", "Zavi decided the creator is paid in full", "Nothing is refunded."],
  mediation_pay_part: ["Zavi decided: pay part", "Zavi decided the creator is paid part", "The rest of your payment is refunded to your card."],
  approved: ["Approved and paid", "You approved the work", ""],
};

const SENTENCE_START = ["You", "Zavi", "The", "Nobody", "This"];

const num = (o: Record<string, unknown> | null | undefined, k: string): number | null => {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

function latestVersion(subs: readonly Submission[]): number {
  return subs.reduce((m, s) => (s.version > m ? s.version : m), 0);
}

function afterWindowPayout(payout_status: string | undefined, n: string, N: string): string {
  if (payout_status === "transferred") return `${N}'s payout is released.`;
  if (payout_status === "transferring") return `${N}'s payout is on its way.`;
  if (payout_status === "awaiting_payout_account") return `Zavi pays ${n} once their Stripe setup is finished.`;
  return `Zavi has not sent ${n}'s payout yet.`;
}

function autoAcceptedReason(d: JobDetail, n: string, N: string): [string, string, string] {
  const open = d.actions.some((a) => a.action === "ask_zavi_in_buffer");
  return [
    "Accepted automatically",
    "Nobody reviewed in 72 hours, so the job closed as accepted",
    open
      ? `${N} is paid 10 days after the job closed. Until then you can ask Zavi to step in, and the payout is held until Zavi decides.`
      : `The 10 days to ask Zavi to step in have passed. ${afterWindowPayout(d.job.money.payout_status, n, N)}`,
  ];
}

export function jobView(d: JobDetail, payment: PaymentState = "confirming"): JobView {
  const j = d.job;
  const { n, N } = who(j);
  const total = money(j.money.business_total_cents);
  const due = shortDay(j.due_at);
  const by = dayTimeUtc(j.deadline?.deadline_at);
  const used = d.revisions?.used ?? 0;
  const left = d.revisions?.left ?? 2;
  const changes = `Changes requested: ${used} of 2, ${left} left`;
  const days = num(d.package_snapshot, "delivery_days");
  const latest = latestVersion(d.submissions);
  const deliveredOn = dayTimeUtc(d.submissions.find((s) => s.version === latest)?.created_at);

  switch (j.status) {
    case "checkout_pending": {
      if (typeof payment === "object") {
        return payment.problem === "needs_staff"
          ? { chip: ["red", "Zavi staff are checking this"], title: "Zavi staff have to look at this", body: [payment.message, "Do not pay again."].filter(Boolean), work: false }
          : { chip: ["red", "Cancelled"], title: "This job was cancelled", body: [payment.message].filter(Boolean), work: false };
      }
      if (payment === "viewer") {
        return { chip: ["amber", "Payment not finished"], title: "Payment not finished", body: ["The job starts once a member of your workspace finishes the payment."], work: false };
      }
      if (payment === "confirming") {
        return {
          chip: ["amber", "Confirming your payment"],
          title: j.source === "booking" ? "Confirming the hold on your card" : "Confirming your payment",
          body: ["This takes a few seconds. Do not pay again."],
          work: false,
        };
      }
      if (payment === "slow") {
        return {
          chip: ["amber", "Confirming your payment"],
          title: "Still waiting on your bank",
          body: [
            `The ${j.source === "booking" ? "hold" : "payment"} has not come back from your bank yet. Nothing is lost: this updates on its own once it lands, and Zavi is also told directly by Stripe.`,
          ],
          work: false,
          button: { kind: "check", label: "Check again", busyLabel: "Checking" },
        };
      }
      if (j.source !== "offer") {
        return {
          chip: ["amber", "Not paid"],
          title: "Nothing was charged",
          body: ["You left the payment page, so nothing was charged and no job was started."],
          work: false,
          button: { kind: "resume", label: "Try again", busyLabel: BUSY_OPENING },
        };
      }
      if (j.offer_expired) {
        return {
          chip: ["zinc", "Closed, not paid"],
          title: "This offer expired before it was paid",
          body: [`Nothing was charged and no job was started. Send ${n} a new offer to work together.`],
          work: false,
        };
      }
      return {
        chip: ["amber", "Not paid"],
        title: "Pay to start the job",
        body: [
          "You left the payment page, so nothing was charged.",
          "Nothing is charged yet. Paying charges your card and the job starts as soon as the payment goes through.",
        ],
        work: false,
        button: { kind: "pay", label: "Pay to start", busyLabel: BUSY_OPENING },
      };
    }
    case "awaiting_acceptance": {
      const price = j.money.price_cents;
      const fee = j.money.business_fee_cents;
      const split = typeof price === "number" && typeof fee === "number" ? ` ${money(price)} price + ${money(fee)} Zavi fee.` : "";
      return {
        chip: ["amber", `Waiting for ${n}`],
        title: `${N} has until ${by} to accept`,
        body: [
          `${total} is held on your card, not charged. It is charged when ${n} accepts.`,
          ...(j.due_after_accept ? [`The work is due ${j.due_after_accept}.`] : []),
          `If ${n} declines or doesn't answer within 72 hours, the hold is released and nothing is charged. We email you when ${n} answers.`,
        ],
        facts: [
          { icon: "lock", text: `${total} held on your card, not charged`, sub: `Charged only when ${n} accepts.${split}` },
          ...(j.due_after_accept ? [{ icon: "due" as const, text: `Due ${j.due_after_accept}` }] : []),
          { icon: "release", text: `No answer by ${by}? The hold is released`, sub: `Same if ${n} declines. Nothing is charged.` },
          { icon: "mail", text: `We email you when ${n} answers` },
        ],
        work: false,
      };
    }
    case "in_progress":
      if (d.extension?.state === "requested") {
        return {
          chip: ["amber", "New date requested"],
          title: `${N} asked to move the due date from ${due} to ${shortDay(d.extension.requested_due_at)}`,
          body: ["A creator can ask for one new date before the due date. It only changes if you agree."],
          work: false,
        };
      }
      if (j.product_needed && !j.product_received_at) {
        return {
          chip: ["amber", "Waiting for your product"],
          title: `Send ${n} the product`,
          body: [
            `Ask ${n} for a delivery address in the job chat below, then ship the product.`,
            `The ${days ? `${days} ` : ""}days to deliver start when ${n} marks Product received. Zavi holds your ${total} until you approve the work.`,
          ],
          work: false,
        };
      }
      if (j.product_needed && j.product_received_at) {
        return {
          chip: ["blue", `Product received, due ${due}`],
          title: `${N} marked Product received on ${shortDay(j.product_received_at)}`,
          body: [`The ${days ? `${days} ` : ""}days to deliver started then, so the work is due ${due}.`],
          work: false,
        };
      }
      return {
        chip: ["blue", due ? `In progress, due ${due}` : "In progress"],
        title: due ? `${N} is working on it. Due ${due}` : `${N} is working on it.`,
        body: [`Zavi holds your ${total} until you approve the work.`],
        work: false,
      };
    case "submitted":
      return {
        chip: ["green", `${latest > 1 ? "New version" : "Delivered"}, review by ${by}`],
        title: latest > 1 ? `${N} sent a new version on ${deliveredOn}` : `${N} delivered on ${deliveredOn}`,
        body: [
          left > 0 ? `Approve it, or ask for changes that match what you ordered. ${changes}.` : `${changes}. If it still isn't right, ask Zavi for help.`,
          `If you don't answer by ${by} (72 hours), the job closes as accepted and ${n} is paid 10 days later.`,
        ],
        work: true,
      };
    case "revision_requested":
      return {
        chip: ["amber", `Changes requested: ${used} of 2`],
        title: used > 1 ? `You asked ${n} for changes again` : `You asked ${n} for changes`,
        body: [
          left > 0
            ? `${N} is making the change and sends a new version here. ${changes}.`
            : `${N} is making the change and sends a new version here. ${changes}: after this version you can approve it or ask Zavi for help.`,
        ],
        work: true,
      };
    case "cancel_requested":
      return {
        chip: ["amber", `You asked to cancel, ${n} answers by ${by}`],
        title: `${N} has until ${by} to answer`,
        body: ["If they agree, or say nothing, your card is refunded in full including the 10% Zavi fee. If they decline, the job carries on."],
        work: false,
      };
    case "in_dispute":
      return {
        chip: ["amber", "Zavi is stepping in"],
        title: "Zavi staff are looking at this job",
        body: [
          "Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The money waits until they do.",
          "Both of you get an email when Zavi decides.",
        ],
        work: true,
      };
    default: {
      const r: [string, string, string] =
        j.source === "applicant" && j.closed_reason === "checkout_abandoned"
          ? ["Not hired, hold released", "The hire didn't go through", "The payment was not finished, or another hire filled the brief first. Nothing was charged."]
          : j.closed_reason === "auto_accepted"
            ? autoAcceptedReason(d, n, N)
            : (REASON[j.closed_reason ?? ""] ?? ["Closed", "This job is closed", ""]);
      const approved = j.closed_reason === "approved";
      const accepted = approved || j.closed_reason === "auto_accepted";
      const adDays = d.package_snapshot?.kind === "ugc_video" ? num(d.package_snapshot, "ad_rights_days") : null;
      const rights = adDays && adDays > 0 ? [`You can run this video as an ad for ${adDays} days, the ad rights in the package.`] : [];
      const price = money(j.money.price_cents);
      return {
        chip: ["zinc", r[0]],
        title: approved
          ? `You approved${j.closed_at ? ` on ${shortDay(j.closed_at)}` : ""}. ${N}'s payout is released.`
          : SENTENCE_START.some((w) => r[1].startsWith(w))
            ? r[1]
            : `${N} ${r[1]}`,
        body: approved
          ? [
              `Your agreed ${price ? `${price} ` : ""}payment to ${n} is released. If ${n}'s Stripe setup isn't finished yet, Zavi holds it until it is.`,
              ...rights,
            ]
          : [r[2], ...(accepted ? rights : [])].filter(Boolean),
        work: j.status === "completed",
      };
    }
  }
}

export function videoTile(d: JobDetail, view: Pick<JobView, "work">): { file: Submission; caption: string } | null {
  if (!view.work) return null;
  const latest = latestVersion(d.submissions);
  const file = d.submissions.find((s) => s.version === latest && s.kind === "video") ?? d.submissions.find((s) => s.version === latest);
  if (!file) return null;
  const len = num(d.package_snapshot, "video_length_seconds");
  return { file, caption: `${len ? `${len}s video` : "Video"} · ${shortDay(file.created_at)}` };
}

export const LINK_FRESH_MS = 50 * 60_000;
export function linkIsStale(readAtMs: number, nowMs: number): boolean {
  return !readAtMs || nowMs - readAtMs > LINK_FRESH_MS;
}

export const NO_VIEW_LINK = "Zavi could not make a viewing link for this file. Try again.";

export function playMode(kind: string, inAppVideo: boolean): "video" | "image" | "open" {
  if (kind === "video" || kind === "raw_footage") return inAppVideo ? "video" : "open";
  if (kind === "image") return "image";
  return "open";
}

const WANTS_NOTE = new Set<string>(["request_change", "request_cancellation", "ask_zavi", "ask_zavi_in_buffer"]);

export function wantsNote(a: Pick<JobAction, "action" | "wants_note">): boolean {
  return a.wants_note ?? WANTS_NOTE.has(a.action);
}

export function jobActions(d: JobDetail): JobAction[] {
  const price = money(d.job.money.price_cents);
  const noChangesLeft = (d.revisions?.left ?? 2) === 0;
  return d.actions.map((a) => ({
    ...a,
    wants_note: wantsNote(a),
    label: a.action === "approve" && price ? `Approve and release ${price}` : noChangesLeft && a.action === "ask_zavi" ? "Ask Zavi for help" : a.label,
  }));
}

export function groupActions<A extends { action: string }>(actions: A[]): { primary: A[]; secondary: A[]; loose: A[]; others: A[] } {
  const isPrimary = (a: A) => a.action === "approve" || a.action === "approve_extension";
  const isSecondary = (a: A) => a.action === "request_change" || a.action === "decline_extension";
  const primary = actions.filter(isPrimary);
  const secondary = actions.filter(isSecondary);
  const rest = actions.filter((a) => !isPrimary(a) && !isSecondary(a));
  const grouped = primary.length + secondary.length > 0;
  return { primary, secondary, loose: grouped ? [] : rest, others: grouped ? rest : [] };
}

export function notePrompt(action: BusinessAction | string): string {
  if (action === "request_change") return "what should change?";
  if (action === "request_cancellation") return "why do you want to cancel?";
  return "what should Zavi know?";
}

export const noteLabel = (a: Pick<JobAction, "action" | "label">) => `${a.label}: ${notePrompt(a.action)}`;
export const NOTE_MAX = 4000;

export function pressKind(a: Pick<JobAction, "action" | "wants_note">): "note" | "approve" | "withdraw" | "run" {
  if (wantsNote(a)) return "note";
  if (a.action === "approve") return "approve";
  if (a.action === "withdraw") return "withdraw";
  return "run";
}

export type DialogCopy = { title: string; message: string; cancelLabel: string; confirmLabel: string; destructive?: boolean };

export function approveDialog(d: JobDetail): DialogCopy {
  const price = money(d.job.money.price_cents);
  const { n } = who(d.job);
  return {
    title: "Approve and release?",
    message: `Approving releases the agreed ${price ? `${price} ` : ""}price to ${n}. The job closes and this cannot be undone.`,
    cancelLabel: "Not now",
    confirmLabel: price ? `Yes, release ${price}` : "Yes, approve and release",
  };
}

export function withdrawDialog(a: Pick<JobAction, "label" | "consequence">): DialogCopy {
  return { title: a.label, message: a.consequence, cancelLabel: "Keep it", confirmLabel: "Cancel this booking", destructive: true };
}

export const actionPath = (orderId: string) => `/api/humans/orders/${enc(orderId)}/actions`;

export function actionBody(action: string, note?: string | null): { action: string; note?: string } {
  const t = (note ?? "").trim();
  return t ? { action, note: t } : { action };
}

export type HistoryEntry =
  | { kind: "msg"; key: string; at: string; from: "me" | "creator" | "zavi"; text: string }
  | { kind: "change"; key: string; at: string; round: number; note: string | null }
  | { kind: "delivery"; key: string; at: string; version: number; files: Submission[]; note: string | null };

export function jobHistory(
  d: Pick<JobDetail, "submissions" | "change_requests">,
  messages: readonly ThreadMessage[],
): HistoryEntry[] {
  const changes = d.change_requests ?? [];
  const notes = new Set(changes.map((c) => (c.note ?? "").trim()).filter(Boolean));
  const out: HistoryEntry[] = [];
  for (const m of messages) {
    if (m.sender_kind === "tenant" && notes.has(m.body.trim())) continue;
    const from = m.sender_kind === "tenant" ? "me" : m.sender_kind === "creator" ? "creator" : "zavi";
    out.push({ kind: "msg", key: `m:${m.id}`, at: m.created_at, from, text: m.body });
  }
  for (const c of changes) out.push({ kind: "change", key: `c:${c.round}`, at: c.created_at, round: c.round, note: c.note });
  const versions = new Map<number, Submission[]>();
  for (const s of d.submissions) versions.set(s.version, [...(versions.get(s.version) ?? []), s]);
  for (const [version, files] of versions) {
    const sorted = [...files].sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    const at = sorted.reduce((m, x) => ((x.created_at ?? "") < m ? (x.created_at ?? "") : m), sorted[0].created_at ?? "");
    out.push({ kind: "delivery", key: `v:${version}`, at, version, files: sorted, note: sorted.find((x) => x.note)?.note ?? null });
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

export const stamp = (iso: string, now: Date = new Date()): string => messageStamp(iso, now);

export const changeTitle = (round: number, max: number) => `You asked for changes · round ${round} of ${max}`;
export const NO_CHANGE_NOTE = "No note was added to this request.";
export const deliveryTitle = (first: string, version: number) => `${first} delivered version ${version}`;

export function fileLinkLabel(file: Pick<Submission, "kind" | "play_url">, index: number, count: number): string {
  if (!file.play_url) return `File ${index + 1}: link unavailable right now`;
  const verb = file.kind === "video" ? "Watch" : "Open";
  return `${verb} ${count > 1 ? `file ${index + 1}` : file.kind === "video" ? "video" : "file"}`;
}

export const historyHeading = (first: string) => `History and messages with ${first}`;
export const historySub = (first: string) =>
  `Messages, change requests and every version ${first} sent. Each new message emails the other side, at most one email every 15 minutes.`;

export function historyEmptyLine(d: JobDetail, entries: number, first: string): string | null {
  if (!d.thread?.available) return "Messages for this job aren't available right now.";
  return entries === 0 ? `No messages with ${first} yet.` : null;
}

export function canCompose(d: JobDetail): boolean {
  return !!d.thread?.available && (!!d.thread.thread_id || !!d.job.human_member_id);
}

export type ReceiptRow = { label: string; value: string; strong: boolean };

export function receiptRows(r: JobReceipt): ReceiptRow[] {
  const c = r.currency ?? "usd";
  const rows: ReceiptRow[] = [
    { label: "Creator price", value: formatCents(r.price_cents, c), strong: false },
    { label: "Zavi fee", value: formatCents(r.business_fee_cents, c), strong: false },
    { label: "Charged to your card", value: formatCents(r.business_total_cents, c), strong: true },
  ];
  if (r.refunded_cents > 0) {
    rows.push({ label: "Refunded", value: `-${formatCents(r.refunded_cents, c)}`, strong: false });
    rows.push({ label: "You paid", value: formatCents(r.business_total_cents - r.refunded_cents, c), strong: true });
  }
  return rows;
}

export const receiptStamp = (r: Pick<JobReceipt, "paid_at">, orderId: string) => `Paid ${longDay(r.paid_at)} · Job #${orderId.slice(0, 8)}`;

export function chargebackNote(r: Pick<JobReceipt, "chargeback_status">): string | null {
  return r.chargeback_status === "open" ? "Your bank is disputing this charge. The creator's payout is on hold until it is decided." : null;
}

export function disputeNotice(d: JobDetail["dispute"]): { tone: "warn" | "ok"; title: string; body: string } | null {
  if (!d) return null;
  if (d.status === "open") {
    const reason = (d.reason ?? "").trim().replace(/\.+$/, "");
    return {
      tone: "warn",
      title: "Zavi is stepping in",
      body: `${d.opened_by === "tenant" ? "You asked" : "The creator asked"} Zavi to step in: ${reason}. Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The money waits until they do.`,
    };
  }
  const outcome =
    d.outcome === "pay_full"
      ? "Zavi paid the creator in full."
      : d.outcome === "pay_part"
        ? "Zavi paid the creator part of the price and refunded you the rest."
        : "Zavi refunded you in full.";
  return { tone: "ok", title: "Zavi has decided", body: `${outcome}${d.resolution_note ? ` ${d.resolution_note}` : ""}` };
}

export function termsLine(snap: Record<string, unknown> | null | undefined): string | null {
  if (snap?.kind !== "ugc_video") return null;
  return packageTermsLine({
    kind: "ugc_video",
    video_count: num(snap, "video_count"),
    video_length_seconds: num(snap, "video_length_seconds"),
    ad_rights_days: num(snap, "ad_rights_days"),
    delivery_days: num(snap, "delivery_days") ?? 0,
  });
}

export function orderedLines(d: Pick<JobDetail, "package_snapshot" | "brief_snapshot">): string[] {
  const brief = d.brief_snapshot ?? {};
  const asked = [brief.brief, brief.title].find((x): x is string => typeof x === "string" && x.trim().length > 0) ?? null;
  return [termsLine(d.package_snapshot), asked].filter((x): x is string => Boolean(x));
}

export function bookAgain(d: JobDetail): { label: string; pathname: "/channels/ugc/hire" | "/channels/ugc/find"; params: Record<string, string> } | null {
  if (!isAcceptedJob(d.job)) return null;
  const label = `Book ${who(d.job).n} again`;
  return d.rebook
    ? { label, pathname: "/channels/ugc/hire", params: { package: d.rebook.package_id } }
    : { label, pathname: "/channels/ugc/find", params: {} };
}

export function nextAdLine(d: JobDetail): { rights: string } | null {
  if (!isAcceptedJob(d.job) || d.package_snapshot?.kind !== "ugc_video") return null;
  const days = num(d.package_snapshot, "ad_rights_days");
  return { rights: days ? ` Ad rights last ${days} days, from ${who(d.job).n}'s package.` : "" };
}

export const META_ADS_SLUG = "meta_ads";

export function jobSections(d: JobDetail): { review: boolean; publish: boolean; receipt: boolean; next: boolean } {
  const completed = d.job.status === "completed";
  return { review: completed, publish: completed, receipt: !!d.receipt, next: nextAdLine(d) !== null };
}

const LIVE = new Set(["awaiting_acceptance", "in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute"]);
export const LIVE_REFETCH_MS = 30_000;
export const refreshesLive = (status: string) => LIVE.has(status);

export const REVIEW_AXES = [
  { id: "communication", label: "Communication" },
  { id: "timeliness", label: "On time" },
  { id: "satisfaction", label: "Happy with the result" },
] as const;

export type ReviewScores = { communication: number; timeliness: number; satisfaction: number };
export const NO_SCORES: ReviewScores = { communication: 0, timeliness: 0, satisfaction: 0 };
export const REVIEW_NOTE_MAX = 2000;

const score = (v: number) => Number.isInteger(v) && v >= 1 && v <= 5;
export const reviewReady = (s: ReviewScores) => score(s.communication) && score(s.timeliness) && score(s.satisfaction);

export function reviewBody(s: ReviewScores, note: string): { communication: number; timeliness: number; satisfaction: number; body: string | null } {
  return { communication: s.communication, timeliness: s.timeliness, satisfaction: s.satisfaction, body: note.trim() || null };
}

export const reviewAverage = (s: ReviewScores) => Math.round(((s.communication + s.timeliness + s.satisfaction) / 3) * 10) / 10;
export const reviewThanks = (s: ReviewScores, first: string) => `Thanks. Your review (${reviewAverage(s)} out of 5) is on ${first}'s card.`;
export const reviewedLine = (first: string) => `You reviewed ${first}. It is on ${first}'s card.`;
export const reviewSub = (first: string) => `Businesses see the average and the number of reviews on ${first}'s card in Find creators.`;
export const starLabel = (label: string, k: number) => `${label}: ${k} out of 5`;
export const reviewPath = (orderId: string) => `/api/humans/orders/${enc(orderId)}/review`;

export type Publication = {
  id: string;
  publisher: "business" | "creator";
  platform: string;
  account: string | null;
  post_url: string | null;
  status: "scheduled" | "published";
  scheduled_for: string | null;
  published_at: string | null;
  verification: "verified" | "pending" | "manual" | "failed";
  verification_note: string | null;
  verified_at: string | null;
  created_at: string;
};

export type PublicationsResponse = { publisher: "business" | "creator"; can_record: boolean; publications: Publication[] };

export const PUBLISH_PLATFORMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "facebook", label: "Facebook" },
  { value: "x", label: "X" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "pinterest", label: "Pinterest" },
  { value: "other", label: "Other" },
];

export const platformLabel = (id: string) => PUBLISH_PLATFORMS.find((p) => p.value === id)?.label ?? id;

const VERIFY_BADGE: Record<Publication["verification"], { text: string; tone: Tone }> = {
  verified: { text: "Verified", tone: "green" },
  pending: { text: "Not checked yet", tone: "zinc" },
  manual: { text: "Check manually", tone: "amber" },
  failed: { text: "Did not match", tone: "red" },
};

export function publicationBadge(p: Pick<Publication, "status" | "verification">): { text: string; tone: Tone } {
  if (p.status === "scheduled") return { text: "Planned", tone: "zinc" };
  return VERIFY_BADGE[p.verification] ?? { text: "Not checked yet", tone: "zinc" };
}

export const publicationTitle = (p: Pick<Publication, "platform" | "account">) => `${platformLabel(p.platform)}${p.account ? ` · ${p.account}` : ""}`;

export function publicationLine(p: Publication, first: string): string {
  const when =
    p.status === "scheduled"
      ? `Planned for ${dayTimeUtc(p.scheduled_for)}`
      : `Posted ${dayTimeUtc(p.published_at)}${p.verified_at ? ` · verified ${dayTimeUtc(p.verified_at)}` : ""}`;
  return `${when} · by ${p.publisher === "business" ? "you" : first}`;
}

export const canCheckAgain = (p: Pick<Publication, "post_url" | "verification">) => !!p.post_url && (p.verification === "pending" || p.verification === "failed");

export function publishSub(publisher: "business" | "creator", first: string): string {
  const whoPosts = publisher === "business" ? "You publish this video" : `${first} publishes this post`;
  return `${whoPosts}. Approved and paid is not the same as posted: add each post so it is on record, and Zavi checks TikTok and YouTube links against the platform.`;
}

export const publicationsPath = (orderId: string) => `/api/humans/orders/${enc(orderId)}/publications`;
export const verifyPath = (publicationId: string) => `/api/humans/publications/${enc(publicationId)}/verify`;

export function parseLocalDateTime(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = new Date(y, mo - 1, d, h, mi);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return null;
  return at.toISOString();
}

export function localDateTimeText(d: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type PublishForm = { mode: "live" | "planned"; platform: string; account: string; url: string; when: string };
export const EMPTY_PUBLISH_FORM: PublishForm = { mode: "live", platform: "tiktok", account: "", url: "", when: "" };

export function publishBody(f: PublishForm): Record<string, string> | null {
  const account = f.account.trim();
  const base: Record<string, string> = { platform: f.platform, ...(account ? { account } : {}) };
  const when = f.when.trim();
  const iso = when ? parseLocalDateTime(when) : null;
  if (f.mode === "live") {
    const url = f.url.trim();
    if (!url || (when && !iso)) return null;
    return { ...base, post_url: url, ...(iso ? { published_at: iso } : {}) };
  }
  return iso ? { ...base, scheduled_for: iso } : null;
}

export const whenInvalid = (f: Pick<PublishForm, "when">) => f.when.trim() !== "" && parseLocalDateTime(f.when) === null;
