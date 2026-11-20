
import { CHANNELS, adChangeHeadline } from "@zavi/shared";

export const BLOCKER_NOTE_KEY = "cgo_blockers";

export const NOTE_SECTIONS = ["needs_you", "changed", "decided", "working_on", "blocked"] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];
export const SECTION_TITLES = {
  needs_you: "Needs you",
  changed: "What I changed",
  decided: "Decisions I made",
  would_change: "What I'd change",
  working_on: "Working on",
  blocked: "Blocked on Zavi",
} as const;

export type NoteItem = {
  section: NoteSection;
  text: string;
  reason?: string;
  usd_at_stake?: number;
  action_id?: string;
  chain_root_id?: string;
  channel_slug?: string;
  question_ordinal?: number;
  goal_id?: string;
  undoable?: boolean;
  waiting_since?: string;
  approved?: boolean;
  locations?: boolean;
  plans?: boolean;
  budget_from_usd?: number;
  budget_to_usd?: number;
  card_change?: string;
  title?: string;
  delivered?: boolean;
  making?: boolean;
  blocker_id?: string;
  blocker_severity?: "urgent" | "normal";
};

export type SectionRow = {
  line: string;
  url: string | null;
  question_ordinal?: number;
  item?: NoteItem;
  label?: string;
  group?: { channel_slug: string; count: number; lines: string[]; note: string | null; items: NoteItem[] };
  fold?: { count: number; items: NoteItem[] };
};
export type NoteSectionView = {
  key: NoteSection | "would_change";
  title: string;
  rows: SectionRow[];
  more: { count: number; url: string; line: string } | null;
};

export const VISIBLE_CARDS = 5;
export const GROUP_MIN = 3;
const GROUP_LINES = 5;
export const VISIBLE_PER_SECTION = 6;
const ACTION_MIN = 3;
export const ACTION_MAX = 60;
const HEADLINE_MIN = 10;
const HEADLINE_MAX = 140;
const REASON_MAX = 200;
const TITLE_MAX = 100;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SHORT = "(?=[0-9a-f]{0,7}[a-f])(?=[0-9a-f]{0,7}\\d)[0-9a-f]{8}";
const ID = `(?:${UUID}|${SHORT})`;
const DROP: RegExp[] = [
  /\s*[-–—|:·]?\s*zavi-(?:brief|card|run|job|action)-[0-9a-f]{6,}\b/gi,
  new RegExp(`\\s*(?:[—–-]\\s*)?(?:follow-up on|follow up on|repeat of|same as|see)\\s+\\[${ID}\\]`, "gi"),
  new RegExp(`\\s*\\((?:card|run|action|decision)\\s+${ID}\\)`, "gi"),
  new RegExp(`\\s*\\b(?:decision|action|run)\\s+id:?\\s*${ID}\\b`, "gi"),
  new RegExp(`\\s*\\[${ID}\\]`, "gi"),
  new RegExp(`\\s*\\b${UUID}\\b`, "gi"),
];
const KEEP_NOUN = new RegExp(`\\b(card|run|action|decision)\\s+${SHORT}\\b`, "gi");

export function stripInternalIds(s: string): string {
  let out = String(s ?? "");
  for (const re of DROP) out = out.replace(re, "");
  out = out.replace(KEEP_NOUN, "$1");
  return out
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?)”])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—|:,]+|[\s\-–—|:,]+$/g, "")
    .trim();
}

const noEnd = (s: string) => s.replace(/[.\s]+$/, "");
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const at = s.lastIndexOf(" ", max - 1);
  return `${s.slice(0, at > max * 0.5 ? at : max - 1).replace(/[\s,;:]+$/, "")}…`;
}

export const cleanTitle = (t: string) => noEnd(cut(stripInternalIds(String(t ?? "").replace(/\s+/g, " ")), TITLE_MAX));

