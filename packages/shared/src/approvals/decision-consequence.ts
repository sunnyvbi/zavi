
export type DecisionConsequence = { approve: string; reject: string };

export const GENERIC_CONSEQUENCE: DecisionConsequence = {
  approve: "Approves this and lets the agent proceed.",
  reject: "Declines this — the agent won't proceed. Any draft is kept.",
};

export const CLASS_CONSEQUENCE: Record<string, DecisionConsequence> = {
  "operator_db.unreachable": {
    approve: "Hides this card. It also clears itself once Zavi can read your database again.",
    reject: "Hides this card. Nothing else changes.",
  },
  "growth-lead.suggestion": {
    approve:
      "Accepts and records this growth recommendation. It does not change Meta Ads automatically.",
    reject: "Archives this recommendation. Nothing changes in Meta Ads.",
  },
  "dispute-response.submit-evidence": {
    approve:
      "Saves the evidence as a draft on Stripe. It is not submitted yet; a second approval (Submit for review) files it.",
    reject: "No draft is saved.",
  },
  "dispute-response.final-submit-evidence": {
    approve:
      "Submits the evidence to Stripe for review and closes the dispute to further changes.",
    reject: "The evidence is not submitted.",
  },
  "social.publish.v2": {
    approve: "Publishes the post now to the connected social account.",
    reject: "Nothing is published — the draft is kept.",
  },
  "bulk_outbound.send": {
    approve: "Sends nothing. Bulk email is not switched on yet, so no one on the list gets this message.",
    reject: "Nothing is sent — the draft is kept.",
  },
};

export const BULK_SEND_FOOTNOTE = "Each email includes an unsubscribe link and your address.";

export function isBulkListSend(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as { list_version_id?: unknown }).list_version_id === "string" &&
    (body as { list_version_id: string }).list_version_id.length > 0
  );
}

function bulkText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function bulkPeople(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
}

export function bulkSendConsequence(body: unknown, opts: { names?: boolean } = {}): DecisionConsequence | null {
  if (!isBulkListSend(body)) return null;
  const b = body as Record<string, unknown>;
  const count = typeof b.est_recipient_count === "number" && b.est_recipient_count >= 0 ? b.est_recipient_count : null;
  const names = opts.names !== false;
  const list = names ? bulkText(b.list_name) : null;
  const from = names ? bulkText(b.from_address) : null;
  const who = count === null ? "everyone" : bulkPeople(count);
  return {
    approve:
      (names
        ? `Sends this email to ${who}${list ? ` on ${list}` : ""}${from ? ` from ${from}` : ""}. `
        : `Sends this email to ${who} on the list shown below, from the address shown below. `) +
      `One email per person. ${BULK_SEND_FOOTNOTE}`,
    reject: "Nothing is sent — the draft is kept.",
  };
}

export function bulkSendTitle(body?: unknown): string {
  if (body === undefined || body === null) return "Bulk email";
  return isBulkListSend(body) ? "Send a bulk email" : "Bulk email draft (not sent)";
}

export function bulkSendCardFields(body: unknown): Array<{ label: string; value: string }> | null {
  if (!isBulkListSend(body)) return null;
  const b = body as Record<string, unknown>;
  const t = (b.template && typeof b.template === "object" ? b.template : {}) as Record<string, unknown>;
  const count = typeof b.est_recipient_count === "number" ? b.est_recipient_count : null;
  const skipped = typeof b.will_be_skipped === "number" && b.will_be_skipped > 0 ? b.will_be_skipped : 0;
  const capped = typeof b.capped_at === "number" && b.capped_at > 0 ? b.capped_at : null;
  const sample = Array.isArray(b.sample_recipients)
    ? b.sample_recipients.filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];
  const message = bulkText(t.body_text);
  const people =
    count === null
      ? null
      : bulkPeople(count) +
        (capped ? `. The list is longer: one send reaches at most ${capped.toLocaleString("en-US")}` : "") +
        (skipped ? `. ${skipped.toLocaleString("en-US")} already unsubscribed or bounced and will be skipped` : "");
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | null) => {
    if (value) out.push({ label, value });
  };
  add("Subject", bulkText(t.subject) ?? "(empty)");
  add("Message", message ?? "(empty)");
  add("From", bulkText(b.from_address));
  add("Replies go to", bulkText(b.reply_to) ?? bulkText(b.from_address));
  add("List", bulkText(b.list_name));
  add("People", people);
  add("For example", sample.length ? sample.join(", ") : null);
  add("Included", BULK_SEND_FOOTNOTE);
  return out;
}
