
import { scrubAgentEgress, scrubArtifactIds } from "@/services/agents/scrub-agent-egress";
import { adBudgetUrl, channelActionUrl, channelLocationsUrl, channelPageUrl, growthNeedsYouUrl, plansUrl } from "@/services/web-base";
import { deriveHeadline, lineAfterHeadline, noteHasUndoable, noteSections, type NoteItem, type NoteSectionView, type SectionRow } from "./cgo-note-items";
import { DID_MAX, DID_SECTIONS, noteLead, parseHeldAsk } from "./cgo-note-story";
import type { NoteGoalView } from "./goal-owner";

export type CgoNoteSlack = {
  companyName: string;
  changed: readonly string[];
  wouldChange?: readonly string[];
  need: readonly string[];
  nextReviewAt?: string | null;
  adsEvery2h?: boolean;
  growthUrl: string;
  questions?: readonly SlackNoteQuestion[];
  items?: readonly NoteItem[] | null;
  headline?: string | null;
  tenantId?: string | null;
  kind?: string | null;
  goals?: readonly NoteGoalView[];
  now?: Date;
};

export type SlackNoteQuestion = {
  id: string;
  ordinal: number | null;
  ask: string;
  recommended: "yes" | "no" | null;
  why: string | null;
  yesNo: boolean;
  noteLine: string;
};

