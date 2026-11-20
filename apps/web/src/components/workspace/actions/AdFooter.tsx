"use client";

import { useState, type ReactNode } from "react";
import { isPartialRiskExecCode } from "@zavi/shared";
import { Check, Copy, Download, ExternalLink, Mail, MessageSquare, MoreHorizontal, SquarePen, X } from "lucide-react";
import { Panels, rewriteItem, snoozeItem, type Panel } from "./ActionFooter";
import { StatusBanner, hasStatusBanner } from "./StatusBanner";
import { PopMenu, type PopMenuItem } from "./PopMenu";
import { ActionTooltip, explainControl } from "./ActionTooltip";
import { actionHint, type ActionOperation } from "./actionHints";
import { btn } from "./ui";
import { useStoredPrimary } from "./StoredPrimary";
import { PostVideoButton } from "./PostVideoButton";
import { blanksLine, copyLabel, findBlanks } from "./blanks";
import { devMail, isDeveloperCard, openDevMail } from "./devMail";
import { execInFlight, mediaOf, type ActionHandlers, type ActionItem, type PlatformSpec } from "./types";
import { CHECK_CARD_PREFIX } from "../agent/cardViews";
import { useAdsPresentation } from "./ads/AdsPresentation";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { isAdTask } from "./ads/adSections";
import { ChannelBalance } from "./managed-campaigns/ChannelBalance";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import type { CampaignWorkspaceSpec } from "./managed-campaigns/types";

export function AskZavi({ a, onClick, disabled }: { a: ActionItem; onClick: () => void; disabled?: boolean }) {
  return (
    <ActionTooltip description={actionHint(a, "ask")} label="Ask Zavi">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-cta border border-rule bg-cream px-3.5 text-[14px] font-medium text-ink hover:bg-creamDeep disabled:opacity-50"
      >
        <MessageSquare className="h-4 w-4" aria-hidden />
        Ask Zavi
      </button>
    </ActionTooltip>
  );
}

export function MoreActions({ a, items, disabled }: { a: ActionItem; items: PopMenuItem[]; disabled?: boolean }) {
  const ads = useAdsPresentation();
  if (!items.length) return null;
  return (
    <PopMenu
      description={actionHint(a, "more")}
      tooltipClassName={ads ? undefined : "ml-auto"}
      items={items}
      width="w-72"
      label="More actions"
      disabled={disabled}
      className={cn("grid cursor-pointer place-items-center text-inkMuted hover:bg-creamDeep hover:text-ink disabled:opacity-50", ads ? "size-10 rounded-full border border-rule" : "ml-auto size-9 rounded-lg")}
      trigger={() => <MoreHorizontal className="h-4 w-4" aria-hidden />}
    />
  );
}

export function SplitFooterRow({ children }: { children: ReactNode }) {
  const ads = useAdsPresentation();
  return (
    <div data-testid="split-footer-row" className={cn("flex flex-wrap items-center", ads ? "gap-3" : "gap-2")}>
      {children}
    </div>
  );
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
  }
}

export { outcomeLine } from "./statusWords";

function HeldRow({ held }: { held: NonNullable<ActionItem["held"]> }) {
  return (
    <p data-testid="held-for-you" className="border-t border-rule px-4 py-4 text-[14px] text-ink sm:px-4">
      <span className="font-medium">Held for you: {held.words.join("; ")}.</span>
      {held.evidence && <span className="text-inkMuted"> {held.evidence}</span>}
    </p>
  );
}

function CapWarningRow({ text }: { text: string }) {
  return (
    <p data-testid="cap-warning" role="status" className="border-t border-rule px-4 py-4 text-[14px] text-danger sm:px-4">
      <span className="font-medium">{text}.</span> <span className="text-inkMuted">Autopilot won't add spend while you're over; approving it is your call.</span>
    </p>
  );
}