const VERB_GROUPS: ReadonlyArray<[string, RegExp]> = [
  ["keep", /^(?:keep|keeping|leave|leaving|hold|holding|maintain|continue|continuing)\b/i],
  ["stop", /^(?:pause|pausing|stop|stopping|end|ending|turn off|turning off|disable|kill|shut)\b/i],
  ["start", /^(?:start|starting|resume|resuming|launch|launching|restart|enable|turn on|unpause)\b/i],
  ["down", /^(?:lower|lowering|decrease|decreasing|reduce|reducing|cut|cutting|trim|scale (?:down|back))\b/i],
  ["up", /^(?:raise|raising|increase|increasing|scale up|boost|double|grow)\b/i],
];
const LEAD_NOISE = /^(?:(?:i(?:'ll| will| would|'d)?|we(?:'ll| will)?|should i|let's|let me|please|proposal|recommend(?:ed|ation)?)[:\s]+)+/i;
export function leadVerbGroup(text: string): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(HEADLINE_LABEL, "").replace(MANY_THINGS_LABEL, "").replace(ITEM_LABEL, "").replace(LEAD_NOISE, "").trim();
  for (const [group, re] of VERB_GROUPS) if (re.test(t)) return group;
  return null;
}
const COMPATIBLE = new Set(["start|up", "up|start"]);
export function actionsConflict(a: string, b: string): boolean {
  const x = leadVerbGroup(a);
  const y = leadVerbGroup(b);
  return x != null && y != null && x !== y && !COMPATIBLE.has(`${x}|${y}`);
}

export function itemText(action: unknown, fallbackTitle: string): string {
  const raw = typeof action === "string" ? action.replace(/\s+/g, " ").trim() : "";
  if (raw.length > ACTION_MAX) return cleanTitle(fallbackTitle);
  const a = noEnd(stripInternalIds(raw));
  return a.length >= ACTION_MIN ? a : cleanTitle(fallbackTitle);
}

export function cleanReason(why: unknown): string | undefined {
  let r = typeof why === "string" ? stripInternalIds(why.replace(/\s+/g, " ")).replace(/^because\s+/i, "") : "";
  if (r.length > REASON_MAX) {
    const m = /^.*?[.!?](?=\s|$)/.exec(r.slice(0, REASON_MAX + 20));
    r = m && m[0].length >= 60 && m[0].length <= REASON_MAX ? m[0] : cut(r, REASON_MAX);
  }
  r = noEnd(r).trim();
  return r ? r[0].toUpperCase() + r.slice(1) : undefined;
}

const HEADLINE_ACTION_RE =
  /\bI(?:'m|\s+am|'ve|\s+have|\s+just)?\s+(?:now\s+|also\s+)?(?:putting|put|raising|raised|increasing|increased|lowering|lowered|cutting|cut|pausing|paused|resuming|resumed|stopping|stopped|starting|started|launching|launched|sending|sent|moving|moved|shifting|shifted|applying|applied|approving|approved|enabling|enabled|switching|switched|turning|turned|setting|set|adding|added|changing|changed|updating|updated)\b/i;

export function headlineClaimsAction(headline: string): boolean {
  return HEADLINE_ACTION_RE.test(headline.replace(/\u2019/g, "'"));
}

const COUNT_PHRASE = /\b(?:\d+|one|two|three|four|five)\s+(?:things?|questions?|changes?|ideas?|cards?|items?|calls?)(?:\s+(?:need|needs)\s+you|\s+for\s+you|\s+made)?\b|\b\d+\s+left\s+for\s+you\b/gi;

export function isCountOnlyHeadline(h: string): boolean {
  return !/[a-z]/i.test(h.replace(COUNT_PHRASE, "").replace(/\b(?:and|plus|for|you|first)\b/gi, ""));
}

export function validHeadline(h: unknown): string | null {
  if (typeof h !== "string") return null;
  const s = stripInternalIds(h.replace(/\s+/g, " "));
  return s.length >= HEADLINE_MIN && s.length <= HEADLINE_MAX && !isCountOnlyHeadline(s) ? s : null;
}

const SUBJECT_QUESTION_MAX = 80;

export function questionSubject(ask: string): string {
  const s = stripInternalIds(ask.replace(/\s+/g, " "))
    .replace(/\s*\((?:ad set|ad group|adset|ad|campaign|post|video)\s+\d{6,}\)/gi, "")
    .trim();
  return cut(s, SUBJECT_QUESTION_MAX);
}

const GOOGLE = new Set(["google_ads", "youtube_ads"]);

