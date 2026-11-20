"use client";

import { useState, type ReactNode } from "react";
import type { ActionBodyProps } from "../types";
import { cardAccountId, cardManagerLink, copyAllParts, deliverableOf, deliverableParts, execInFlight, targetKindOf } from "../types";
import { CardActions, type SecondaryAction } from "./CardActions";
import { ConfirmDialog, InfoDialog, TextDialog } from "./CardDialogs";
import { CardEyebrow } from "./CardEyebrow";
import { CardShell } from "./CardShell";
import { cardCopyOf, howItWorks, type CardCopy } from "./cardModel";
import { copyTextOf, primaryOf, type FamilyWords, type PrimaryMode } from "./cardPrimary";
import { AboutBody } from "./AboutBody";
import { CardMoreMenu, cardMenuItems } from "./cardMenu";
import { CardSchedule } from "./CardSchedule";
import { HoldNotices } from "./blocks/HoldNotices";
import { StatusLine } from "./blocks/StatusLine";
import { useCardFlow } from "./useCardFlow";
import { useCardRunner } from "./useCardRunner";
import { useMoveToHistory } from "./useMoveToHistory";
import { useGroupMeta } from "./groupMeta";
import { redoLine as redoText } from "./redoWords";
import type { PostComposer } from "./usePostComposer";
import { Panels, type Panel } from "../ActionFooter";
import { signupPreviewWeeks } from "@/lib/workspace/channelActionsApi";
import { BlanksFill, useBlankFills } from "../BlanksFill";
import { parseEmailDraft } from "../EmailDraft";
import { PartTabs } from "../PartTabs";
import { blanksLine, copyLabel, findBlanks } from "../blanks";
import { useChannelAccount } from "../campaignLinks";
import { audienceSheet } from "../audienceParse";
import { AudienceSheet } from "../AudienceSheet";
import { audienceSteps, isAudienceReviewCard } from "../audienceReview";
import { ANSWER_PLACEHOLDER } from "../channelChat";
import { HowTo } from "../HowTo";
import { ChannelBalance } from "../managed-campaigns/ChannelBalance";
import { hasStatusBanner, isSlow, isStranded, STRANDED_LINE, StatusBanner } from "../StatusBanner";
import { CHECK_CARD_PREFIX } from "../../agent/cardViews";
import { settingAskOf } from "../settingAsk";
import { useSettingAsk } from "../SettingAskInline";

export type SecondaryKey = "edit" | "ask" | "reject" | "notNow" | { redo: string; note: string };

export type FrameSpec = {
  kind: string;
  meta: string[];
  chip?: string | null;
  secondary: SecondaryKey[];
  spendConfirm?: { heading: string; body: string } | null;
  inlineStatus?: boolean;
  simple?: boolean;
  plainSteps?: boolean;
  onEdit?: { label: string; open: () => void } | null;
  body: (copy: CardCopy, edited: string | null) => ReactNode;
};

const SENDS_TEXT = new Set<PrimaryMode>(["copy", "mail", "builder", "developer"]);
const HINT_BOX = "rounded-xl bg-ca-subtle px-4 py-3 text-ca-action font-medium text-ca-xdark";

