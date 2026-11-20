
import type { SendCounts } from "./store";

export type BulkSendState = "more" | "waiting_for_tomorrow" | "held" | "done" | "failed";

const n = (v: number) => v.toLocaleString("en-US");
const people = (v: number) => `${n(v)} ${v === 1 ? "person" : "people"}`;

export const HOLD_SENTENCES: Record<string, string> = {
  bulk_outbound_disabled: "bulk email was switched off for this workspace",
  bulk_sending_paused: "Zavi's own sender was stopped for every workspace",
  bulk_sender_not_configured: "bulk email is not set up",
  sending_domain_not_verified: "your sending domain is no longer verified",
  sending_domain_changed: "your sending address changed after this was approved, so ask the agent to propose it again",
  postal_address_missing: "your business postal address is missing from Email campaigns settings",
  postal_address_placeholder: "your business postal address in Email campaigns settings is still a placeholder",
  workspace_closed: "this workspace is closed",
  list_not_found: "the contact list no longer exists",
  list_archived: "the contact list was archived",
  list_not_consented: "the list's consent is no longer on record",
  bulk_check_failed: "we could not check that it was still safe to send",
  bulk_abuse_hold: "bulk email is paused for this workspace after spam reports or bounces",
  provider_refused: "the email provider refused to send from your domain",
  abuse_complaints: "too many people marked this email as spam",
  abuse_bounces: "too many of these addresses bounced",
  email_paused: "email is paused for this workspace, and it picks up again when you resume email",
  stopped: "you stopped it",
  fanout_stalled: "Zavi's sender stopped making progress and could not restart it",
  sending_address_not_verified: "your sending address isn't verified with the email provider any more",
};

export const SENDING_ADDRESS_NOT_VERIFIED =
  "Your sending address isn't verified with the email provider any more. Re-check the sending domain in Settings. Nothing was sent.";

export function holdSentence(reason: string | null | undefined): string {
  return HOLD_SENTENCES[reason ?? ""] ?? "something stopped the send";
}

export const STAFF_ONLY_HOLDS: ReadonlySet<string> = new Set(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed"]);

const STAFF_RESUME = "Zavi will not email them unless Zavi staff resumes this send.";
const waitsOnStaff = (c: SendCounts) => c.pending > 0 && STAFF_ONLY_HOLDS.has(c.hold_reason ?? "");

const leftOut = (c: SendCounts) => c.left_out ?? c.skipped;

function leftOutSentence(count: number): string {
  return count > 0 ? ` ${people(count)} on this list ${count === 1 ? "was" : "were"} left out because they unsubscribed or bounced.` : "";
}

function extras(c: SendCounts): string {
  const parts: string[] = [];
  if (c.failed > 0) parts.push(`${n(c.failed)} could not be sent.`);
  if (c.unknown > 0) {
    parts.push(
      `${n(c.unknown)} could not be confirmed, so ${c.unknown === 1 ? "it was" : "they were"} not sent again.`,
    );
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function unconfirmedExtras(c: SendCounts): string {
  const parts: string[] = [];
  if (c.failed > 0) parts.push(`${n(c.failed)} could not be sent.`);
  parts.push(`${n(c.unknown)} could not be confirmed.`);
  return ` ${parts.join(" ")}`;
}

export function bulkSendLine(state: BulkSendState, c: SendCounts, daysLeft?: number, warmingUp = true): string {
  if (state === "done" && c.sent === 0) {
    if (c.unknown > 0) return `Not confirmed: these emails may have gone out. The email provider did not confirm any of them, so Zavi will not send this email again and nobody gets it twice.${unconfirmedExtras(c)}`;
    if (c.failed > 0 && leftOut(c) > 0) {
      return `Not sent: the email provider refused ${n(c.failed)} ${c.failed === 1 ? "email" : "emails"} and ${n(leftOut(c))} ${leftOut(c) === 1 ? "person was" : "people were"} skipped (unsubscribed or bounced), so nobody was emailed.`;
    }
    if (c.failed > 0) return `Not sent: the email provider refused every email, so nobody was emailed.`;
    return `Not sent: everyone on the list was skipped (unsubscribed or bounced), so nobody was emailed.`;
  }
  if (state === "held" && c.sent === 0 && c.unknown > 0) {
    return `Not confirmed: the send stopped because ${holdSentence(c.hold_reason)}, and the emails already handed to the provider may have gone out. The provider did not confirm any of them, so Zavi will not send them again.${waitsOnStaff(c) ? ` ${people(c.pending)} ${c.pending === 1 ? "was" : "were"} not emailed. ${STAFF_RESUME}` : ""}${unconfirmedExtras(c)}`;
  }
  if (state === "done") {
    return `Sent to ${n(c.sent)}.${leftOutSentence(leftOut(c))}${extras(c)}`;
  }
  if (state === "waiting_for_tomorrow") {
    const days = Math.max(1, daysLeft ?? 1);
    return (
      `Sent ${n(c.sent)} of ${n(c.total)}. The rest go out over the next ${days === 1 ? "day" : `${n(days)} days`}. ` +
      `${warmingUp ? "A new sending domain starts slowly so inboxes learn to trust it." : "Zavi sends only a set number of emails each day."} Zavi keeps sending by itself.${extras(c)}`
    );
  }
  if (state === "more") {
    return `Sent ${n(c.sent)} of ${n(c.total)} so far. The rest are going out now.${extras(c)}`;
  }
  if (state === "held") {
    const stopped = c.hold_reason === "stopped";
    const left = stopped ? Math.max(0, c.total - c.sent - c.failed - c.unknown) : c.pending;
    return (
      `Sent ${n(c.sent)} of ${n(c.total)}, then stopped: ${holdSentence(c.hold_reason)}. ` +
      `${left === 0 ? "Nobody else was waiting." : `${people(left)} ${left === 1 ? "was" : "were"} not emailed.`}${waitsOnStaff(c) ? ` ${STAFF_RESUME}` : ""}${extras(stopped ? c : { ...c, unknown: c.unknown + c.sending })}`
    );
  }
  if (c.hold_reason && c.hold_reason !== "provider_refused") return `Not sent: ${holdSentence(c.hold_reason)}, so nobody was emailed.`;
  return `Not sent: the email provider refused every email, so nobody was emailed.`;
}
