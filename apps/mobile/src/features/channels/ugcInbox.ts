
import {
  firstName,
  formatCents,
  messageStamp,
  jobRow,
  jobStatusLabel,
  type JobSummary,
  type LaneRow,
  type Notice,
  type ThreadSummary,
} from "./ugc";
import type { Tone } from "./ugcLibrary";

const JOB_TONE: Record<string, Tone> = {
  checkout_pending: "neutral",
  awaiting_acceptance: "info",
  in_progress: "info",
  submitted: "warn",
  revision_requested: "warn",
  cancel_requested: "warn",
  in_dispute: "bad",
  completed: "ok",
  cancelled: "neutral",
};

export function jobSourceLabel(source: JobSummary["source"]): string {
  return source === "applicant" ? "Hired from a brief" : source === "offer" ? "Custom offer" : "Booked package";
}

export type JobListRow = {
  id: string;
  title: string;
  total: string;
  status: string;
  tone: Tone;
  sub: string;
  moneyLine: string | null;
  deadline: string | null;
};

export function jobListRow(j: JobSummary): JobListRow {
  const m = j.money;
  const cur = m.currency || "usd";
  const label = m.business_fee_label ? ` (${m.business_fee_label})` : "";
  const moneyLine =
    typeof m.price_cents === "number" && typeof m.business_fee_cents === "number"
      ? `${formatCents(m.price_cents, cur)} to the creator plus ${formatCents(m.business_fee_cents, cur)} Zavi fee${label}.`
      : null;
  return {
    id: j.id,
    title: j.title || "Creator job",
    total: formatCents(m.business_total_cents, cur),
    status: jobStatusLabel(j),
    tone: JOB_TONE[j.status] ?? "neutral",
    sub: `${j.creator_display_name ? `${j.creator_display_name} · ` : ""}${jobSourceLabel(j.source)}`,
    moneyLine,
    deadline: j.deadline?.line ? j.deadline.line : null,
  };
}

const DRAWERS = new Set(["find", "hire", "applicants", "brief", "thread", "review", "job", "inbox"]);

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export function drawerOfLink(link: string | null | undefined): { name: string; params: Record<string, string> } | null {
  if (!link) return null;
  const noHash = link.split("#")[0] ?? "";
  const q = noHash.indexOf("?");
  const rawPath = q >= 0 ? noHash.slice(0, q) : noHash;
  const path = rawPath.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/";
  const params: Record<string, string> = {};
  if (q >= 0) {
    for (const part of noHash.slice(q + 1).split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = decode(eq >= 0 ? part.slice(0, eq) : part);
      const v = decode(eq >= 0 ? part.slice(eq + 1) : "");
      if (k && !(k in params)) params[k] = v;
    }
  }
  const name = params.drawer;
  if (path !== "/workspace" || !name || !DRAWERS.has(name)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (k !== "drawer" && v) out[k] = v;
  return { name, params: out };
}

export type InboxJob = { job: JobSummary; row: LaneRow };
export type InboxNotice = Pick<Notice, "id" | "link_path" | "read_at">;

export type CreatorEntry = {
  memberId: string;
  name: string;
  thread: ThreadSummary | null;
  jobs: InboxJob[];
  unread: string[];
  needsYou: boolean;
  lastAt: string;
};

const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function buildCreatorInbox(threads: readonly ThreadSummary[], jobs: readonly JobSummary[], notices: readonly InboxNotice[]): CreatorEntry[] {
  const by = new Map<string, CreatorEntry>();
  const entry = (id: string, name: string): CreatorEntry => {
    let e = by.get(id);
    if (!e) {
      e = { memberId: id, name, thread: null, jobs: [], unread: [], needsYou: false, lastAt: "" };
      by.set(id, e);
    }
    if (!e.name && name) e.name = name;
    return e;
  };
  const later = (a: string, b: string | null | undefined) => (b && b > a ? b : a);

  for (const t of threads) {
    const e = entry(t.human_member_id, t.display_name ?? "");
    e.thread = t;
    e.lastAt = later(e.lastAt, t.last_message_at);
  }
  const jobCreator = new Map<string, string>();
  for (const j of jobs) {
    if (!j.human_member_id) continue;
    const row = jobRow(j);
    if (!row) continue;
    const e = entry(j.human_member_id, j.creator_display_name ?? "");
    e.jobs.push({ job: j, row });
    e.lastAt = later(e.lastAt, j.closed_at ?? j.created_at);
    jobCreator.set(j.id, j.human_member_id);
  }
  for (const n of notices) {
    if (n.read_at || !n.link_path) continue;
    const d = drawerOfLink(n.link_path);
    const id = d?.params.creator ?? (d?.params.job ? jobCreator.get(d.params.job) : undefined);
    const e = id ? by.get(id) : undefined;
    if (e && !e.unread.includes(n.id)) e.unread.push(n.id);
  }

  const out = [...by.values()];
  for (const e of out) {
    e.jobs.sort((a, b) => Number(a.row.done) - Number(b.row.done) || desc(a.job.created_at, b.job.created_at));
    e.needsYou = e.unread.length > 0 || e.jobs.some((j) => j.row.tone === "action" && !j.row.done);
    if (!e.name) e.name = "Creator";
  }
  return out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || desc(a.lastAt, b.lastAt));
}

