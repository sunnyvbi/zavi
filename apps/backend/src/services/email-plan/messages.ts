
import { KLAVIYO_KEY_INSTRUCTION } from "@/services/connectors/email-campaign/klaviyo-scopes";
import { KEY_REJECTED_WHY, RECONNECT_ANY_EMAIL_TOOL, REDRAFT_AFTER_RECONNECT } from "@/services/connectors/email-campaign/provider-errors";
import { EMAIL_TOOL_LABEL } from "@/services/connectors/email-campaign/providers";

export const LIST_GONE_SENTENCE = "The list you picked is gone. Pick another list and try again.";

export const PLAN_REFUSALS: Readonly<Record<string, string>> = {
  bad_request: "That plan was not complete. Name the list, the day and time, and the angle.",
  bad_time: "That day or time is not valid. Use a date like 2026-10-20 and a time like 09:30.",
  bad_timezone: "Zavi could not read the workspace's time zone, so nothing was planned.",
  nonexistent_time: "That time does not exist on the workspace's clock that day (the clocks go forward). Pick another time.",
  too_soon: "An email is planned at least 26 hours ahead, so Zavi can draft it the day before. To send sooner, ask for a new email now.",
  move_too_soon: "A planned email can move to at least 1 hour from now. To send sooner, use Send now on its draft.",
  too_far: "An email is planned at most 14 days ahead.",
  week_full: "That week already has 3 planned emails, the most a week holds.",
  list_spacing: "That list already has an email planned within 7 days of that time. One email per list per 7 days.",
  list_sent_recently: "That list got (or is getting) an email within the 7 days before that time. One email per list per 7 days.",
  test_list: "That list is marked as a test list, so Zavi does not plan a real email to it.",
  list_not_found: "That list was not found in this workspace.",
  list_not_consented: "Nobody has confirmed consent for that list's latest import yet, so it cannot be emailed.",
  not_authorized: "Only an owner or admin can change the plan.",
  not_found: "That planned email was not found.",
  plan_changed: "This plan changed in the meantime. Reload it and try again.",
  not_movable: "This email can no longer be moved: it is sending, sent or skipped.",
  not_changeable: "This email can no longer be changed: it is sending, sent or skipped.",
  angle_too_late: "The planned time is under an hour away, too close for Zavi to write a new draft. Move the email later first, or keep this draft.",
  draft_running: "Zavi is writing this draft right now. Try again once it has finished.",
  draft_tries_used: "Zavi has already tried to draft this email 3 times. Skip it, or ask Zavi for a new email.",
  redraft_scheduled: "This email is approved for its planned time. Use Don't send in Coming up first, then ask for the change.",
  not_skippable: "This email can no longer be skipped.",
  not_draftable: "This email already has a draft, or its time has passed.",
  not_ready: "There is no draft to approve yet.",
  too_late: "The planned time is too close. Approve and send now instead.",
  not_withdrawable: "There is nothing to stop: it is not approved for a later time.",
  not_open: "This draft has already been decided.",
  test_required: "Send yourself a test of this version first. Approve unlocks once an owner or admin has the test.",
  bad_variant: "That version does not exist on this email.",
  count_required: "Zavi could not count the people on the list right now. Try again in a minute.",
  tool_key_rejected: `Your email tool rejected the key Zavi has saved for it ${KEY_REJECTED_WHY}, so nothing was scheduled. Waiting will not fix this: go to Connectors, disconnect the tool, then ${RECONNECT_ANY_EMAIL_TOOL}. ${REDRAFT_AFTER_RECONNECT} ${KLAVIYO_KEY_INSTRUCTION}`,
  redraft_required: "Ask Zavi to draft this email again.",
  plan_writes_suppressed: "This run cannot change the plan.",
  plan_unreadable: "Zavi could not read the email plan right now, so nothing was changed. Try again.",
  plan_run_drafts_only: "This run drafts one planned email. It cannot change the plan.",
  plan_run_plans_only: "This run plans emails. It does not write or propose one: Zavi drafts each planned email the day before.",
  wrong_list: "This planned email goes to a different list. Draft it for the planned list only.",
  email_tool_not_connected: "That email tool is not connected for this workspace.",
  email_tool_ambiguous: "Name the email tool: more than one is connected.",
  email_tool_read_failed: "The email tool could not be read right now, so nothing was planned. Try again.",
  still_sending: "Zavi is still sending or checking this email. Try again once it has finished.",
  mail_left: "Your email tool was seen sending this campaign to a different list, so it cannot be marked as not sent. Check it in your email tool.",
  zavi_sending: "Zavi sent this from your Zavi list itself, so its own records decide, not your email tool. Zavi's team is told when a send stays stuck for a day.",
};