const MANY_THINGS_LABEL = /^\d+ things need you\. first:\s*/i;
const NO_OP_LEAD = /^(?:skip|dismiss|no step needed|nothing to do|no action needed)\b/i;

export function isNoOpLead(text: string): boolean {
  return NO_OP_LEAD.test(text.replace(/\s+/g, " ").trim().replace(HEADLINE_LABEL, "").replace(MANY_THINGS_LABEL, "").replace(ITEM_LABEL, "").trim());
}

export function noteHeadline(own: string | null, items: readonly NoteItem[]): string | null {
  const cards = items.filter((i) => i.section === "needs_you" && i.question_ordinal == null);
  const contradicts = (h: string) => cards.some((i) => actionsConflict(h, i.title ?? i.text) && sharesName(h, i.title ?? i.text));
  return (own && !headlineClaimsAction(own) && !isNoOpLead(own) && !contradicts(own) ? own : null) ?? deriveHeadline(items);
}

function sharesName(a: string, b: string): boolean {
  const names = (t: string) => {
    const out: string[] = [];
    for (const m of t.matchAll(/['"‘“]([^'"’”]{2,60})['"’”]/g)) out.push(m[1]);
    const body = t.replace(/^\s*\S+\s+/, " ");
    for (const m of body.matchAll(/\b([A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*)+)/g)) out.push(m[1]);
    return out.map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 3);
  };
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return names(a).some((n) => lb.includes(n)) || names(b).some((n) => la.includes(n));
}

export function deriveHeadline(items: readonly NoteItem[]): string | null {
  const needs = oncePerCard(items.filter((i) => i.section === "needs_you"));
  const cards = needs.filter((i) => i.question_ordinal == null);
  const card = cards.find((i) => !isNoOpLead(i.text)) ?? cards[0];
  if (card) {
    const grouped = groupedChannels(needs);
    const inGroup = (i: NoteItem) => groupable(i) && grouped.has(i.channel_slug!);
    const n = needs.filter((i) => !inGroup(i)).length + grouped.size;
    const lead = inGroup(card) ? groupLine(card.channel_slug!, grouped.get(card.channel_slug!)!) : noEnd(card.text);
    return `${n === 1 ? "1 thing needs" : `${n} things need`} you. First: ${lead}.`;
  }
  if (needs.length) return `${needs.length === 1 ? "1 question" : `${needs.length} questions`} for you.`;
  const changed = items.filter((i) => i.section === "changed");
  if (changed.length) return `${changed.length === 1 ? "1 change" : `${changed.length} changes`} made. ${noEnd(changed[0].text)}.`;
  const decided = items.filter((i) => i.section === "decided");
  if (decided.length) {
    const first = noEnd(decided[0].text.replace(/^Said no to: /, ""));
    return decided.length === 1 ? `Held back a change: ${first}.` : `Held back ${decided.length} changes. First: ${first}.`;
  }
  const working = items.find((i) => i.section === "working_on" && !i.plans);
  if (working) return `Working on ${noEnd(working.text)}.`;
  const blocked = items.filter((i) => i.section === "blocked");
  if (!blocked.length) return null;
  const ours = blocked.find((i) => !i.channel_slug && i.reason);
  if (ours) return `${noEnd(ours.text)}: ${noEnd(`${ours.reason![0].toLowerCase()}${ours.reason!.slice(1)}`)}.`;
  const who = blocked.every((i) => GOOGLE.has(i.channel_slug ?? "")) ? "Google" : "A platform";
  return `${who} refused ${blocked.length === 1 ? "one change" : `${blocked.length} changes`}; nothing for you to do.`;
}

const RANK: Record<NoteSection, number> = { needs_you: 0, blocked: 1, changed: 2, decided: 3, working_on: 4 };

