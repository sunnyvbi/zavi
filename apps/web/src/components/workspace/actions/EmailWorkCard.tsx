"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Database } from "lucide-react";
import { requestDatabaseImport } from "../email/emailSettingsNav";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { goToEmailFooterSettings } from "@/lib/workspace/emailCampaignSettingsApi";
import { useBlankFills } from "./BlanksFill";
import { askAgain, blankSource, copyLabel, footerAsk, isFooterBlank, withBlanks } from "./blanks";
import { WithSlots, emailParagraphs, parseEmailDraft } from "./EmailDraft";
import { adSection } from "./ads/adSections";
import { deliverableOf, deliverableParts, execInFlight, type ActionBodyProps, type ActionItem, type PlatformSpec } from "./types";
import { CodeBox, FooterSlot, InlineBlanks, type BoxEmail, type ChipTone } from "../email/EmailWorkDesign";
import { EmailText } from "../email/EmailText";
import { CardShell } from "./card/CardShell";
import { CardEyebrow } from "./card/CardEyebrow";
import { CardButton } from "./card/CardButton";
import { CardActions } from "./card/CardActions";
import { CardMoreMenu, cardMenuItems } from "./card/cardMenu";
import { Panels, type Panel } from "./ActionFooter";
import { InfoDialog } from "./card/CardDialogs";
import { StatusLine } from "./card/blocks/StatusLine";
import { cardText } from "./card/styles";
import { clipText, howItWorks, LEAD_MAX } from "./card/cardModel";
import { useCardFlow } from "./card/useCardFlow";
import { useCardRunner } from "./card/useCardRunner";
import { useMoveToHistory } from "./card/useMoveToHistory";

export function isEmailWorkCard(a: ActionItem, platform: Pick<PlatformSpec, "workCard"> | undefined): boolean {
  return platform?.workCard === true && !a.executable && !a.email_card && a.status === "pending" && !execInFlight(a) && a.exec_status !== "executed" && a.body?.step?.responsibility !== "zavi";
}

function chipFor(a: ActionItem): { tone: ChipTone; label: string } {
  const section = adSection(a);
  if (section === "fix") return a.blocking ? { tone: "block", label: "Blocking" } : { tone: "block", label: "Fix setup" };
  if (section === "improve") return { tone: "improve", label: "Improve results" };
  if (a.action_type === "send_message") return { tone: "reach", label: "Reach out" };
  return { tone: "improve", label: "Improve results" };
}

function kindWord(a: ActionItem, emails: number): string {
  if (emails > 1) return "Automation";
  if (emails === 1) return "Email";
  const target = a.body?.step?.target?.kind;
  if (target === "tracking" || target === "account" || a.action_type === "fix" || a.action_type === "setup") return "Setup";
  if (a.card_kind === "copy_to_site") return "Website";
  return "Plan";
}

function splitTab(label: string, send: string | null): { title: string; when: string | null } {
  const m = label.match(/^\s*(email\s*\d+)\s*[:\-·]?\s*(.*)$/i);
  if (!m) return { title: label, when: send };
  const when = (m[2] || send || "").trim();
  return { title: m[1].replace(/\s+/g, " ").replace(/^e/, "E"), when: when ? when.charAt(0).toUpperCase() + when.slice(1) : null };
}

function withoutFooter(body: string): string {
  const at = body.search(/^\s*--\s*$/m);
  return at > 0 ? body.slice(0, at).trimEnd() : body;
}

function sentences(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((s) => s.trim()).filter(Boolean);
}

