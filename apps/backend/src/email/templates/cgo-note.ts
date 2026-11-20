
import { renderEmail, escapeEmailHtml, EMAIL_PALETTE as P } from "../theme";
import type { NoteGoalView } from "@/services/growth/goal-owner";
import { nextCheckInLine, noteRowFix } from "@/services/growth/cgo-note-slack";
import { channelPageUrl } from "@/services/web-base";
import { deriveHeadline, lineAfterHeadline, noteHasUndoable, noteSections, type NoteItem, type NoteSectionView, type SectionRow } from "@/services/growth/cgo-note-items";
import { DID_MAX, DID_SECTIONS, noteLead, parseHeldAsk } from "@/services/growth/cgo-note-story";

export type CgoNoteEmail = {
  companyName: string;
  autopilot: boolean;
  saw: readonly string[];
  changed: readonly string[];
  wouldChange?: readonly string[];
  need: readonly string[];
  questions?: readonly NoteQuestion[];
  goals?: readonly NoteGoalView[];
  goalSawLines?: readonly string[];
  growthUrl: string;
  nextReviewAt?: string | null;
  adsEvery2h?: boolean;
  items?: readonly NoteItem[] | null;
  headline?: string | null;
  tenantId?: string | null;
  kind?: string | null;
  canReply?: boolean;
  now?: Date;
};

export type NoteQuestion = {
  ordinal: number | null;
  ask: string;
  recommended: "yes" | "no" | null;
  why: string | null;
  yesHref: string | null;
  noHref: string | null;
  factCheck?: boolean;
};

const REPLY_LINE = "Just reply to this email to answer, or to tell me anything.";
export function answerHint(printed: readonly NoteQuestion[]): string | null {
  const shown = printed.filter((q) => q.yesHref && q.ordinal != null);
  if (!shown.length) return null;
  const ords = shown.map((q) => q.ordinal as number);
  if (ords.length === 1) return `Or reply with \`${ords[0]} yes\`.`;
  const example = `\`${ords[0]} yes, ${ords[1]} no\``;
  return shown.some((q) => q.factCheck) ? `Or reply with ${example}.` : `Or reply with ${example}, or just \`yes\` to all.`;
}

function hintHtml(printed: readonly NoteQuestion[]): string {
  const hint = answerHint(printed);
  return hint ? `<p style="margin:4px 0 0 0;font-family:${SANS};font-size:13px;color:${P.muted};">${escapeEmailHtml(hint)}</p>` : "";
}

const SANS = "'Plus Jakarta Sans','Poppins',sans-serif";
const GREEN = "#1E7A34";
const GREEN_BG = "#E7F4EA";
const AMBER = "#A15C00";
const AMBER_BG = "#FFF4E0";
const ASK_BG = "#eef6ff";
const ASK_RULE = "#bedeff";
const SOFT_RULE = "#ececec";

function splitLine(line: string): { title: string; detail: string } {
  const m = /^(.{8,140}?[.!?])\s+(.+)$/s.exec(line.trim());
  return m ? { title: m[1], detail: m[2] } : { title: line.trim(), detail: "" };
}

function h2(label: string): string {
  return `<p style="margin:26px 0 10px 0;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${P.muted};">${escapeEmailHtml(label)}</p>`;
}

function askHtml(l: string): string {
  const m = /^(.*[.!?…]\s)([^.!?…]*\?)\s*$/s.exec(l.trim());
  if (!m) return escapeEmailHtml(l);
  return `${escapeEmailHtml(m[1])}<strong style="color:${P.ink};">${escapeEmailHtml(m[2])}</strong>`;
}

function recommendLabel(r: "yes" | "no" | null): string {
  return r === "yes" ? "Yes" : r === "no" ? "No" : "";
}

function solidButton(href: string, label: string): string {
  return `<a href="${escapeEmailHtml(href)}" style="display:inline-block;padding:10px 22px;border-radius:6px;font-family:${SANS};font-size:14px;font-weight:700;text-decoration:none;background-color:${P.ink};color:#FFFFFF;">${escapeEmailHtml(label)}</a>`;
}
function textLink(href: string, label: string): string {
  return `<a href="${escapeEmailHtml(href)}" style="font-family:${SANS};font-size:14px;font-weight:600;color:${P.body};text-decoration:underline;">${escapeEmailHtml(label)}</a>`;
}

export function questionText(q: NoteQuestion): string {
  const rec = recommendLabel(q.recommended);
  return [`${q.ordinal != null ? `${q.ordinal}. ` : ""}${q.ask}`, rec ? `(I recommend: ${rec})` : "", q.why ?? ""].filter(Boolean).join(" ");
}