export function buildNoteItems(raw: readonly NoteItem[], blockedIds: ReadonlySet<string> = new Set()): NoteItem[] {
  const forced = raw
    .map((i) => ({
      ...i,
      text: typeof i.text === "string" ? stripInternalIds(i.text) : i.text,
      ...(typeof i.reason === "string" ? { reason: stripInternalIds(i.reason) } : {}),
    }))
    .filter((i) => typeof i.text === "string" && i.text.trim())
    .map((i) => (i.action_id && blockedIds.has(i.action_id) && i.section !== "blocked" ? toBlocked(i) : i));
  const byChain = new Map<string, NoteItem>();
  let anon = 0;
  for (const i of forced) {
    const k = i.chain_root_id ?? i.action_id ?? (i.question_ordinal != null ? `q:${i.question_ordinal}` : `anon:${anon++}`);
    const had = byChain.get(k);
    if (!had) {
      byChain.set(k, i);
      continue;
    }
    const better = RANK[i.section] < RANK[had.section] || (RANK[i.section] === RANK[had.section] && i.action_id === k && had.action_id !== k);
    const keep = i.action_id && i.action_id === had.action_id ? mergeSameCard(better ? i : had, better ? had : i) : better ? i : had;
    const usd = Math.max(had.usd_at_stake ?? -1, i.usd_at_stake ?? -1);
    byChain.set(k, keep.section === "needs_you" && usd >= 0 ? { ...keep, usd_at_stake: usd } : keep);
  }
  const kept = [...byChain.values()];
  const money = (i: NoteItem) => i.usd_at_stake ?? 0;
  const age = (i: NoteItem) => {
    const t = i.waiting_since ? Date.parse(i.waiting_since) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  const needs = kept
    .filter((i) => i.section === "needs_you")
    .sort((a, b) => {
      const qa = a.question_ordinal != null, qb = b.question_ordinal != null;
      if (qa || qb) return qa && qb ? a.question_ordinal! - b.question_ordinal! : qa ? -1 : 1;
      return money(b) - money(a) || age(a) - age(b);
    });
  return [...needs, ...NOTE_SECTIONS.slice(1).flatMap((s) => kept.filter((i) => i.section === s))];
}

function mergeSameCard(keep: NoteItem, other: NoteItem): NoteItem {
  const urgent = keep.blocker_severity === "urgent" || other.blocker_severity === "urgent";
  const severity = urgent ? "urgent" : keep.blocker_severity ?? other.blocker_severity;
  return {
    ...keep,
    ...(severity ? { blocker_severity: severity } : {}),
    ...(keep.blocker_id ?? other.blocker_id ? { blocker_id: keep.blocker_id ?? other.blocker_id } : {}),
    ...(keep.locations || other.locations ? { locations: true } : {}),
  };
}

function oncePerCard(items: readonly NoteItem[]): NoteItem[] {
  const out: NoteItem[] = [];
  const at = new Map<string, number>();
  for (const i of items) {
    const k = i.question_ordinal == null ? i.action_id : undefined;
    const had = k ? at.get(k) : undefined;
    if (had == null) {
      if (k) at.set(k, out.length);
      out.push(i);
      continue;
    }
    out[had] = mergeSameCard(out[had], i);
  }
  return out;
}

function foldRows(all: SectionRow[]): SectionRow[] {
  const foldable = (r: SectionRow) => !!r.item && !r.group && r.question_ordinal == null;
  const keyOf = (r: SectionRow) => {
    const i = r.item!;
    return JSON.stringify([i.channel_slug ?? "", r.line, i.blocker_severity ?? "", (i.blocker_id ?? "").split(":")[0], !!i.locations, !!i.plans, !!i.action_id]);
  };
  const byKey = new Map<string, SectionRow[]>();
  for (const r of all) if (foldable(r)) byKey.set(keyOf(r), [...(byKey.get(keyOf(r)) ?? []), r]);
  const out: SectionRow[] = [];
  const done = new Set<string>();
  for (const r of all) {
    const same = foldable(r) ? byKey.get(keyOf(r))! : null;
    if (!same || same.length < 2) {
      out.push(r);
      continue;
    }
    const k = keyOf(r);
    if (done.has(k)) continue;
    done.add(k);
    out.push({ ...r, line: `${same.length} cards: ${r.line}`, fold: { count: same.length, items: same.map((x) => x.item!) } });
  }
  return out;
}

function toBlocked(i: NoteItem): NoteItem {
  const { usd_at_stake: _u, approved: _a, undoable: _d, reason: _r, budget_from_usd: _f, budget_to_usd: _t, card_change: _c, blocker_id: _b, blocker_severity: _s, ...rest } = i;
  return { ...rest, section: "blocked", text: i.text.replace(/^(Rejected|Said no to|Applying|Applied): /, ""), reason: blockedReason("The platform") };
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const budgetRaiseSentence = (from_usd: number, to_usd: number) => `This also raises your monthly ad budget from ${usd(from_usd)} to ${usd(to_usd)}`;
export function hasBudgetRaise(i: NoteItem): i is NoteItem & { budget_from_usd: number; budget_to_usd: number } {
  return i.section === "needs_you" && typeof i.budget_from_usd === "number" && typeof i.budget_to_usd === "number" && i.budget_to_usd > i.budget_from_usd;
}

export function renderNoteItemLine(i: NoteItem): string {
  const end = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
  if (i.question_ordinal != null) return i.text;
  let line = i.reason ? `${end(i.text)} ${end(i.reason)}` : end(i.text);
  if (i.section === "needs_you" && i.card_change) line = `${line} If you say yes: ${end(i.card_change)}`;
  return hasBudgetRaise(i) ? `${line} ${budgetRaiseSentence(i.budget_from_usd, i.budget_to_usd)}.` : line;
}

const HEADLINE_LABEL = /^(?:needs you now:|held back a change:|1 thing needs you\. first:|\d+ changes? made\.)\s*/i;
const ITEM_LABEL = /^(?:said no to|rejected|applied|applying):\s*/i;

export function lineAfterHeadline(i: NoteItem, headline: string | null | undefined): string | null {
  if (!headline || i.question_ordinal != null) return null;
  const norm = (t: string) => t.replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim().toLowerCase();
  const h = norm(headline.replace(HEADLINE_LABEL, "").replace(ITEM_LABEL, ""));
  if (h.endsWith("…") || h.length < HEADLINE_MIN) return null;
  const text = i.text.replace(/\s+/g, " ").trim().replace(ITEM_LABEL, "");
  const t = norm(text);
  if (!t.startsWith(h) || /[a-z0-9$]/i.test(t.charAt(h.length))) return null;
  const restOfText = text.slice(h.length).replace(/^[.\s:;,]+/, "").trim();
  const rest = renderNoteItemLine({ ...i, text: restOfText || "" });
  return rest.replace(/^\.\s*/, "").trim();
}

function moreUrlFor(key: NoteSectionView["key"], url: string): string {
  if (key !== "needs_you" || !url || url.includes("#")) return url;
  return `${url}#growth-needs`;
}

export function noteSections(
  items: readonly NoteItem[],
  o: {
    wouldChange: readonly string[];
    link: (i: NoteItem) => string | null;
    moreUrl: string;
    channelLink?: (channel_slug: string) => string | null;
    needsLimit?: number;
  },
): NoteSectionView[] {
  const out: NoteSectionView[] = [];
  const add = (key: NoteSectionView["key"], all: SectionRow[], limit: number, pin?: (r: SectionRow) => boolean) => {
    if (!all.length) return;
    const pinned = pin ? all.filter(pin) : [];
    const rest = pin ? all.filter((r) => !pin(r)) : all;
    const hidden = rest.slice(limit).reduce((a, r) => a + (r.fold?.count ?? 1), 0);
    out.push({
      key,
      title: SECTION_TITLES[key],
      rows: [...pinned, ...rest.slice(0, limit)],
      more: hidden ? { count: hidden, url: moreUrlFor(key, o.moreUrl), line: `${hidden} more on your Growth page.` } : null,
    });
  };
  const rows = (s: NoteSection): SectionRow[] =>
    (s === "needs_you" ? oncePerCard(items.filter((i) => i.section === s)) : items.filter((i) => i.section === s))
      .map((i) => ({ line: renderNoteItemLine(i), url: o.link(i), ...(i.question_ordinal != null ? { question_ordinal: i.question_ordinal } : {}), item: i }));
  add("needs_you", foldRows(groupRows(rows("needs_you"), o.channelLink)), o.needsLimit ?? VISIBLE_CARDS, (r) => r.question_ordinal != null || r.item?.blocker_severity === "urgent");
  add("changed", rows("changed"), VISIBLE_PER_SECTION);
  add("decided", rows("decided"), VISIBLE_PER_SECTION);
  add("would_change", o.wouldChange.filter((l) => typeof l === "string" && l.trim()).map((l) => ({ line: l, url: null })), VISIBLE_PER_SECTION);
  add("working_on", rows("working_on"), VISIBLE_PER_SECTION);
  add("blocked", rows("blocked"), VISIBLE_PER_SECTION);
  return out;
}

const groupable = (i: NoteItem) =>
  !!i.action_id && !!i.channel_slug && !!i.title && i.question_ordinal == null && !i.locations && !i.plans &&
  i.blocker_severity !== "urgent" && !i.blocker_id;

export function groupedChannels(needs: readonly NoteItem[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const i of needs) if (i.section === "needs_you" && groupable(i)) n.set(i.channel_slug!, (n.get(i.channel_slug!) ?? 0) + 1);
  for (const [k, v] of n) if (v < GROUP_MIN) n.delete(k);
  return n;
}

const channelName = (slug: string) => CHANNELS.find((c) => c.slug === slug)?.name ?? slug.replace(/_/g, " ");

export function groupLine(slug: string, count: number): string {
  return slug === "generated_video" ? `${count} AI videos are waiting on you` : `${count} ${channelName(slug)} cards are waiting on you`;
}

function groupMemberLine(i: NoteItem): string {
  const title = noEnd(i.title || i.text);
  if (i.channel_slug === "generated_video") return `${title} · ${i.delivered ? "made, not posted yet" : i.making ? "being made now" : "script only, not made yet"}`;
  return hasBudgetRaise(i) ? `${title} · ${budgetRaiseSentence(i.budget_from_usd, i.budget_to_usd)}` : title;
}

function groupRows(all: SectionRow[], channelLink?: (slug: string) => string | null): SectionRow[] {
  const grouped = groupedChannels(all.flatMap((r) => (r.item ? [r.item] : [])));
  if (!grouped.size) return all;
  const out: SectionRow[] = [];
  const done = new Set<string>();
  for (const r of all) {
    const slug = r.item && groupable(r.item) ? r.item.channel_slug! : null;
    if (!slug || !grouped.has(slug)) {
      out.push(r);
      continue;
    }
    if (done.has(slug)) continue;
    done.add(slug);
    const members = all.filter((m) => m.item && groupable(m.item) && m.item.channel_slug === slug).map((m) => m.item!);
    const videos = slug === "generated_video";
    out.push({
      line: groupLine(slug, members.length),
      url: channelLink ? channelLink(slug) : null,
      label: videos ? "Open videos" : "Open",
      group: {
        channel_slug: slug,
        count: members.length,
        lines: [
          ...members.slice(0, GROUP_LINES).map(groupMemberLine),
          ...(members.length > GROUP_LINES ? [`and ${members.length - GROUP_LINES} more on the page`] : []),
        ],
        note: videos ? "Zavi doesn't post videos. Download a made one and post it yourself; Approve makes one that isn't made yet." : null,
        items: members,
      },
    });
  }
  return out;
}

export const noteItemsVisible = (items: readonly unknown[] | null | undefined, would: readonly string[] | null | undefined) =>
  (items?.length ?? 0) > 0 || (would?.length ?? 0) > 0;

export const noteHasUndoable = (items: readonly NoteItem[] | null | undefined) => (items ?? []).some((i) => i.section === "changed" && i.undoable === true);

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

export function parseNoteItems(v: unknown): NoteItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: NoteItem[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.text !== "string" || !r.text.trim() || !(NOTE_SECTIONS as readonly string[]).includes(r.section as string)) continue;
    const item: NoteItem = { section: r.section as NoteSection, text: r.text.slice(0, 400) };
    const reason = str(r.reason, 400);
    if (reason) item.reason = reason;
    if (typeof r.usd_at_stake === "number" && Number.isFinite(r.usd_at_stake)) item.usd_at_stake = r.usd_at_stake;
    for (const k of ["action_id", "chain_root_id", "channel_slug", "goal_id", "waiting_since"] as const) {
      const s = str(r[k], 64);
      if (s) item[k] = s;
    }
    const blocker = str(r.blocker_id, 160);
    if (blocker) item.blocker_id = blocker;
    if (r.blocker_severity === "urgent" || r.blocker_severity === "normal") item.blocker_severity = r.blocker_severity;
    if (typeof r.question_ordinal === "number" && Number.isInteger(r.question_ordinal)) item.question_ordinal = r.question_ordinal;
    if (r.undoable === true) item.undoable = true;
    if (r.approved === true) item.approved = true;
    if (r.locations === true) item.locations = true;
    if (r.plans === true) item.plans = true;
    const change = str(r.card_change, 600);
    if (change) item.card_change = change;
    const title = str(r.title, 120);
    if (title) item.title = title;
    if (r.delivered === true) item.delivered = true;
    if (r.making === true) item.making = true;
    if (typeof r.budget_from_usd === "number" && typeof r.budget_to_usd === "number" && Number.isFinite(r.budget_from_usd) && Number.isFinite(r.budget_to_usd) && r.budget_to_usd > r.budget_from_usd && r.budget_from_usd > 0) {
      item.budget_from_usd = r.budget_from_usd;
      item.budget_to_usd = r.budget_to_usd;
    }
    out.push(item);
  }
  return out;
}

