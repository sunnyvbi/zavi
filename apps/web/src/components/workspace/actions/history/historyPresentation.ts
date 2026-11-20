import { formatDate } from "@/lib/formatDate";
import { lockedTypeLabel } from "@/lib/workspace/channelActionsApi";
import { AUDIENCE_SAVED_PREFIX } from "../audienceReview";
import type { ChannelClosedRow, ChannelHistory, PreSwitchRow } from "../useChannelHistory";
import type { EmailResultCounts } from "@/components/email/EmailCampaignCard";
import { STOPPED_REST_LINE, stoppedAfter } from "@/components/email/sendOutcomeCopy";
import { approverWho } from "../statusWords";

export type HistoryItem = { source: "action"; row: ChannelClosedRow } | { source: "previous"; row: PreSwitchRow };
export type HistoryTone = "success" | "danger" | "neutral";
export interface HistoryLog { id: string; at: string | null; text: string; failed: boolean; }

const STATUS: Record<ChannelClosedRow["status"], string> = {
  acted: "Done", rejected: "Rejected", redone: "Redone", stale: "Went stale", displaced: "Outranked",
};
const RUN_STATUS: Record<string, string> = {
  success: "Finished", queued: "Waiting to start", running: "Running", blocked: "Waiting on you",
  failed: "Failed", cancelled: "Cancelled", parse_failed: "Failed", dispatch_error: "Failed to start",
};
const TRIGGER: Record<string, string> = {
  channel_recipe: "channel run", manual: "you ran it", chat: "from chat", cron: "on schedule",
  scheduled: "on schedule", schedule: "on schedule", handoff: "handed over by another agent",
  slack: "from Slack", email: "from email", webhook: "from a webhook", playbook: "from a playbook",
};

export const historyDate = (value: string | null, format: "short" | "dateTime" = "short") => formatDate(value, "en-US", "UTC", format);
export const historyTitle = (item: HistoryItem) => item.row.title ?? "Untitled item";
export const savedAudienceLines = (note: string | null | undefined): string[] | null =>
  note?.startsWith(AUDIENCE_SAVED_PREFIX) ? note.split(/(?<=\.)\s+(?=[A-Z])/).map((line) => line.trim()).filter(Boolean) : null;
const closedByYou = (row: ChannelClosedRow) => row.status === "rejected" && !row.note?.trim();
export const historyStatus = (item: HistoryItem) => item.source === "action" ? closedByYou(item.row) ? "Closed" : STATUS[item.row.status] : "Archived";
export const historyStamp = (item: HistoryItem) => item.source === "action" ? item.row.status_at ?? item.row.proposed_at : item.row.archived_at ?? item.row.emitted_at;
export const historyTone = (item: HistoryItem): HistoryTone => item.source === "action" ? item.row.status === "acted" ? "success" : item.row.status === "rejected" && !closedByYou(item.row) ? "danger" : "neutral" : "neutral";
export type HistoryKindContext = { email?: boolean; listName?: string | null };
export function historyKind(item: HistoryItem, context: HistoryKindContext = {}): string {
  if (item.source === "previous") return "Earlier item";
  if (context.email && item.row.action_type === "send_message") return context.listName ? `Email to ${context.listName}` : "Email";
  return lockedTypeLabel(item.row.action_type);
}

const APPLIED: Partial<Record<ChannelClosedRow["action_type"], string>> = {
  create_ad: "Zavi created it", pause_ad: "Zavi paused it", update_ad: "Zavi made the change",
};

const SENT_TOOL: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo", zavi_list: "Zavi" };

