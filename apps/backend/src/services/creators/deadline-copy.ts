
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

export type DeadlineAudience = {
  side: "creator" | "business";
  other_name?: string | null;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CONSEQUENCE: Record<DeadlineKind, Record<DeadlineAudience["side"], (o: string) => string>> = {
  accept: {
    creator: (o) => `If you don't accept by then, the booking is cancelled, the hold on ${o}'s card is released and nothing is charged.`,
    business: (o) => `If ${o} doesn't accept by then, the booking is cancelled, the hold on your card is released and nothing is charged.`,
  },
  review: {
    creator: (o) => `If ${o} doesn't approve or ask for changes by then, the work is accepted automatically, the job closes and you are paid after a 10 day buffer.`,
    business: (o) => `If you don't approve or ask for changes by then, the work is accepted automatically, the job closes and ${o} is paid after a 10 day buffer.`,
  },
  due: {
    creator: (o) => `This is the delivery date agreed on the order. If you don't send a draft within 3 days after it, the job is cancelled and ${o} is refunded in full.`,
    business: (o) => `This is the delivery date agreed on the order. If ${o} doesn't send a draft within 3 days after it, the job is cancelled and you are refunded in full.`,
  },
  no_show_grace: {
    creator: (o) => `If you don't send a draft by then, the job is cancelled, ${o} is refunded in full and you get a missed deadline mark.`,
    business: (o) => `If ${o} doesn't send a draft by then, the job is cancelled, you are refunded in full and ${o} gets a missed deadline mark.`,
  },
  cancel_response: {
    creator: (o) => `If you don't answer by then, the job is cancelled and ${o} is refunded to the card in full, including the 10% Zavi fee.`,
    business: (o) => `If ${o} doesn't answer by then, the job is cancelled and you are refunded to your card in full, including the 10% Zavi fee.`,
  },
  offer_expiry: {
    creator: (o) => `If ${o} doesn't pay by then, the offer expires, nothing is charged and you have no job to do.`,
    business: () => `If you don't pay for the offer by then, it expires and nothing is charged.`,
  },
  checkout_expiry: {
    creator: (o) => `If ${o} doesn't finish the payment by then, no job is started for you and nothing is charged.`,
    business: () => `If you don't finish the payment by then, no job is started and nothing is charged.`,
  },
};

function otherName(a: DeadlineAudience): string {
  const n = (a.other_name ?? "").trim();
  if (n) return n;
  return a.side === "creator" ? "the business" : "the creator";
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatUtc(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year} at ${hh}:${mm} UTC`;
}

export function deadlineCopy(
  kind: DeadlineKind,
  deadlineAt: string | Date,
  audience: DeadlineAudience,
): DeadlineCopy {
  const d = deadlineAt instanceof Date ? deadlineAt : new Date(deadlineAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`deadlineCopy: '${String(deadlineAt)}' is not a valid date.`);
  }
  const bySide = CONSEQUENCE[kind];
  if (!bySide) {
    throw new Error(`deadlineCopy: unknown deadline kind '${String(kind)}'.`);
  }
  const consequence_text = capitalise(bySide[audience.side](otherName(audience)));
  const deadline_text = formatUtc(d);
  return {
    kind,
    deadline_at: d.toISOString(),
    deadline_text,
    consequence_text,
    line: `Deadline: ${deadline_text}. ${consequence_text}`,
  };
}

export function dueAfterAcceptText(days: number, audience: DeadlineAudience): string {
  const who = audience.side === "creator" ? "you accept" : `${otherName(audience)} accepts`;
  return `${days} ${days === 1 ? "day" : "days"} after ${who}`;
}