type FooterProps = {
  a: ActionItem;
  handlers: ActionHandlers;
  busy?: boolean;
  link: string | null;
  fallbackLink?: string | null;
  fallbackLabel?: string | null;
  platformName: string;
  execCopy?: PlatformSpec["execCopy"];
  execPartial?: PlatformSpec["execPartial"];
  approveLabel: string;
  copyText?: string | null;
  copyAllText?: string | null;
  copyKind?: string | null;
  subject?: string;
  onShowSteps?: () => void;
  pickIndex?: number | null;
  campaignWorkspace?: CampaignWorkspaceSpec;
  approving?: boolean;
  settingAsk?: ReactNode;
  lockPrimary?: string | null;
  hideActions?: boolean;
};

export function actionFooterParts(p: FooterProps): { footer: ReactNode; status: ReactNode; banner: ReactNode } {
  const { a, platformName } = p;
  if (a.body?.step?.responsibility === "zavi") return {
    footer: <span className="text-sm text-inkMuted">Zavi handles this setup. No action needed from you.</span>, status: null, banner: null,
  };
  const banner = hasStatusBanner(a, p.approving) ? <StatusBanner a={a} platformName={platformName} execCopy={p.execCopy} approving={p.approving} /> : null;
  if (execInFlight(a)) return { footer: null, status: null, banner };
  if (a.exec_status === "executed" && p.execCopy) {
    return {
      footer: (
        <SplitFooterRow>
          {(() => {
            const m = mediaOf(a);
            if (m?.kind !== "video") return null;
            return (
              <>
                {m.artifactId && !p.hideActions && <PostVideoButton artifactId={m.artifactId} title={a.title} />}
                <ActionTooltip description={actionHint(a, "download")} label="Download video">
                  <a href={m.downloadUrl ?? m.url} download data-testid="video-download" className={`${m.artifactId ? btn.secondary : btn.primary} inline-flex items-center gap-2`}>
                    <Download className="h-4 w-4" aria-hidden />
                    Download video
                  </a>
                </ActionTooltip>
              </>
            );
          })()}
        </SplitFooterRow>
      ),
      status: null,
      banner,
    };
  }
  if (a.exec_status === "executed") return { footer: null, status: null, banner };
  if (a.exec_status === "failed" && a.status !== "pending") return { footer: null, status: null, banner };
  const held = a.status === "pending" && a.exec_status == null && a.held?.words.length ? a.held : null;
  const capWarning = a.status === "pending" && (a.exec_status == null || a.exec_status === "failed") && a.cap_warning ? a.cap_warning : null;
  return {
    footer: p.hideActions && a.executable ? null : <SplitActionControls {...p} busy={p.busy || p.approving} />,
    status: held || capWarning ? <>{held && <HeldRow held={held} />}{capWarning && <CapWarningRow text={capWarning} />}</> : null,
    banner,
  };
}