export const SKIP_REASONS: Readonly<Record<string, string>> = {
  vetoed: "You said don't send.",
  paused: "Email was paused at its planned time, so it did not go out. Resume email in Email campaigns settings before sending it.",
  no_draft: "Zavi could not draft it in time.",
  list_archived: "The list was archived, so Zavi did not draft or send this email.",
  not_approved_in_time: "Not approved by the planned time. The draft is still there.",
  audience_over_limit: "Not approved by the planned time, and the list is over 1,000 people, more than Autopilot sends to. The draft is still there.",
  audience_empty: "Not approved by the planned time, and the list had nobody on it, so Autopilot did not send it. The draft is still there.",
  list_sent_recently: "Another email went to this list within 7 days, so this one did not go. The draft is still there.",
  changed_after_approval: "The draft changed after it was approved for this time. Approve it again to send it.",
  approver_gone: "The person who approved it is no longer an owner or admin here. Approve it again to send it.",
  member_edit_untested: "A member edited the draft, so Autopilot did not send it on its own. An owner or admin sends themselves a test of version 1, then approves it to send it.",
  test_list: "The list is marked as a test list.",
  skipped_by_founder: "Skipped.",
  card_rejected: "The draft was rejected.",
  cgo_email_sent_recently: "Autopilot already emailed this list within 7 days. The draft is still there.",
  not_sent_confirmed: "You checked your email tool: it was not sent.",
  may_have_sent: "Zavi could not tell whether this went out. Check your email tool.",
  outcome_unknown: "Zavi could not tell whether this went out. Check your email tool.",
};

export function planRefusal(code: string): string {
  return PLAN_REFUSALS[code] ?? "That could not be done.";
}

export const DRAFT_BLOCKED_PREFIX = "draft_blocked:";

export const DRAFT_BLOCKED_FALLBACK = "Zavi could not draft this email, and trying again will not fix it. Skip it, or ask Zavi for a new email.";

export type DraftBlockedFix = "draft_now" | "change_topic";

const DRAFT_BLOCKED_FIXES: Readonly<Record<string, DraftBlockedFix>> = {
  email_campaign_body_invalid: "draft_now",
  channel_action_class_unknown: "draft_now",
  channel_card_already_done: "change_topic",
  channel_card_already_rejected: "change_topic",
};

export function draftBlockedFix(statusReason: string | null | undefined): DraftBlockedFix | null {
  if (!statusReason?.startsWith(DRAFT_BLOCKED_PREFIX)) return null;
  const code = statusReason.slice(DRAFT_BLOCKED_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(DRAFT_BLOCKED_FIXES, code) ? DRAFT_BLOCKED_FIXES[code] : null;
}

export function draftBlockedReason(code: string, route?: string | null): string | null {
  const label = route && Object.prototype.hasOwnProperty.call(EMAIL_TOOL_LABEL, route) ? EMAIL_TOOL_LABEL[route as keyof typeof EMAIL_TOOL_LABEL] : null;
  const tool = label ?? "your email tool";
  const Tool = label ?? "Your email tool";
  const account = label ? `your ${label} account` : "your email tool";
  switch (code) {
    case "email_audience_missing":
    case "list_not_found":
      return `The list isn't in ${account} any more, so Zavi could not draft this email. Skip it, and plan one to a list you still have.`;
    case "email_tool_not_connected":
      return `${Tool} is not connected any more, so Zavi could not draft this email. Connect it in Connectors, then plan the email again.`;
    case "tool_key_rejected":
      return `${Tool} rejected the key Zavi has saved for it, so Zavi could not draft this email. In Connectors, disconnect it and connect it again, then plan the email again.`;
    case "email_test_list":
      return "The list is marked as a test list, so Zavi does not draft a real email to it.";
    case "email_audience_empty":
    case "list_empty":
      return "The list has nobody on it, so Zavi did not draft this email.";
    case "email_sender_unknown":
      return `Zavi could not tell who this email would come from in ${tool}, so it did not draft it. Set a sender there, then plan the email again.`;
    case "list_archived":
      return SKIP_REASONS.list_archived;
    case "list_not_consented":
      return "Nobody has confirmed consent for that list's latest import yet, so Zavi did not draft this email.";
    case "channel_card_already_done":
      return "You already approved a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it.";
    case "channel_card_already_rejected":
      return "You turned down a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it.";
    case "email_campaign_body_invalid":
    case "channel_action_class_unknown":
      return "Zavi could not file the draft. Try Draft now again.";
    case "email_render_missing_postal_address":
      return "Your business postal address is missing, so Zavi did not draft this email. Add it in Email campaigns settings, then plan the email again.";
    case "email_render_bad_font":
    case "email_render_bad_color":
      return "Your saved email template has a setting Zavi cannot use, so it did not draft this email. Fix it in Email campaigns settings, then plan the email again.";
    case "zavi_list_not_ready":
      return "Your Zavi list is not ready to send from yet, so Zavi did not draft this email. Finish sending setup in Email campaigns settings.";
    default:
      return null;
  }
}