export const CGO_Q_ACTION_PREFIX = "cgo_q:";
export function cgoQuestionActionId(question_id: string, answer: "yes" | "no"): string {
  return `${CGO_Q_ACTION_PREFIX}${question_id}:${answer}`;
}
export function parseCgoQuestionAction(action_id: string): { question_id: string; answer: "yes" | "no" } | null {
  const m = /^cgo_q:([0-9a-f-]{36}):(yes|no)$/i.exec(action_id);
  return m ? { question_id: m[1].toLowerCase(), answer: m[2].toLowerCase() as "yes" | "no" } : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeSlack(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clean(line: string): string {
  const scrubbed = scrubAgentEgress(line, { agentSlug: "cgo", surface: "chat", scrubPii: true }).text;
  return escapeSlack(scrubArtifactIds(scrubbed).text.trim());
}

function dayLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function nextCheckInLine(nextReviewAt: string | null | undefined, adsEvery2h = false): string | null {
  const next = dayLabel(nextReviewAt);
  if (!adsEvery2h) return next ? `Next check-in: ${next}` : null;
  return [next ? `Next full check-in: ${next}` : null, "I also check your ads every 4 hours during the day"].filter(Boolean).join(" · ");
}

const REFUND_LINE = 'Wrong call? Mark it "This was a mistake" there within 30 days and we refund the credits it used.';

export function renderCgoNoteSlack(n: CgoNoteSlack): string {
  if (hasItems(n)) return itemsText(n);
  const sections: Array<[string, readonly string[]]> = [
    [n.need.length > 1 ? "Your calls" : "Your call", n.need.map((l) => decisionMrkdwnLine(l, n.now))],
    ["What I did", n.changed],
    ["What I'd change", n.wouldChange ?? []],
  ];
  const out: string[] = [...headerLines(n)];
  for (const [title, lines] of sections) {
    const kept = lines.map((l) => (title.startsWith("Your call") ? l : clean(l))).filter((l) => l.length > 0);
    if (kept.length === 0) continue;
    out.push("", `*${title}*`, kept.map((l) => `• ${l}`).join("\n\n"));
  }
  const checkIn = n.kind === "alarm" ? null : nextCheckInLine(n.nextReviewAt, n.adsEvery2h);
  out.push("", [checkIn, `<${n.growthUrl}|Open Growth Strategy>`].filter(Boolean).join(" · "));
  if (n.changed.length > 0) {
    out.push(REFUND_LINE);
  }
  return out.join("\n");
}

const hasItems = (n: CgoNoteSlack): n is CgoNoteSlack & { items: readonly NoteItem[] } => Array.isArray(n.items) && n.items.length > 0;

export function noteRowFix(i: NoteItem, tenantId?: string | null): { label: string; url: string } | null {
  if (i.plans) return { label: "See plans", url: plansUrl() };
  if (i.section !== "needs_you") return null;
  const b = i.blocker_id ?? "";
  if (/^(connector|ad_read_failed):/.test(b)) return { label: "Reconnect", url: growthNeedsYouUrl(tenantId) };
  if (/^account:/.test(b)) return { label: "Fix it", url: growthNeedsYouUrl(tenantId) };
  if (i.locations && i.channel_slug) return { label: "Pick where ads show", url: channelLocationsUrl(i.channel_slug, tenantId) };
  if (i.action_id && i.channel_slug) return { label: "Open", url: channelActionUrl(i.channel_slug, i.action_id, tenantId) };
  if (/^(budget_brake|budget_stop):/.test(b) && tenantId) return { label: "Ad budget", url: adBudgetUrl(tenantId) };
  return null;
}

export function slackNoteSections(n: CgoNoteSlack & { items: readonly NoteItem[] }): NoteSectionView[] {
  return noteSections(n.items, {
    wouldChange: n.wouldChange ?? [],
    link: (i) => noteRowFix(i, n.tenantId)?.url ?? null,
    moreUrl: n.growthUrl,
    channelLink: (slug) => channelPageUrl(slug, n.tenantId),
  });
}

type DrawnRow = { text: string; fix: { label: string; url: string } | null; q: SlackNoteQuestion | null };
type DrawnSection = { title: string | null; rows: DrawnRow[]; more: NoteSectionView["more"]; hidden: number };

function drawnSections(n: CgoNoteSlack & { items: readonly NoteItem[] }): DrawnSection[] {
  const qs = n.questions ?? [];
  const headline = headlineOf(n);
  const out: DrawnSection[] = [];
  const all = slackNoteSections(n);
  for (const s of all) {
    const rows: DrawnRow[] = [];
    for (const r of s.rows) {
      const q = questionFor(r, qs);
      if (r.group) {
        const sub = r.group.lines.map((l) => `    ◦ ${clean(l)}`);
        const text = [`*${clean(r.line)}*`, ...sub, ...(r.group.note ? [`_${clean(r.group.note)}_`] : [])].join("\n");
        rows.push({ text, fix: r.url ? { label: r.label ?? "Open", url: r.url } : null, q: null });
        continue;
      }
      const after = r.item && !r.fold ? lineAfterHeadline(r.item, headline) : null;
      const fix = r.item ? noteRowFix(r.item, n.tenantId) : null;
      if (after === "" && !fix) continue;
      rows.push({ text: clean(after ?? r.line), fix, q });
    }
    if (!rows.length && !s.more) continue;
    if ((DID_SECTIONS as readonly string[]).includes(s.key)) {
      const did = out.find((d) => d.title === "What I did");
      if (did) {
        did.rows.push(...rows);
        did.hidden += s.more?.count ?? 0;
      } else out.push({ title: "What I did", rows, more: null, hidden: s.more?.count ?? 0 });
      continue;
    }
    out.push({ title: s.key === "needs_you" ? (rows.length > 1 ? "Your calls" : "Your call") : s.title, rows, more: s.more, hidden: 0 });
  }
  const did = out.find((d) => d.title === "What I did");
  if (did) {
    const over = did.rows.length - DID_MAX + did.hidden;
    did.rows = did.rows.slice(0, DID_MAX);
    if (over > 0) did.more = { count: over, url: n.growthUrl, line: `${over} more on your Growth page.` };
  }
  const only = all.length === 1 && all[0].rows.length === 1 && !all[0].more && out.length === 1 && !out[0].rows[0]?.q;
  if (only && headline) out[0].title = null;
  return out;
}

const rowText = (r: DrawnRow) => (r.fix ? `${r.text ? `${r.text} ` : ""}<${r.fix.url}|${r.fix.label}>` : r.text);
const moreMrkdwn = (m: NonNullable<NoteSectionView["more"]>) => `${escapeSlack(m.line)} <${m.url}|Open>`;

const headlineOf = (n: CgoNoteSlack): string | null => n.headline?.trim() || (hasItems(n) ? deriveHeadline(n.items) : null) || null;

function leadOf(n: CgoNoteSlack): string | null {
  const qs = n.questions ?? [];
  if (!hasItems(n)) return noteLead({ firstAsk: qs[0]?.ask ?? n.need[0] ?? null, firstLine: n.changed[0] ?? n.wouldChange?.[0] ?? null });
  const all = noteSections(n.items, { wouldChange: [], link: () => null, moreUrl: n.growthUrl });
  const first = all.find((s) => s.key === "needs_you")?.rows[0];
  const q = first ? questionFor(first, qs) : null;
  const firstDid = all.filter((s) => (DID_SECTIONS as readonly string[]).includes(s.key)).flatMap((s) => s.rows).find((r) => !r.item?.plans)?.line ?? null;
  return noteLead({ headline: headlineOf(n), firstAsk: q?.ask ?? (first && !first.group ? first.line : null), firstLine: firstDid });
}

function headerLines(n: CgoNoteSlack): string[] {
  const company = escapeSlack(n.companyName.trim() || "Your company");
  const h = leadOf(n);
  const headline = h ? clean(h) : "";
  const stand = (n.goals ?? []).map((g) => `_${clean(g.verdict ?? (g.current ? `${g.title}: ${g.current}${g.due ? `, ${g.due}` : ""}.` : `Your aim: ${g.aim ?? g.title}. Not counted yet.`))}_${g.source ? ` ${clean(g.source)}` : ""}${g.founder_estimate ? ` ${clean(g.founder_estimate)}` : ""}`);
  return [headline ? `*${company}: ${headline}*` : `*${company}: your head of growth update*`, ...stand];
}

function decisionMrkdwnLine(ask: string, now?: Date, rec?: { recommended: "yes" | "no" | null; why: string | null }): string {
  const held = parseHeldAsk(ask, now ?? new Date());
  if (!held) return clean(ask);
  const r = rec?.recommended ?? held.recommend;
  const why = rec?.why ?? held.why;
  const ord = /^(\d+)\.\s/.exec(ask)?.[1];
  return [
    `*${ord ? `${ord}. ` : ""}${clean(held.title)}*`,
    held.cost ? `Cost: ${clean(held.cost)}` : null,
    held.lastNumbers ? clean(held.lastNumbers) : null,
    held.heldBecause ? `Why I asked instead of doing it: ${clean(held.heldBecause)}` : null,
    `I recommend: ${r === "no" ? "No" : "Yes"}. ${clean(why)}`,
    held.ifNo ? `If you say no: ${clean(held.ifNo)}` : null,
  ].filter(Boolean).join("\n");
}

function footerLines(n: CgoNoteSlack & { items: readonly NoteItem[] }): string[] {
  const out: string[] = [];
  if (n.kind !== "alarm") out.push([nextCheckInLine(n.nextReviewAt, n.adsEvery2h), `<${n.growthUrl}|Open Growth Strategy>`].filter(Boolean).join(" · "));
  if (noteHasUndoable(n.items)) out.push(REFUND_LINE);
  return out;
}

function questionFor(r: SectionRow, qs: readonly SlackNoteQuestion[]): SlackNoteQuestion | null {
  return r.question_ordinal != null ? qs.find((q) => q.ordinal === r.question_ordinal) ?? null : null;
}

function itemsText(n: CgoNoteSlack & { items: readonly NoteItem[] }): string {
  const out = headerLines(n);
  for (const s of drawnSections(n)) {
    const bullets = s.rows.map((r) => (r.q ? `• ${questionMrkdwn(r.q, n.now)}` : s.title ? `• ${rowText(r)}` : rowText(r)));
    if (s.more) bullets.push(`• ${moreMrkdwn(s.more)}`);
    out.push("", ...(s.title ? [`*${s.title}*`] : []), bullets.join("\n\n"));
  }
  const footer = footerLines(n);
  if (footer.length) out.push("", ...footer);
  return out.join("\n");
}

export const SLACK_BLOCK_TEXT_MAX = 2900;

function splitLong(text: string, max = SLACK_BLOCK_TEXT_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf(" ", max);
    if (at < max * 0.5) at = max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function packInto(pieces: readonly string[], sep: string, make: (text: string) => unknown): unknown[] {
  const blocks: unknown[] = [];
  let buf = "";
  const flush = () => {
    if (buf) blocks.push(make(buf));
    buf = "";
  };
  for (const piece of pieces.flatMap((p) => splitLong(p))) {
    if (buf && buf.length + sep.length + piece.length > SLACK_BLOCK_TEXT_MAX) flush();
    buf = buf ? `${buf}${sep}${piece}` : piece;
  }
  flush();
  return blocks;
}

const sectionBlock = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const contextBlock = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

const SLACK_MAX_BLOCKS = 50;

function itemsMessage(n: CgoNoteSlack & { items: readonly NoteItem[] }): { text: string; blocks: unknown[] } {
  const withButtons = itemsBlocks(n, true);
  return { text: itemsText(n), blocks: withButtons.length <= SLACK_MAX_BLOCKS ? withButtons : itemsBlocks(n, false) };
}

function itemsBlocks(n: CgoNoteSlack & { items: readonly NoteItem[] }, buttonsOn: boolean): unknown[] {
  const blocks: unknown[] = [];
  let pending: string[] = [headerLines(n).join("\n")];
  let buttons = 0;
  const flushText = () => {
    blocks.push(...packInto(pending, "\n\n", sectionBlock));
    pending = [];
  };
  for (const s of drawnSections(n)) {
    let title: string | null = s.title ? `*${s.title}*` : null;
    const bullet = (t: string) => (s.title ? `• ${t}` : t);
    const add = (line: string) => {
      pending.push(title ? `${title}\n${line}` : line);
      title = null;
    };
    for (const r of s.rows) {
      if (r.q) {
        if (title) pending.push(title);
        title = null;
        flushText();
        blocks.push(...questionBlocks(r.q, n.now));
        continue;
      }
      if (buttonsOn && r.fix && !r.text) {
        if (title) pending.push(title);
        title = null;
        flushText();
        blocks.push({ type: "actions", elements: [linkButton(r.fix, buttons++)] });
        continue;
      }
      if (buttonsOn && r.fix && r.text.length <= SLACK_BLOCK_TEXT_MAX - 200) {
        if (title) pending.push(title);
        title = null;
        flushText();
        blocks.push(fixBlock(bullet(r.text), r.fix, buttons++));
        continue;
      }
      add(bullet(rowText(r)));
    }
    if (s.more) add(`• ${moreMrkdwn(s.more)}`);
  }
  flushText();
  blocks.push(...packInto(footerLines(n), "\n", contextBlock));
  return blocks;
}

export const CGO_LINK_ACTION_PREFIX = "cgo_link:";
const linkButton = (fix: { label: string; url: string }, n: number) => ({ type: "button", text: { type: "plain_text", text: fix.label }, url: fix.url, action_id: `${CGO_LINK_ACTION_PREFIX}${n}` });
function fixBlock(text: string, fix: { label: string; url: string }, n: number): unknown {
  return { type: "section", text: { type: "mrkdwn", text }, accessory: linkButton(fix, n) };
}

function questionMrkdwn(q: SlackNoteQuestion, now?: Date): string {
  const ord = q.ordinal != null ? `${q.ordinal}. ` : "";
  if (parseHeldAsk(q.ask)) return `${ord}${decisionMrkdwnLine(q.ask, now, q)}`.slice(0, 2900);
  const rec = q.recommended === "yes" ? "Yes" : q.recommended === "no" ? "No" : null;
  const head = `*${ord}${clean(q.ask)}*${rec ? ` _(I recommend: ${rec})_` : ""}`;
  return (q.why ? `${head}\n${clean(q.why)}` : head).slice(0, 2900);
}

export function answeredContext(answer: string, via: string, at: Date): string {
  const label = answer === "yes" ? "Yes" : answer === "no" ? "No" : "answered";
  const where = via === "slack" ? "Slack" : via === "web" ? "the web" : "email";
  const unix = Math.floor(at.getTime() / 1000);
  return `Answered: *${label}* · via ${where} · <!date^${unix}^{time}|${at.toISOString().slice(11, 16)} UTC>`;
}

export function questionBlocks(q: SlackNoteQuestion, now?: Date): unknown[] {
  const out: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: questionMrkdwn(q, now) } }];
  const recommended = q.recommended ?? parseHeldAsk(q.ask, now ?? new Date())?.recommend ?? null;
  if (!q.yesNo) {
    out.push({ type: "context", elements: [{ type: "mrkdwn", text: "Reply in this thread in your own words." }] });
    return out;
  }
  const btn = (answer: "yes" | "no") => ({
    type: "button",
    text: { type: "plain_text", text: answer === "yes" ? "Yes" : "No" },
    action_id: cgoQuestionActionId(q.id, answer),
    value: q.id,
    ...(recommended === answer ? { style: "primary" } : {}),
  });
  out.push({ type: "actions", block_id: `cgo_q:${q.id}`, elements: [btn("yes"), btn("no")] });
  return out;
}