function sentWhen(at: string | null): string | null {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

export function onTheListPhrase(name: string | null | undefined): string {
  const n = name?.trim();
  if (!n) return "";
  return /(^|\s)list$/i.test(n) ? ` on the ${n}` : ` on the ${n} list`;
}

function sentLabel(sent: NonNullable<ChannelClosedRow["sent"]>): string {
  const n = sent.count;
  const who = typeof n === "number" ? ` to ${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}` : "";
  const list = onTheListPhrase(sent.list);
  const tool = sent.tool ? ` via ${SENT_TOOL[sent.tool] ?? sent.tool}` : "";
  if (sent.stopped) return `${stoppedAfter(typeof n === "number" ? n : null)}${list}${tool}`;
  return `Sent${who}${list}${tool}`;
}

export function historyReceipt(item: HistoryItem): { line: string; url: string | null } | null {
  if (item.source !== "action" || item.row.status !== "acted" || !item.row.receipt?.line) return null;
  const url = item.row.receipt.url;
  return { line: item.row.receipt.line, url: typeof url === "string" && /^https:\/\//i.test(url) ? url : null };
}

export function historyTimeline(item: HistoryItem): Array<{ label: string; at: string | null; when?: string | null }> {
  if (item.source === "previous") return [
    { label: "Zavi suggested it", at: item.row.emitted_at },
    { label: "Archived when this channel moved store", at: item.row.archived_at },
  ];
  const sent = item.row.status === "acted" ? item.row.sent : undefined;
  if (sent) return [
    { label: "Zavi suggested it", at: item.row.proposed_at },
    { label: sentLabel(sent), at: sent.at ?? item.row.status_at, when: sentWhen(sent.at ?? item.row.status_at) },
  ];
  const { approval, executed_at } = item.row;
  const receipt = historyReceipt(item);
  if (receipt) return [
    { label: "Zavi suggested it", at: item.row.proposed_at },
    ...(approval ? [{ label: `${approverWho(approval.by, approval.name)} approved it`, at: approval.at }] : []),
    { label: receipt.line.replace(/\.$/, ""), at: item.row.status_at },
  ];
  if (item.row.status === "acted" && (approval || executed_at !== undefined)) return [
    { label: "Zavi suggested it", at: item.row.proposed_at },
    ...(approval ? [{ label: `${approverWho(approval.by, approval.name)} approved it`, at: approval.at }] : []),
    { label: APPLIED[item.row.action_type] ?? "Zavi made the change", at: executed_at ?? item.row.status_at },
  ];
  return [
    { label: "Zavi suggested it", at: item.row.proposed_at },
    { label: item.row.status === "acted" ? (savedAudienceLines(item.row.note) ? AUDIENCE_SAVED_PREFIX : "Marked as done") : closedByYou(item.row) ? "You closed it" : STATUS[item.row.status], at: item.row.status_at },
  ];
}

export type HistoryResults = { label: string; counts: EmailResultCounts }[];
const HOUR_MS = 3_600_000;
export const NO_RESULTS_LINE = "Measured results are not available for this item.";
const WAITING_LINE = "Results come in 1 hour after the send and again at day 7.";
const HOUR_PASSED_LINE = "The 1 hour numbers are not in yet.";

function hasResultLines(c: EmailResultCounts | null | undefined): c is EmailResultCounts {
  if (!c) return false;
  return [c.delivered, c.opens, c.clicks, c.bounces].some((n) => typeof n === "number") || (c.unsubscribes ?? 0) > 0 || Object.values(c.why ?? {}).some(Boolean);
}

function resultsOutcome(sent: NonNullable<ChannelClosedRow["sent"]>, now: number): { title: string; text: string; results?: HistoryResults } {
  const title = "What it brought";
  const results: HistoryResults = [];
  if (hasResultLines(sent.hour_1)) results.push({ label: "After 1 hour:", counts: sent.hour_1 });
  if (hasResultLines(sent.day_7)) results.push({ label: "At day 7:", counts: sent.day_7 });
  if (results.length > 0) return { title, text: "", results };
  const at = sent.at ? Date.parse(sent.at) : NaN;
  return { title, text: Number.isFinite(at) && now >= at + HOUR_MS ? HOUR_PASSED_LINE : WAITING_LINE };
}

export function historyOutcome(item: HistoryItem, now: number = Date.now()): { title: string; text: string; results?: HistoryResults } {
  if (item.source === "previous") return { title: "What happens now", text: "This item is kept read-only from before this channel moved store. It cannot be approved or restored from here." };
  if (item.row.status === "stale" || item.row.status === "displaced") return { title: "What happens now", text: "This suggestion is no longer current. It cannot be restored from history." };
  if (closedByYou(item.row)) return { title: "What happens next", text: "Nothing runs. Zavi may suggest it again if it still matters." };
  if (item.row.status === "rejected") return { title: "Decision", text: "This suggestion was rejected." };
  if (item.row.status === "redone") return { title: "What happens now", text: "A new version was requested for this suggestion." };
  if (item.row.status === "acted" && item.row.sent?.stopped) return { title: "What happened", text: item.row.sent.note ?? STOPPED_REST_LINE };
  if (item.row.status === "acted" && item.row.sent) return item.row.sent.tool === "zavi_list" ? { title: "What it brought", text: WAITING_LINE } : resultsOutcome(item.row.sent, now);
  return { title: "What it brought", text: NO_RESULTS_LINE };
}

export function historyLogs(history: ChannelHistory): HistoryLog[] {
  return history.runs.flatMap((run) => {
    const trigger = TRIGGER[run.trigger] ?? run.trigger.replace(/_/g, " ");
    const status = RUN_STATUS[run.status] ?? run.status.replace(/_/g, " ");
    const failed = !["success", "queued", "running", "blocked", "cancelled"].includes(run.status);
    const rows: HistoryLog[] = [];
    if (run.enqueued_at) rows.push({ id: `${run.run_id}:queued`, at: run.enqueued_at, text: `${run.redo_of_action_id ? "Redo queued" : "Run queued"} · ${trigger}`, failed: false });
    if (run.started_at) rows.push({ id: `${run.run_id}:started`, at: run.started_at, text: "Run started", failed: false });
    if (run.finished_at || !rows.length || run.status !== "queued") rows.push({ id: `${run.run_id}:status`, at: run.finished_at, text: `${status} · ${trigger}`, failed });
    return rows;
  }).sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0));
}

export function currentHistoryItem(item: HistoryItem | null, history: ChannelHistory): HistoryItem | null {
  if (!item) return null;
  if (item.source === "action") {
    const row = history.closed.find((row) => row.id === item.row.id);
    return row ? { source: "action", row } : null;
  }
  const row = history.pre_switch.find((row) => row.run_id === item.row.run_id && row.position === item.row.position && row.emitted_at === item.row.emitted_at);
  return row ? { source: "previous", row } : null;
}