export type CardOutcome = "leave" | "reject" | "approve_queued" | "approve_executed" | "approve_failed" | "sent_back";
export type CardBucket = "blocked_on_us" | "needs_founder" | "temporary" | "partial_risk";

export function blockedReason(platform: string): string {
  return `${platform} refused this change. We've been alerted; nothing for you to do`;
}

export function channelCardNoteItem(a: {
  outcome: CardOutcome;
  row: { id: string; channel_slug: string; title: string; proposed_at?: string | null; exec_class?: string | null; exec_payload?: unknown };
  bucket: CardBucket | null;
  action: unknown;
  why: unknown;
  usd: number | null | undefined;
  platform: string;
  fixText: string | null;
  delivered?: boolean;
  making?: boolean;
}): NoteItem {
  const adTitle = a.row.exec_class ? adChangeHeadline(a.row.exec_class, a.row.exec_payload) : null;
  const contradicts = a.outcome !== "reject" && typeof a.action === "string" && actionsConflict(a.action, a.row.title);
  const text = adTitle ?? (contradicts ? cleanTitle(a.row.title) : itemText(a.action, a.row.title));
  const title = adTitle ?? cleanTitle(a.row.title);
  const usd = typeof a.usd === "number" && Number.isFinite(a.usd) && a.usd >= 0 ? a.usd : undefined;
  const base = { action_id: a.row.id, channel_slug: a.row.channel_slug, ...(a.row.proposed_at ? { waiting_since: a.row.proposed_at } : {}) };
  const blocked: NoteItem = { section: "blocked", text, reason: blockedReason(a.platform), ...base };
  const needs = (reason: string | undefined): NoteItem => ({ section: "needs_you", text, ...(reason ? { reason } : {}), ...(usd !== undefined ? { usd_at_stake: usd } : {}), ...(title ? { title } : {}), ...(a.delivered ? { delivered: true } : a.making ? { making: true } : {}), ...base });
  const withReason = (i: NoteItem): NoteItem => {
    const reason = cleanReason(a.why);
    return reason ? { ...i, reason } : i;
  };
  switch (a.outcome) {
    case "leave":
      return a.bucket === "blocked_on_us" ? blocked : needs(cleanReason(a.why));
    case "reject":
      return withReason({ section: "decided", text: `Said no to: ${text}`, ...base });
    case "approve_queued":
      return withReason({ section: "working_on", text: `Applying: ${text}`, approved: true, ...base });
    case "approve_executed":
      return withReason({ section: "changed", text: `Applied: ${text}`, approved: true, ...base });
    case "approve_failed":
      switch (a.bucket) {
        case "blocked_on_us":
          return blocked;
        case "needs_founder":
          return needs(a.fixText ? `This needs you: ${a.fixText}` : `${a.platform} needs a fix on your side before this can run`);
        case "temporary":
          return needs(`${a.platform} did not take it this time. Try again on the card`);
        case "partial_risk":
          return needs(`Part of it may already be live on ${a.platform}. Check there before trying again`);
        default:
          return needs(cleanReason(a.why));
      }
    case "sent_back":
      return withReason({ section: "working_on", text: `${a.platform}: building ${text}`, ...base });
  }
}