export function splitWhy(text: string | null | undefined): { why: string; more: string[] } {
  const all = sentences(text ?? "");
  const why: string[] = [];
  for (const s of all) {
    if (why.length > 0 && (why.join(" ").length + s.length > 170 || why.length >= 2)) break;
    why.push(s);
  }
  return { why: why.join(" "), more: all.slice(why.length) };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function EmailWorkCard({ action: a, handlers, busy }: ActionBodyProps) {
  const role = useWorkspaceOptional()?.role;
  const makeList = a.needs_contact_list === true && (role === "owner" || role === "admin");
  const [tab, setTab] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  const [copied, setCopied] = useState<number[]>([]);
  const [asked, setAsked] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const d = deliverableOf(a);
  const parts = deliverableParts(a);
  const drafts = parts ? parts.map((p) => ({ part: p, draft: parseEmailDraft(p.content) })) : d ? [{ part: { label: d.label ?? "Email", content: d.content }, draft: parseEmailDraft(d.content) }] : [];
  const isEmail = drafts.length > 0 && drafts.every((x) => x.draft);
  const doneSpec = { mode: "done" as const, label: a.done_label ?? "I did this", confirm: a.done_label ?? (isEmail ? "I sent it" : "I did this"), resolved: a.done_label ?? "Done", icon: null, undo: true };
  const { flow, send } = useCardFlow();
  const flowState = useRef(flow.s);
  flowState.current = flow.s;
  const runner = useCardRunner({ a, handlers, primary: doneSpec, send, onSteps: () => undefined });
  useMoveToHistory({ id: a.id, slug: a.channel_slug, title: a.title, active: flow.s === "resolved" && flow.moving === true && !!runner.leave, history: false, onGone: () => runner.leave?.() });
  const [panel, setPanel] = useState<Panel>(null);
  const i = Math.min(tab, Math.max(drafts.length - 1, 0));
  const shown = parts ? parts[i].content : d?.content ?? null;
  const fills = useBlankFills([shown], d?.kind);
  const blanks = new Set(fills.blanks);
  const chip = chipFor(a);
  const step = a.body?.step;
  const r = a.body?.recipient;
  const recipient = r && (r.name || r.channel) ? [r.name, r.channel].filter(Boolean).join(" \u00b7 ") : null;
  const { why, more } = splitWhy(step?.body);
  const details = [...more, ...(a.how_to ?? [])];
  const emails: BoxEmail[] = isEmail
    ? drafts.map(({ part, draft }) => ({
        tab: parts ? splitTab(part.label, draft!.send) : null,
        subject: <WithSlots text={draft!.subject} values={fills.values} active={fills.active} blanks={blanks} />,
        preview: draft!.preview ? <WithSlots text={draft!.preview} values={fills.values} active={fills.active} blanks={blanks} /> : null,
        paragraphs: emailParagraphs(withoutFooter(draft!.body)).map((p) => p.trim()).filter(Boolean).map((p, n) => <WithSlots key={n} text={p} values={fills.values} active={fills.active} blanks={blanks} />),
      }))
    : [];
  const baseLabel = parts && isEmail ? `Copy email ${i + 1}` : parts && parts.length > 1 ? `Copy part ${i + 1}` : a.primary_label && /^copy\b/i.test(a.primary_label) ? a.primary_label : isEmail ? "Copy email" : "Copy";
  const remaining = shown ? fills.blanks.filter((b) => !fills.values[b]?.trim()) : [];
  const ask = footerAsk(remaining, true, fills.ready !== false, fills.footerUnread);
  const footerMissing = ask.footer.missing.length > 0;
  const footerOnly = footerMissing && ask.typed.length === 0;
  const items = ask.typed.length + ask.footer.missing.length;
  const addLabel = ask.footer.missing.length > 1 ? "Add footer details" : ask.footer.missing[0] === "postal_address" ? "Add postal address" : "Add unsubscribe link";
  const blockedLabel = footerMissing ? `Fill ${items} ${items === 1 ? "item" : "items"}` : baseLabel;
  const copyLabelText = footerMissing ? blockedLabel : copyLabel(baseLabel, remaining);
  const footerLines = (shown ? fills.blanks.filter(isFooterBlank) : []).map((b) => ({ source: blankSource(b), value: fills.values[b]?.trim() ?? "", from: fills.typed[b] === undefined ? fills.known[b]?.from : undefined }));
  const footerFilled = footerLines.length > 0 && footerLines.every((l) => l.value) && !ask.footer.reading;
  const footerSlot = footerMissing
    ? <FooterSlot missing={ask.footer.missing} lines={[]} onEdit={goToEmailFooterSettings} />
    : footerFilled
      ? <FooterSlot missing={[]} lines={footerLines.map((l) => l.from ?? l.value)} onEdit={goToEmailFooterSettings} />
      : null;
  const filled = shown ? fills.fill(shown) : "";
  useEffect(() => {
    if (remaining.length === 0) setAsked(false);
  }, [remaining.length]);
  useEffect(() => {
    setSaid(null);
  }, [filled]);
  const valuesKey = JSON.stringify(fills.values);
  useEffect(() => {
    setCopied([]);
    if (flowState.current === "confirming") send({ t: "back" });
  }, [valuesKey, send]);
  const askLine = asked && remaining.length > 0 ? askAgain(ask.typed.length, ask.footer, baseLabel) : null;
  const line = askLine ?? (asked ? null : said);
  const copy = async () => {
    if (!shown) return;
    if (remaining.length > 0) {
      const card = root.current ?? document;
      const inputs = Array.from(card.querySelectorAll<HTMLInputElement>('[data-testid="blanks-fill"] input'));
      const next = inputs.find((x) => !x.value.trim() || x.getAttribute("aria-invalid") === "true") ?? inputs[0] ?? card.querySelector<HTMLElement>('[data-testid="footer-slot"] button');
      next?.scrollIntoView?.({ block: "center" });
      next?.focus();
      setSaid(null);
      setAsked(true);
      return;
    }
    setAsked(false);
    const ok = await copyText(fills.fill(shown));
    const count = parts ? parts.length : 1;
    const got = ok ? Array.from(new Set([...copied, i])) : copied;
    if (ok) setCopied(got);
    if (ok && (parts ? got.length >= parts.length : true)) send({ t: "await", copied: true });
    const next = Array.from({ length: count }, (_, n) => n).find((n) => !got.includes(n));
    const noun = isEmail ? "email" : "part";
    if (ok && next === undefined) return;
    setSaid(withBlanks(ok ? `Copied ${noun} ${i + 1}. Paste it where it goes, then copy ${noun} ${(next ?? 0) + 1}.` : "Your browser blocked copying. Select the text on this card and copy it.", remaining));
  };
  const kind = a.action_type === "send_message" ? "Reach out" : kindWord(a, isEmail ? drafts.length : 0);
  const meta = [chip.label !== kind ? chip.label : null, recipient ? null : step?.target?.ref ?? null].filter((m): m is string => !!m);
  const about = [why, ...details].filter(Boolean).join("\n\n") || a.title;
  const menuItems = cardMenuItems({
    a,
    handlers: runner.panelHandlers,
    primary: doneSpec,
    disabled: !!busy,
    post: true,
    directPublish: false,
    manualPost: false,
    canCopy: false,
    shown: new Set(["ask", ...(isEmail ? [] : ["notNow"])]),
    text: null,
    kind: null,
    copyAll: null,
    composer: null,
    onEdit: null,
    onAsk: () => undefined,
    setPanel,
    onCopied: () => undefined,
    onHint: () => undefined,
  });
  const idle = (
    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5">
      <CardMoreMenu a={a} items={menuItems} disabled={!!busy} />
      {makeList && <CardButton data-testid="email-make-list" disabled={busy} onClick={requestDatabaseImport}><Database className="size-4" aria-hidden />Make the list from your database</CardButton>}
      {isEmail ? (
        handlers.onOpenRedoChat && <CardButton disabled={busy} onClick={() => handlers.onOpenRedoChat?.(a)}>Edit</CardButton>
      ) : (
        <>
          {handlers.onOpenChat && <CardButton disabled={busy} onClick={() => handlers.onOpenChat?.(a)}>Ask Zavi</CardButton>}
          <CardButton disabled={busy} onClick={() => setPanel("snooze")}>Not now</CardButton>
        </>
      )}
      {shown ? (
        footerOnly ? (
          <CardButton variant="primary" data-primary data-testid="footer-add" disabled={busy} onClick={goToEmailFooterSettings}>{addLabel}</CardButton>
        ) : (
          <CardButton variant="primary" data-primary disabled={busy} aria-disabled={remaining.length > 0 || undefined} aria-label={remaining.length > 0 ? copyLabelText : undefined} className={remaining.length > 0 ? "opacity-50" : undefined} onClick={() => void copy()}>
            {footerMissing ? null : <Copy className="size-4" aria-hidden />}
            {footerMissing ? blockedLabel : baseLabel}
            {remaining.length > 0 && !footerMissing && (
              <span data-testid="copy-blank-count" aria-hidden className="-ml-0.5 rounded-full bg-ca-on-action/20 px-1.5 text-ca-eyebrow font-medium tabular-nums">
                {remaining.length} {remaining.length === 1 ? "blank" : "blanks"}
              </span>
            )}
          </CardButton>
        )
      ) : (
        <CardButton variant="primary" data-primary data-done disabled={busy} onClick={() => send({ t: "await" })}>{doneSpec.label}</CardButton>
      )}
    </span>
  );
  const actions = flow.s === "idle" || flow.s === "working" ? idle : (
    <CardActions flow={flow} primary={doneSpec} secondary={[]} busy={busy} onRun={() => undefined} onConfirm={runner.confirm} onUndo={runner.canUndo ? () => void runner.undo() : undefined} />
  );
  return (
    <div ref={root} data-email-work-card="true" data-action-type={a.action_type}>
      <CardShell
        id={a.id}
        title={a.title}
        eyebrow={<CardEyebrow kind={kind} meta={meta} chip={a.blocking ? "Do this first" : null} />}
        actions={actions}
        steps={howItWorks(a.how_to ?? [], shown ? baseLabel : doneSpec.label)}
        onClose={flow.s === "idle" ? runner.snooze : undefined}
        onAbout={() => setAboutOpen(true)}
      >
        {recipient && <p data-testid="message-recipient" className="text-ca-label font-semibold text-ca-xdark">To {recipient}</p>}
        {why && !isEmail && <p className={cardText.body}>{clipText(why, LEAD_MAX)}</p>}
        {isEmail ? (
          <EmailText emails={emails} selected={i} onSelect={(n) => { setTab(n); setSaid(null); setAsked(false); }} extra={fills.blanks.length > 0 || footerSlot ? <>{footerSlot}{fills.blanks.length > 0 && <InlineBlanks fills={fills} />}</> : null} />
        ) : shown ? (
          <CodeBox
            label={d?.label ?? null}
            content={fills.fill(shown)}
            mono={d?.kind === "code"}
            tabs={parts && parts.length > 1 ? parts.map((p, n) => p.label?.trim() || `Part ${n + 1}`) : undefined}
            selected={i}
            onSelect={(n) => { setTab(n); setSaid(null); setAsked(false); }}
            blanks={fills.blanks.length > 0 ? <>{footerSlot}<InlineBlanks fills={fills} /></> : undefined} />
        ) : null}
        {line && <StatusLine tone="muted">{line}</StatusLine>}
        <Panels a={a} handlers={runner.panelHandlers} busy={busy} panel={panel} setPanel={setPanel} />
      </CardShell>
      <InfoDialog open={aboutOpen} title={a.title} about={about} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