export type InboxFilterKey = "all" | "needs_you" | "working" | "finished";

export const INBOX_FILTERS: ReadonlyArray<{ key: InboxFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs_you", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "finished", label: "Finished work" },
];

export function inboxMatches(e: CreatorEntry, key: InboxFilterKey): boolean {
  switch (key) {
    case "needs_you":
      return e.needsYou;
    case "working":
      return e.jobs.some((j) => !j.row.done);
    case "finished":
      return e.jobs.some((j) => j.row.done && j.job.status === "completed");
    default:
      return true;
  }
}

export function filterCounts(entries: readonly CreatorEntry[]): Record<InboxFilterKey, number> {
  const out = { all: 0, needs_you: 0, working: 0, finished: 0 } as Record<InboxFilterKey, number>;
  for (const f of INBOX_FILTERS) out[f.key] = entries.filter((e) => inboxMatches(e, f.key)).length;
  return out;
}

export type InboxScreen =
  | { kind: "loading"; banner: string | null }
  | { kind: "empty"; banner: string | null; text: string | null }
  | { kind: "list"; banner: string | null; shown: CreatorEntry[] };

export function inboxScreen(entries: CreatorEntry[] | null, error: string | null, filter: InboxFilterKey): InboxScreen {
  const banner = error ? `Some of this did not load: ${error}` : null;
  if (!entries) return error ? { kind: "empty", banner, text: null } : { kind: "loading", banner: null };
  if (entries.length === 0) return { kind: "empty", banner, text: error ? null : "No creators yet. Message or book one from Find creators and they show here." };
  const shown = entries.filter((e) => inboxMatches(e, filter));
  if (shown.length === 0) return { kind: "empty", banner, text: "Nobody in this view right now." };
  return { kind: "list", banner, shown };
}

export function inboxSubLine(e: Pick<CreatorEntry, "jobs">): string {
  const n = e.jobs.length;
  if (n === 0) return "No jobs yet";
  const k = e.jobs.filter((j) => j.row.done && j.job.status === "completed").length;
  return `${n} ${n === 1 ? "job" : "jobs"}${k ? ` · ${k} finished` : ""}`;
}

export { messageStamp };

export function lastMessage(e: Pick<CreatorEntry, "thread" | "name">, now: Date = new Date()): { who: string; body: string; stamp: string } | null {
  const last = e.thread?.last_message;
  if (!last) return null;
  return { who: last.sender_kind === "tenant" ? "You:" : `${firstName(e.name)}:`, body: last.body, stamp: messageStamp(last.created_at, now) };
}

export const NO_MESSAGES = "No messages yet.";

export function reviewJob(e: Pick<CreatorEntry, "jobs">): InboxJob | null {
  return e.jobs.find((j) => !j.row.done && j.job.status === "submitted") ?? null;
}

export function laneTone(t: LaneRow["tone"]): Tone {
  return t === "open" ? "ok" : t === "action" ? "warn" : "neutral";
}

const INVITE_PREFIX = "invite:";

export function inviteUuidOf(memberId: string): string | null {
  if (!memberId.startsWith(INVITE_PREFIX)) return null;
  const id = memberId.slice(INVITE_PREFIX.length);
  return id ? id : null;
}

export function inviteMessagesPath(memberId: string): string | null {
  const id = inviteUuidOf(memberId);
  return id ? `/api/creators/invites/${encodeURIComponent(id)}/messages` : null;
}

export function threadFirst(knownName: string | null | undefined): string {
  const n = knownName?.trim();
  return n ? firstName(n) : "the creator";
}

export function threadInfoLine(invite: boolean, first: string): string {
  return invite
    ? `${first} is not on Zavi yet. Your first message sends them an email to join and read it; later ones wait until they do.`
    : "Each new message or offer emails the other side, at most one email per conversation every 15 minutes.";
}

export function threadEmptyLine(invite: boolean, first: string): string {
  return invite
    ? `No messages with ${first} yet. Say hello: they get an email to join and read it.`
    : `No messages with ${first} yet. Say hello, or send a custom offer below.`;
}

export function inviteOffersNote(first: string): string {
  return `Custom offers and booking open once ${first} joins Zavi. This conversation moves with them when they do.`;
}