function SplitActionControls({ a, handlers, busy, link, fallbackLink, fallbackLabel, platformName, execPartial, approveLabel, copyText, copyAllText, copyKind, subject, onShowSteps, pickIndex, campaignWorkspace, settingAsk, lockPrimary }: FooterProps) {
  const stored = !a.executable && !!a.card_kind && a.card_kind !== "executes" && !!a.primary_label;
  const ads = useAdsPresentation();
  const role = useWorkspaceOptional()?.role ?? null;
  const storedPrimary = useStoredPrimary({ a, handlers, busy, link, fallbackLink, fallbackLabel, copyText: copyText ?? null, copyKind, subject: subject ?? a.title, onShowSteps, pickIndex });
  const blanks = findBlanks(copyText, copyKind);
  const [copiedWithBlanks, setCopiedWithBlanks] = useState(false);
  const copiedBlanks = copiedWithBlanks ? blanksLine(blanks) : null;
  const [mailHint, setMailHint] = useState<string | null>(null);
  const [addingBalance, setAddingBalance] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const mailsDev = isDeveloperCard(a) && !a.executable && a.card_kind !== "task" && !!copyText;
  const primaryIsDone = !stored && !a.executable && (!link || !approveLabel);
  const markDone = () => void handlers.onSetStatus(a, "acted");
  const doneWords = a.executable ? "I did this" : (a.done_label ?? "I did this");
  let primary: ReactNode = null;
  let beside: ReactNode = null;
  let operation: ActionOperation = "open";
  let primaryHintLabel = approveLabel;
  if (settingAsk && !a.executable) {
    operation = "done";
    primaryHintLabel = "Save";
    primary = settingAsk;
  } else if (handlers.onReviewExecute && !a.executable) {
    operation = "review";
    primaryHintLabel = "Review and create";
    primary = <button type="button" data-primary disabled={busy} onClick={handlers.onReviewExecute} className={btn.primary}>Review and create</button>;
  } else if (stored) {
    primary = storedPrimary.primary;
  } else if (primaryIsDone) {
    operation = "done";
    primaryHintLabel = "I did this";
    primary = (
      <button type="button" disabled={busy} onClick={markDone} className={`${btn.primary} inline-flex items-center gap-2`}>
        <Check className="h-4 w-4" aria-hidden />I did this
      </button>
    );
  } else if (
    a.executable &&
    a.exec_status === "failed" &&
    (isPartialRiskExecCode(a.exec_code) || a.exec_bucket === "partial_risk" || a.exec_bucket === "blocked_on_us")
  ) {
    primaryHintLabel = (a.exec_managed ? undefined : execPartial?.label) ?? approveLabel;
    primary = execPartial && a.exec_bucket !== "blocked_on_us" && !a.exec_managed ? (
      <a href={execPartial.href} data-testid="exec-partial-link" className={`${btn.primary} inline-flex items-center gap-2`}>
        {execPartial.label}
      </a>
    ) : null;
  } else if (a.executable && a.exec_status !== "failed" && a.held?.wallet_short && campaignWorkspace) {
    primaryHintLabel = "Add balance";
    primary = (
      <button type="button" data-testid="held-add-balance" disabled={busy} onClick={() => setAddingBalance(true)} className={btn.primary}>
        Add balance
      </button>
    );
    beside = (
      <button type="button" data-approve disabled={busy || !handlers.onApprove} onClick={() => void handlers.onApprove?.(a)} className={btn.secondary}>
        Balance added, approve & launch
      </button>
    );
  } else if (a.executable && a.approve_needs_admin && isMember(role)) {
    primaryHintLabel = "Owner or admin approves";
    primary = (
      <p data-testid="approve-needs-admin" className="text-[14px] font-medium text-inkMuted">
        Only a workspace owner or admin can approve this. Ask one of them to approve it.
      </p>
    );
  } else if (a.executable) {
    operation = "approve";
    primaryHintLabel = a.exec_status === "failed" ? "Try again" : a.primary_label ?? approveLabel;
    primary = approveLabel ? (
      <button type="button" data-approve disabled={busy || !handlers.onApprove} onClick={() => void handlers.onApprove?.(a)} className={btn.primary}>
        {a.exec_status === "failed" ? "Try again" : (a.primary_label ?? approveLabel)}
      </button>
    ) : null;
  } else if (link && approveLabel) {
    primary = (
      <a href={link} target="_blank" rel="noopener noreferrer" title={`Opens ${platformName}`} className={`${btn.primary} inline-flex items-center gap-2`}>
        {approveLabel}
        {}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    );
  }
  const more: PopMenuItem[] = [
    ...(ads && handlers.onOpenChat ? [{ label: "Ask Zavi", tooltip: actionHint(a, "ask"), icon: <MessageSquare className="size-4" aria-hidden />, onSelect: () => handlers.onOpenChat?.(a) }] : []),
    ...(copyText
      ? [
          {
            label: blanks.length ? "Copy with blanks" : "Copy",
            tooltip: actionHint(a, "copy", blanks.length ? "Copy the current text including its unfilled blanks. Fill them before publishing or sending it." : undefined),
            hint: blanks.length ? copyLabel("Copies it as it is", blanks) : copyAllText ? "Copies the part on screen" : "Copies the text on this card",
            icon: <Copy className="h-4 w-4" aria-hidden />,
            onSelect: () => {
              void copyToClipboard(copyText);
              setCopiedWithBlanks(blanks.length > 0);
            },
          },
        ]
      : []),
    ...(copyAllText
      ? [
          {
            label: "Copy all",
            tooltip: actionHint(a, "copyAll", findBlanks(copyAllText, copyKind).length ? "Fill the blanks in every part before copying all parts." : undefined),
            ...(findBlanks(copyAllText, copyKind).length
              ? { hint: "Fill the blanks in each part first", disabled: true }
              : { hint: "Copies every part, each under its label" }),
            icon: <Copy className="h-4 w-4" aria-hidden />,
            onSelect: () => void copyToClipboard(copyAllText),
          },
        ]
      : []),
    ...(mailsDev
      ? [
          {
            label: "Email this to your developer",
            tooltip: actionHint(a, "email"),
            hint: "Opens your mail app with the steps and the text",
            icon: <Mail className="h-4 w-4" aria-hidden />,
            onSelect: () => void openDevMail(devMail(a, { link, content: copyText })).then(setMailHint),
            disabled: blanks.length > 0,
          },
        ]
      : []),
    ...(!primaryIsDone ? [{ label: doneWords, tooltip: actionHint(a, "done"), icon: <Check className="h-4 w-4" aria-hidden />, onSelect: markDone, disabled: busy }] : []),
    ...(!a.id.startsWith(CHECK_CARD_PREFIX)
      ? [snoozeItem(setPanel, busy, a), ...(!a.executable && handlers.onOpenRedoChat ? [rewriteItem(a, handlers)] : [])]
      : []),
  ];
  return (
    <>
      <Panels a={a} handlers={handlers} busy={busy} panel={panel} setPanel={setPanel} />
      <SplitFooterRow>
        {primary && lockPrimary ? (
          <span data-testid="primary-locked" title={lockPrimary} className="inline-flex cursor-not-allowed">
            <span inert className="inline-flex opacity-50">
              {primary}
            </span>
          </span>
        ) : stored && !handlers.onReviewExecute ? (
          primary
        ) : (
          explainControl(primary, actionHint(a, operation), primaryHintLabel)
        )}
        {beside && explainControl(beside, actionHint(a, "approve"), "Balance added, approve & launch")}
        {handlers.onOpenChat && !ads && <AskZavi a={a} onClick={() => handlers.onOpenChat?.(a)} />}
        {ads && a.action_type === "create_ad" && !a.executable && handlers.onReviewExecute && <Button disabled={busy} onClick={() => handlers.onReviewExecute?.()} className="h-10 rounded-xl border-rule px-4 text-sm font-semibold"><SquarePen className="size-4" aria-hidden />Edit ad</Button>}
        {ads && !isAdTask(a) && a.status === "pending" && !a.id.startsWith(CHECK_CARD_PREFIX) && <ActionTooltip description={actionHint(a, "reject")} label="Reject"><Button disabled={busy} onClick={() => setPanel(panel === "reject" ? null : "reject")} className="h-10 rounded-xl border-rule px-4 text-sm font-semibold"><X className="size-4" aria-hidden />Reject</Button></ActionTooltip>}
        <MoreActions a={a} items={more} />
      </SplitFooterRow>
      {addingBalance && campaignWorkspace && <ChannelBalance spec={campaignWorkspace} variant="dialog" onDialogClosed={() => setAddingBalance(false)} />}
      {stored && storedPrimary.hint}
      {mailHint && (
        <p data-testid="dev-mail-hint" role="status" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] font-medium text-ink">
          {mailHint}
        </p>
      )}
      {copiedBlanks && (
        <p data-testid="copy-blanks" role="status" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] font-medium text-ink">
          {copiedBlanks}
        </p>
      )}
    </>
  );
}