export function ActionCardFrame({ props, words, spec, composer = null }: { props: ActionBodyProps; words: FamilyWords; spec: FrameSpec; composer?: PostComposer | null }) {
  const { action: a, busy, redoing, platform } = props;
  const handlers = composer?.handlers ?? props.handlers;
  const account = useChannelAccount(a.channel_slug);
  const copy = cardCopyOf(a);
  const audiences = audienceSheet(deliverableOf(a)?.content ?? "");
  const review = isAudienceReviewCard(a);
  const allWords: FamilyWords = {
    ...words,
    walletTopUp: !!platform?.campaignWorkspace,
    publishLabel: composer?.publishLabel ?? null,
    taskHref: platform?.taskLink?.(targetKindOf(a) ?? (audiences ? "audience" : null), account ?? cardAccountId(a)) ?? null,
    taskLabel: platform?.taskLinkLabel ?? null,
    execPartial: words.execPartial && platform?.taskLink ? { ...words.execPartial, href: cardManagerLink(a) ?? platform.taskLink(null, cardAccountId(a) ?? account) ?? words.execPartial.href } : words.execPartial,
  };
  const [edited, setEdited] = useState<string | null>(null);
  const first = primaryOf(a, handlers, allWords);
  const deliverable = deliverableOf(a);
  const kind = deliverable?.kind ?? null;
  const parts = !composer && !a.executable ? deliverableParts(a) : null;
  const [part, setPart] = useState(0);
  const sel = parts ? Math.min(part, parts.length - 1) : 0;
  const raw = composer || a.executable ? null : edited ?? (parts ? parts[sel].content : first?.text ?? copyTextOf(a));
  const subject = deliverable?.label ?? a.title;
  const sheet = spec.simple && !composer && !parts ? (edited ? audienceSheet(edited) : audiences) : null;
  const ownFills = useBlankFills(!raw ? [] : first?.mode === "mail" && !parseEmailDraft(raw) ? [subject, raw] : [raw], kind, a.channel_slug, sheet && !a.executable ? { slug: a.channel_slug, cardId: a.id } : null);
  const fills = composer?.fills ?? ownFills;
  const out = composer ? composer.texts.join("\n\n") : raw ? fills.fill(raw) : first?.text ?? null;
  const primary = composer || raw ? primaryOf(a, handlers, allWords, out, composer?.outText) : first;
  const outgoing = !composer && !!primary && SENDS_TEXT.has(primary.mode);
  if (primary?.mode === "mail" && raw && !parseEmailDraft(raw)) primary.label = copyLabel(a.primary_label ?? "Open email", findBlanks(`${fills.fill(subject)}\n\n${out}`, kind));
  const group = useGroupMeta();
  const { flow, send } = useCardFlow();
  const [dialog, setDialog] = useState<null | "about" | "ask" | "edit" | "spend" | "balance" | "answer">(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [redoNote, setRedoNote] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const runner = useCardRunner({
    a,
    handlers,
    primary,
    send,
    onSteps: () => setStepsOpen(true),
    onHint: setHint,
    onBalance: () => setDialog("balance"),
    onAnswer: () => setDialog("answer"),
    subject: fills.fill(subject),
    publishContent: composer?.publishContent,
  });
  const moving = flow.s === "resolved" && (flow.moving === true || props.settled === true) && !!runner.leave && !execInFlight(a);
  const toHistory = (handlers.inHistory?.(a) ?? true) && !(flow.s === "resolved" && flow.away);
  const ask = useSettingAsk({ slug: a.channel_slug, field: a.channel_slug === "linkedin_ads" ? settingAskOf(a, platform?.settings) : null, busy: busy || flow.s === "working", onSaved: async () => { await runner.panelHandlers.onSetStatus(a, "acted"); } });
  useMoveToHistory({ id: a.id, slug: a.channel_slug, title: copy.title, active: moving, history: toHistory, onGone: () => runner.leave?.() });

  const isCheck = a.id.startsWith(CHECK_CARD_PREFIX);
  const openEdit = spec.onEdit?.open ?? (composer ? composer.openEditor : primary?.text ? () => setDialog("edit") : null);
  const secondary: SecondaryAction[] = spec.secondary.flatMap((k): SecondaryAction[] => {
    if (k === "edit") return openEdit ? [{ key: "edit", label: spec.onEdit?.label ?? "Edit", onClick: openEdit, haspopup: true }] : [];
    if (k === "ask") return handlers.onOpenChat ? [{ key: "ask", label: "Ask Zavi", onClick: () => setDialog("ask"), haspopup: true }] : [];
    if (k === "reject") return isCheck ? [] : [{ key: "reject", label: "Reject", onClick: () => setPanel("reject") }];
    if (k === "notNow") return [];
    return [{ key: k.redo, label: k.redo, onClick: () => { setRedoNote(k.note); void handlers.onRedo(a, k.note); } }];
  });
  if (primary?.mode === "balance" && handlers.onApprove) secondary.push({ key: "approve-after-balance", label: "Balance added, approve & launch", onClick: runner.approve, approve: true });
  const inFlight = execInFlight(a);
  const approving = flow.s === "working" && a.executable && !inFlight;
  const locked = !!busy || flow.s === "working";
  const banner = hasStatusBanner(a, approving) && (!spec.inlineStatus || a.exec_status === "failed") ? (
    <StatusBanner a={a} platformName={platform?.name ?? words.network} execCopy={platform?.execCopy} approving={approving} plain={spec.simple} />
  ) : null;
  const quiet = !!spec.simple && !composer && (primary?.mode === "copy" || !outgoing);
  const waiting = outgoing && fills.left > 0 && !quiet;
  const pointAtBlanks = (target: HTMLElement) => {
    const card = target.closest("article") ?? document;
    const inputs = Array.from(card.querySelectorAll<HTMLInputElement>('[data-testid="blanks-fill"] input'));
    (inputs.find((i) => !i.value.trim()) ?? inputs[0])?.focus();
    setHint(`Fill the ${fills.left} ${fills.left === 1 ? "blank" : "blanks"} in "Fill these in first" above, then press ${primary?.label ?? "the button"} again. To take it as it is, use Copy with blanks in the ··· menu.`);
  };
  const run = (target: HTMLElement) => {
    if (waiting) pointAtBlanks(target);
    else if (spec.spendConfirm && flow.s === "idle") setDialog("spend");
    else runner.run();
  };
  const text = out;
  const copiedBlanks = copiedText === null ? null : composer && copiedText !== text ? null : blanksLine(findBlanks(text, kind));
  const copyAll = parts ? copyAllParts(parts.map((p) => ({ label: p.label, content: fills.fill(p.content) }))) : composer?.copyAll ?? null;
  const menuItems = flow.s === "idle" ? cardMenuItems({
    a,
    handlers: runner.panelHandlers,
    primary,
    disabled: locked,
    post: !!composer,
    directPublish: !!composer?.directPublish,
    manualPost: !!composer?.manualPost,
    canCopy: composer?.canCopy ?? true,
    shown: new Set([...secondary.map((b) => b.key), ...(platform?.noSnooze ? ["notNow"] : [])]),
    text,
    kind,
    copyAll,
    composer: composer?.composerItem ?? null,
    onEdit: openEdit,
    onAsk: () => setDialog("ask"),
    setPanel,
    onCopied: (t) => {
      void navigator.clipboard?.writeText(t).catch(() => undefined);
      setCopiedText(findBlanks(t, kind).length ? t : null);
    },
    onHint: setHint,
  }) : [];
  const menu = <><CardMoreMenu a={a} items={menuItems} disabled={locked} /><CardSchedule a={a} onMove={handlers.onMovePlanDay} disabled={locked} /></>;
  const zaviSide = a.body?.step?.responsibility === "zavi";
  const blockedApproval = props.approvalBlocked && a.executable;
  const approvalNotice = blockedApproval ? (
    <p data-testid="approve-needs-admin" className="ml-auto min-w-0 max-w-sm text-left text-ca-action font-medium text-ca-secondary">
      Only a workspace owner or admin can approve this. Ask one of them to approve it.
    </p>
  ) : undefined;
  const stranded = isStranded(a);
  const flightWords = a.exec_waiting === "approvals" ? platform?.execCopy?.waiting ?? "Waiting for an approval." : stranded ? STRANDED_LINE : isSlow(a) ? "Taking longer than usual. Zavi is still on it." : "Zavi is making this change now.";
  const inlineState = spec.inlineStatus && (inFlight || approving) ? (
    <span data-testid="exec-state" data-exec={inFlight ? a.exec_status ?? undefined : "approving"} className="ml-auto min-w-0 max-w-full text-left">
      <StatusLine tone="muted">{inFlight ? flightWords : "Approving…"}</StatusLine>
    </span>
  ) : null;
  const actions = zaviSide ? (
    <span className="ml-auto min-w-0 max-w-full text-left"><StatusLine tone="muted">Zavi handles this setup. No action needed from you.</StatusLine></span>
  ) : inlineState && (inFlight || props.hideActions) ? inlineState : props.hideActions && a.executable ? null : inFlight ? <span className="ml-auto min-w-0 max-w-full text-left"><StatusLine tone="muted">{flightWords}</StatusLine></span> : (
    <>
    {inlineState}
    <CardActions
      flow={flow}
      moving={moving && toHistory}
      primary={primary}
      secondary={secondary}
      busy={busy}
      blocked={!!composer?.blockedReason}
      waiting={waiting}
      menu={menu}
      primaryReplacement={approvalNotice ?? ask.primary ?? undefined}
      onRun={run}
      onConfirm={runner.confirm}
      onBack={runner.back}
      onHandoff={runner.handoff}
      onUndo={runner.canUndo ? () => void runner.undo() : undefined}
    />
    </>
  );
  const redoLine = redoing ? redoText(redoing, redoNote) : null;
  const shownText = raw && (parts || fills.left < fills.blanks.length) ? fills.fill(raw) : edited;
  const plainBody = sheet
    ? <AudienceSheet label={deliverable?.label ?? null} intro={sheet.intro} audiences={sheet.audiences} fills={fills} />
    : spec.body(copy, shownText);
  const body = composer
    ? composer.wrap(spec.body(copy, composer.display))
    : parts
      ? <PartTabs labels={parts.map((p) => p.label)} selected={sel} onSelect={(i) => { setPart(i); setEdited(null); }} copyText={out ?? ""} copyDisabled={fills.left > 0}>{plainBody}</PartTabs>
      : plainBody;
  const weeks = signupPreviewWeeks(a);
  const flagged = [...spec.meta, ...(group ? [group] : []), ...(weeks !== null ? [`${weeks} wk old`] : [])];
  const pointer = waiting && !hint ? `${fills.left} ${fills.left === 1 ? "blank" : "blanks"} to fill first. Type ${fills.left === 1 ? "it" : "them"} in "Fill these in first" on this card, then press ${primary?.label}.` : null;
  const plainSteps = !!(spec.simple || spec.plainSteps);
  const checklist = !plainSteps && a.card_kind === "task" && a.how_to?.length ? <HowTo a={a} inline /> : undefined;
  return (
    <>
      <CardShell
        id={a.id}
        actionType={a.action_type}
        source={a.source}
        banner={spec.simple ? null : banner}
        dim={(approving || (inFlight && !stranded)) && a.exec_waiting !== "approvals"}
        title={copy.title}
        eyebrow={<CardEyebrow kind={spec.kind} meta={flagged} chip={spec.chip} isNew={props.isNew} />}
        actions={actions}
        steps={review ? audienceSteps(!!handlers.onCreateAudiences) : howItWorks(plainSteps ? [] : a.how_to?.length ? a.how_to : copy.steps, primary?.label ?? null)}
        checklist={checklist}
        onClose={flow.s === "idle" && (!inFlight || stranded) && !busy && !isCheck && !zaviSide && !(props.hideActions && a.executable) ? runner.close : undefined}
        onAbout={() => setDialog("about")}
        stepsOpen={stepsOpen}
        onToggleSteps={() => setStepsOpen((v) => !v)}
      >
        {spec.simple && banner}
        {body}
        {flow.s === "idle" && ask.panel}
        <HoldNotices a={a} />
        {composer?.below}
        {!sheet && !quiet && <BlanksFill fills={fills} />}
        {composer?.error && <p role="alert" className="text-ca-action text-ca-danger">{composer.error}</p>}
        {composer?.statusLine && <p role="status" className={HINT_BOX}>{composer.statusLine}</p>}
        {hint && <p data-testid="primary-hint" role="status" className={HINT_BOX}>{hint}</p>}
        {pointer && <p data-testid="blanks-pointer" className={HINT_BOX}>{pointer}</p>}
        {copiedBlanks && <p data-testid="copy-blanks" role="status" className={HINT_BOX}>{copiedBlanks}</p>}
        <Panels a={a} handlers={runner.panelHandlers} busy={locked} panel={panel} setPanel={setPanel} />
        {redoLine && <p role="status" data-testid="action-redoing" data-redo-state={redoing} className="text-ca-action text-ca-secondary">{redoLine}</p>}
      </CardShell>
      <InfoDialog open={dialog === "about"} title={copy.fullTitle} about={<AboutBody a={a} about={copy.about} edited={edited} steps={review ? audienceSteps(!!handlers.onCreateAudiences) : plainSteps ? a.how_to ?? copy.steps : undefined} />} onClose={() => setDialog(null)} />
      <TextDialog open={dialog === "ask"} heading="Ask Zavi" subtitle={copy.title} initial="" placeholder="Your question" submit="Send" onSubmit={(q) => handlers.onOpenChat?.(a, q)} onClose={() => setDialog(null)} />
      {!composer && <TextDialog open={dialog === "edit"} heading="Edit" subtitle={copy.title} initial={raw ?? ""} rows={8} submit="Save" onSubmit={setEdited} onClose={() => setDialog(null)} />}
      <TextDialog open={dialog === "answer"} heading="Your answer" subtitle={copy.title} initial="" placeholder={ANSWER_PLACEHOLDER} submit="Send" onSubmit={(note) => void handlers.onRedo(a, note, "answer")} onClose={() => setDialog(null)} />
      {composer?.dialog}
      {spec.spendConfirm && primary && (
        <ConfirmDialog open={dialog === "spend"} heading={spec.spendConfirm.heading} body={spec.spendConfirm.body} confirm={primary.label} onConfirm={runner.run} onClose={() => setDialog(null)} />
      )}
      {dialog === "balance" && platform?.campaignWorkspace && <ChannelBalance spec={platform.campaignWorkspace} variant="dialog" onDialogClosed={() => setDialog(null)} />}
    </>
  );
}