export function renderCgoNoteSlackMessage(n: CgoNoteSlack): { text: string; blocks: unknown[] } {
  if (hasItems(n)) return itemsMessage(n);
  const qs = n.questions ?? [];
  const shown = new Set(qs.map((q) => q.noteLine));
  const rest = n.need.filter((l) => !shown.has(l));
  const text = renderCgoNoteSlack({ ...n, need: [...qs.map((q) => `${q.ordinal != null ? `${q.ordinal}. ` : ""}${q.ask}`), ...rest] });
  const callsTitle = qs.length + rest.length > 1 ? "*Your calls*" : "*Your call*";
  if (qs.length === 0) return { text, blocks: [] };
  const top = renderCgoNoteSlack({ ...n, need: [] }).split("\n");
  const footerLines = n.changed.length > 0 ? 2 : 1;
  const head = headerLines(n).length;
  const title = top.slice(0, head).join("\n").trim();
  const body = top.slice(head, top.length - footerLines).join("\n").trim();
  const footer = top.slice(top.length - footerLines).join("\n").trim();
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: title.slice(0, 2900) } }];
  blocks.push({ type: "section", text: { type: "mrkdwn", text: callsTitle } });
  for (const q of qs) blocks.push(...questionBlocks(q, n.now));
  const others = rest.map((l) => decisionMrkdwnLine(l, n.now)).filter((l) => l.length > 0);
  if (others.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: others.map((l) => `• ${l}`).join("\n\n").slice(0, 2900) } });
  if (body) blocks.push({ type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } });
  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.slice(0, 2900) }] });
  return { text, blocks };
}