function changeRows(lines: readonly string[], tone: "done" | "idea", links: ReadonlyArray<{ url: string; label: string } | null> = []): string {
  return lines
    .map((l, k) => {
      const link = links[k];
      const paused = tone === "done" && /^paused\b/i.test(l.trim());
      const [bg, fg, mark] = tone === "idea" ? [P.paper, P.muted, "&rarr;"] : paused ? [AMBER_BG, AMBER, "II"] : [GREEN_BG, GREEN, "&#10003;"];
      const { title, detail } = splitLine(l);
      const a = link ? ` <a href="${escapeEmailHtml(link.url)}" style="color:${P.ink};font-weight:700;text-decoration:underline;white-space:nowrap;">${escapeEmailHtml(link.label)}</a>` : "";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${SOFT_RULE};"><tr>
  <td width="24" valign="top" style="padding:10px 0;"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;text-align:center;background-color:${bg};color:${fg};font-family:${SANS};font-size:11px;font-weight:800;">${mark}</div></td>
  <td valign="top" style="padding:10px 0 10px 12px;font-family:${SANS};">
    <div style="font-size:14.5px;line-height:1.45;font-weight:600;color:${P.ink};">${escapeEmailHtml(title)}${detail ? "" : a}</div>
    ${detail ? `<div style="font-size:13px;line-height:1.5;color:${P.muted};margin-top:2px;">${escapeEmailHtml(detail)}${a}</div>` : ""}
  </td>
</tr></table>`;
    })
    .join("");
}

function standHtml(g: NoteGoalView): string {
  const [bg, fg] = g.verdict ? (g.tone === "short" ? [AMBER_BG, AMBER] : [GREEN_BG, GREEN]) : [P.paper, P.muted];
  const sub = [g.source, g.founder_estimate].filter((x): x is string => !!x?.trim());
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;"><tr>
  <td style="padding:14px 16px;background-color:${bg};border-radius:8px;font-family:${SANS};">
    <div style="font-size:15px;line-height:1.5;font-weight:700;color:${fg};">${escapeEmailHtml(standLine(g))}</div>
    ${sub.map((l) => `<div style="margin-top:4px;font-size:12.5px;color:${P.muted};">${escapeEmailHtml(l)}</div>`).join("")}
  </td></tr></table>`;
}

export function standLine(g: NoteGoalView): string {
  if (g.verdict) return g.verdict;
  if (g.current) return `${g.title}: ${g.current}${g.due ? `, ${g.due}` : ""}.`;
  return `Your aim: ${g.aim ?? g.title}. Not counted yet.`;
}

export const EMAIL_REFUND_LINE = 'Wrong call? Mark it "This was a mistake" on your Growth page within 30 days and we refund the credits it used.';

type Decision = { q: NoteQuestion | null; line: string; url: string | null; label: string | null; row: SectionRow | null };
type DidLine = { line: string; tone: "done" | "idea"; link: { url: string; label: string } | null };

type Story = {
  company: string;
  lead: string | null;
  goals: readonly NoteGoalView[];
  decisions: Decision[];
  decisionsMore: NoteSectionView["more"];
  did: DidLine[];
  didHidden: number;
  would: string[];
  undoable: boolean;
  alarm: boolean;
};

function decisionCase(d: Decision, now: Date) {
  const ask = d.q?.ask ?? d.line;
  const held = parseHeldAsk(ask, now);
  const recommended = d.q?.recommended ?? held?.recommend ?? null;
  return {
    held,
    title: held ? held.title : ask,
    facts: held
      ? [held.cost ? `Cost: ${held.cost}` : null, held.lastNumbers, held.heldBecause ? `Why I asked instead of doing it: ${held.heldBecause}` : null].filter((x): x is string => !!x)
      : [],
    recommended,
    why: d.q?.why ?? held?.why ?? null,
    ifNo: held?.ifNo ?? null,
    yesLabel: held?.yesLabel ?? "Yes",
    noLabel: held?.noLabel ?? "No",
  };
}

function decisionHtml(d: Decision, now: Date, canReply: boolean, tenantId?: string | null): { html: string; solid: boolean } {
  const c = decisionCase(d, now);
  const q = d.q;
  const ord = q?.ordinal != null ? `${q.ordinal}. ` : "";
  const head = q || c.held ? `<strong style="color:${P.ink};">${escapeEmailHtml(`${ord}${c.title}`)}</strong>` : askHtml(d.line);
  const facts = c.facts.map((f) => `<div style="margin-top:4px;font-size:13.5px;color:${P.body};">${escapeEmailHtml(f)}</div>`).join("");
  const rec = recommendLabel(c.recommended);
  const recLine = rec
    ? `<div style="margin-top:8px;font-size:13.5px;color:${P.body};"><strong style="color:${P.ink};">I recommend: ${rec}.</strong>${c.why ? ` ${escapeEmailHtml(c.why)}` : ""}</div>`
    : c.why
      ? `<div style="margin-top:6px;font-size:13.5px;color:${P.muted};">${escapeEmailHtml(c.why)}</div>`
      : "";
  const ifNo = c.ifNo ? `<div style="margin-top:4px;font-size:13px;color:${P.muted};">If you say no: ${escapeEmailHtml(c.ifNo)}</div>` : "";
  let buttons = "";
  let solid = false;
  if (q?.yesHref && q.noHref) {
    const first = c.recommended ?? (q.factCheck ? null : "yes");
    const yes = { href: q.yesHref, label: c.yesLabel };
    const no = { href: q.noHref, label: c.noLabel };
    const [main, other] = first === "no" ? [no, yes] : [yes, no];
    solid = first != null;
    buttons = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td>${
      solid ? solidButton(main.href, main.label) : textLink(main.href, main.label)
    }</td><td style="padding:0 0 0 14px;font-family:${SANS};font-size:14px;color:${P.muted};">or ${textLink(other.href, other.label)}</td></tr></table>`;
  } else if (q && canReply) {
    buttons = `<div style="margin-top:10px;font-size:13px;color:${P.muted};">Reply in your own words.</div>`;
  } else if (d.url) {
    const label = d.label || (d.row?.item && noteRowFix(d.row.item, tenantId)?.label) || "Open";
    buttons = `<div style="margin-top:8px;">${textLink(d.url, `${label} →`)}</div>`;
  }
  const group = d.row ? groupHtml(d.row) : "";
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px 0;"><tr>
  <td style="padding:14px 16px;background-color:${ASK_BG};border:1px solid ${ASK_RULE};border-radius:8px;font-family:${SANS};font-size:14.5px;line-height:1.55;color:${P.body};">${head}${group}${facts}${recLine}${ifNo}${buttons}</td>
</tr></table>`,
    solid,
  };
}

function decisionText(d: Decision, now: Date, tenantId?: string | null): string[] {
  const c = decisionCase(d, now);
  if (d.q) {
    const head = `- ${questionText({ ...d.q, recommended: c.recommended, why: c.why })}`;
    return [head, ...c.facts.map((f) => `  ${f}`), ...(c.ifNo ? [`  If you say no: ${c.ifNo}`] : [])];
  }
  const r = d.row;
  const link = d.url ? ` ${d.label || (r?.item && noteRowFix(r.item, tenantId)?.label) || "Open"}: ${d.url}` : "";
  const head = `- ${d.line}${link}`;
  return r?.group ? [head, ...r.group.lines.map((l) => `    - ${l}`), ...(r.group.note ? [`    ${r.group.note}`] : [])] : [head];
}

function didCut(did: readonly DidLine[], hidden: number): { shown: DidLine[]; more: number } {
  return { shown: did.slice(0, DID_MAX), more: Math.max(0, did.length - DID_MAX) + hidden };
}

function renderStory(n: CgoNoteEmail, st: Story): { html: string; text: string; subject: string } {
  const now = n.now ?? new Date();
  const company = st.company;
  const qs = st.decisions.map((d) => d.q).filter((q): q is NoteQuestion => q != null);
  const subject = st.lead ? `${company}: ${st.lead}` : `${company}: your ${n.autopilot ? "" : "weekly "}growth note`;
  const checkIn = st.alarm ? null : nextCheckInLine(n.nextReviewAt, n.adsEvery2h);
  const { shown, more } = didCut(st.did, st.didHidden);

  const lastQ = st.decisions.reduce((at, d, k) => (d.q ? k : at), -1);
  let solid = false;
  const cards = st.decisions.map((d, k) => {
    const out = decisionHtml(d, now, n.canReply === true, n.tenantId);
    solid ||= out.solid;
    return k === lastQ ? out.html + hintHtml(qs) : out.html;
  });
  const callsTitle = st.decisions.length > 1 ? "Your calls" : "Your call";
  const body = [
    st.goals.length ? h2("Where you stand") + st.goals.map(standHtml).join("") : "",
    st.decisions.length || st.decisionsMore ? h2(callsTitle) + cards.join("") + (st.decisionsMore ? moreLine(st.decisionsMore) : "") : "",
    shown.length
      ? h2("What I did") +
        shown.map((d) => changeRows([d.line], d.tone, [d.link])).join("") +
        (more ? moreLine({ count: more, url: n.growthUrl, line: `${more} more on your Growth page.` }) : "")
      : "",
    st.would.length ? h2("What I'd change") + changeRows(st.would, "idea") : "",
    checkIn ? `<p style="margin:20px 0 0 0;font-family:${SANS};font-size:13.5px;color:${P.muted};">${escapeEmailHtml(`${checkIn}.`)}</p>` : "",
    st.undoable ? `<p style="margin:18px 0 0 0;font-family:${SANS};font-size:13.5px;color:${P.muted};">${escapeEmailHtml(EMAIL_REFUND_LINE)}</p>` : "",
    n.canReply ? `<p style="margin:22px 0 0 0;font-family:${SANS};font-size:14px;color:${P.body};">${escapeEmailHtml(REPLY_LINE)}</p>` : "",
  ].join("");

  const cta = solid
    ? { afterCta: `<p style="margin:18px 0 0 0;">${textLink(n.growthUrl, "Open your Growth page →")}</p>` }
    : { ctaText: "Open your Growth page", ctaUrl: n.growthUrl };
  const html = renderEmail({
    preheader: st.lead ?? (st.goals[0] ? standLine(st.goals[0]) : null) ?? shown[0]?.line ?? "Where your growth stands.",
    kicker: "Your growth",
    eyebrow: st.alarm ? "Needs you now" : "Growth note",
    title: st.lead ? `${escapeEmailHtml(company)}: ${escapeEmailHtml(st.lead)}` : `${escapeEmailHtml(company)}: here is where things <em>stand</em>`,
    ...cta,
    body,
    footerNote: st.alarm ? "I write as soon as something needs you." : "I write after each check-in on your goals, and whenever I change something.",
    footerVariant: "founder-growth",
  });

  const hint = answerHint(qs);
  const sections: Array<[string, string[]]> = [
    ["Where you stand", st.goals.flatMap((g) => [`- ${standLine(g)}`, ...[g.source, g.founder_estimate].filter((x): x is string => !!x?.trim()).map((l) => `  ${l}`)])],
    [callsTitle, [...st.decisions.flatMap((d) => decisionText(d, now, n.tenantId)), ...(hint ? [`  ${hint}`] : []), ...(st.decisionsMore ? [`- ${st.decisionsMore.line} ${st.decisionsMore.url}`] : [])]],
    ["What I did", [...shown.map((d) => `- ${d.line}${d.link ? ` ${d.link.label}: ${d.link.url}` : ""}`), ...(more ? [`- ${more} more on your Growth page. ${n.growthUrl}`] : [])]],
    ["What I'd change", st.would.map((l) => `- ${l}`)],
  ];
  const text = [
    st.lead ? `${company}: ${st.lead}` : `${company}: here is where things stand`,
    "",
    ...sections.filter(([, lines]) => lines.length > 0).flatMap(([h, lines]) => [h, ...lines, ""]),
    ...(checkIn ? [`${checkIn}.`, ""] : []),
    ...(st.undoable ? [EMAIL_REFUND_LINE, ""] : []),
    ...(n.canReply ? [REPLY_LINE, ""] : []),
    `Open your Growth page: ${n.growthUrl}`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");
  return { html, text, subject };
}

function otherSawLines(n: CgoNoteEmail): string[] {
  const drawn = new Set(n.goalSawLines ?? []);
  return (n.goals ?? []).length ? n.saw.filter((l) => !drawn.has(l)) : [...n.saw];
}

export function renderCgoNoteEmail(n: CgoNoteEmail): { html: string; text: string; subject: string } {
  if (Array.isArray(n.items) && n.items.length > 0) return renderItemsEmail({ ...n, items: n.items });
  const qs = n.questions ?? [];
  const decisions: Decision[] = [
    ...qs.map((q) => ({ q, line: q.ask, url: null, label: null, row: null })),
    ...n.need.filter((l) => !qs.some((q) => q.ask === l)).map((l) => ({ q: null, line: l, url: null, label: null, row: null })),
  ];
  const did: DidLine[] = [
    ...n.changed.map((line) => ({ line, tone: "done" as const, link: null })),
    ...otherSawLines(n).map((line) => ({ line, tone: "idea" as const, link: null })),
  ];
  const would = [...(n.wouldChange ?? [])];
  return renderStory(n, {
    company: n.companyName.trim() || "Your company",
    lead: noteLead({ headline: n.headline, firstAsk: decisions[0]?.line ?? null, firstLine: n.changed[0] ?? would[0] ?? null }),
    goals: n.goals ?? [],
    decisions,
    decisionsMore: null,
    did,
    didHidden: 0,
    would,
    undoable: false,
    alarm: n.kind === "alarm",
  });
}

function groupHtml(r: SectionRow): string {
  if (!r.group) return "";
  const li = r.group.lines.map((l) => `<li style="margin:2px 0;">${escapeEmailHtml(l)}</li>`).join("");
  const note = r.group.note ? `<p style="margin:6px 0 0 0;font-size:13.5px;color:${P.muted};">${escapeEmailHtml(r.group.note)}</p>` : "";
  return `<ul style="margin:8px 0 0 0;padding-left:20px;">${li}</ul>${note}`;
}

function moreLine(m: NonNullable<NoteSectionView["more"]>): string {
  return `<p style="margin:10px 0 0 0;font-family:${SANS};font-size:13.5px;line-height:1.5;color:${P.body};">${escapeEmailHtml(m.line)} <a href="${escapeEmailHtml(m.url)}" style="color:${P.ink};font-weight:700;">Open</a></p>`;
}

export function emailNoteSections(n: CgoNoteEmail & { items: readonly NoteItem[] }, headline?: string | null): NoteSectionView[] {
  const sections = noteSections(n.items, {
    wouldChange: n.wouldChange ?? [],
    link: (i) => noteRowFix(i, n.tenantId)?.url ?? null,
    moreUrl: n.growthUrl,
    channelLink: (slug) => channelPageUrl(slug, n.tenantId),
  });
  return sections
    .map((s) => ({
      ...s,
      rows: s.rows.flatMap((r) => {
        const after = r.item && !r.fold ? lineAfterHeadline(r.item, headline) : null;
        if (after === "") return r.url ? [{ ...r, line: "" }] : [];
        return [after == null ? r : { ...r, line: after }];
      }),
    }))
    .filter((s) => s.rows.length > 0 || s.more);
}

function renderItemsEmail(n: CgoNoteEmail & { items: readonly NoteItem[] }): { html: string; text: string; subject: string } {
  const qs = n.questions ?? [];
  const qFor = (r: SectionRow) => (r.question_ordinal != null ? qs.find((q) => q.ordinal === r.question_ordinal) ?? null : null);
  const raw = noteSections(n.items, { wouldChange: [], link: () => null, moreUrl: n.growthUrl });
  const firstNeed = raw.find((s) => s.key === "needs_you")?.rows[0];
  const firstAsk = firstNeed ? qFor(firstNeed)?.ask ?? (firstNeed.group ? null : firstNeed.line) : null;
  const firstDid = raw.filter((s) => DID_SECTIONS.includes(s.key as (typeof DID_SECTIONS)[number])).flatMap((s) => s.rows).find((r) => !r.item?.plans)?.line ?? null;
  const lead = noteLead({ headline: n.headline?.trim() || deriveHeadline(n.items), firstAsk, firstLine: firstDid });
  const sections = emailNoteSections(n, lead);
  const needs = sections.find((s) => s.key === "needs_you");
  const did: DidLine[] = [
    ...sections
      .filter((s) => DID_SECTIONS.includes(s.key as (typeof DID_SECTIONS)[number]))
      .flatMap((s) => [
        ...s.rows.map((r): DidLine => ({ line: r.line, tone: s.key === "changed" ? "done" : "idea", link: r.url && r.item?.plans ? { url: r.url, label: "See plans" } : null })),
      ]),
    ...otherSawLines(n).map((line): DidLine => ({ line, tone: "idea", link: null })),
  ];
  return renderStory(n, {
    company: n.companyName.trim() || "Your company",
    lead,
    goals: n.goals ?? [],
    decisions: (needs?.rows ?? []).map((r) => ({ q: qFor(r), line: r.line, url: r.url, label: r.label ?? null, row: r })),
    decisionsMore: needs?.more ?? null,
    did,
    didHidden: sections.filter((s) => DID_SECTIONS.includes(s.key as (typeof DID_SECTIONS)[number])).reduce((a, s) => a + (s.more?.count ?? 0), 0),
    would: [...(n.wouldChange ?? [])].filter((l) => typeof l === "string" && l.trim()),
    undoable: noteHasUndoable(n.items),
    alarm: n.kind === "alarm",
  });
}
