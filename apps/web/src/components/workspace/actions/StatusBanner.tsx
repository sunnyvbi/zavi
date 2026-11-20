"use client";

import { useState } from "react";
import { Check, CheckCheck, Clock, ExternalLink, Loader2, XCircle } from "lucide-react";
import { receiptLinkLabel } from "@zavi/shared";
import { cn } from "@/lib/cn";
import { ExecFailedBody, execFailedTitle } from "./ActionFooter";
import { CardHistoryDrawer } from "./CardHistoryDrawer";
import { approverLine, clockTime, outcomeLine } from "./statusWords";
import { execInFlight, type ActionItem, type PlatformSpec } from "./types";
import { channelSlipStage } from "./channelSlip";

export const EXEC_SLOW_MS = 20 * 60 * 1000;

const SLOW_LINE = "Taking longer than usual. Zavi is still on it and will update this card.";

export function isSlow(a: ActionItem, now = Date.now()): boolean {
  if (!execInFlight(a) || a.exec_waiting === "approvals") return false;
  const since = a.exec_status === "dispatching" ? (a.exec_started_at ?? a.approval?.at) : a.approval?.at;
  if (!since) return false;
  const t = new Date(since).getTime();
  return Number.isFinite(t) && now - t > EXEC_SLOW_MS;
}

export const STRANDED_MS = 30 * 60 * 1000;

export const STRANDED_LINE = "Zavi never started this change, so nothing was sent. Close this card.";

export function isStranded(a: ActionItem, now = Date.now()): boolean {
  if (a.exec_status !== "queued" || a.exec_waiting === "approvals") return false;
  const since = a.approval?.at;
  if (!since) return false;
  const t = new Date(since).getTime();
  return Number.isFinite(t) && now - t > STRANDED_MS;
}

type Props = {
  a: ActionItem;
  platformName: string;
  execCopy?: PlatformSpec["execCopy"];
  approving?: boolean;
  plain?: boolean;
};

export function hasStatusBanner(a: ActionItem, approving?: boolean): boolean {
  return !!approving || execInFlight(a) || a.exec_status === "executed" || a.exec_status === "failed";
}

export function StatusBanner({ a, platformName, execCopy, approving, plain = false }: Props) {
  const [history, setHistory] = useState(false);
  const executed = a.exec_status === "executed";
  const failed = a.exec_status === "failed";
  if (plain && approving && !execInFlight(a) && !executed) return <p data-testid="exec-state" data-exec="approving" role="status" className="text-ca-action text-ca-secondary">Approving…</p>;
  if (approving && !execInFlight(a) && !executed) return <Working phase="approving" sentence="Approving..." platformName={platformName} />;
  if (execInFlight(a)) {
    const phase = a.exec_status === "queued" ? "queued" : "dispatching";
    if (phase === "dispatching" && a.exec_waiting === "approvals") {
      return (
        <p data-testid="exec-state" data-exec="waiting" role="status" className="border-b border-ca-border bg-ca-subtle px-6 py-4 text-[14px] font-medium text-ca-xdark sm:px-8">
          {execCopy?.waiting ?? "Waiting for an approval."}
        </p>
      );
    }
    const sentence = execCopy?.working ?? (phase === "queued" ? `Approved. Sending to ${platformName}.` : `Zavi is making the change in ${platformName}.`);
    if (isStranded(a)) {
      return (
        <p data-testid="exec-state" data-exec="stranded" role="status" className="border-b border-ca-border bg-ca-subtle px-6 py-4 text-[14px] font-medium text-ca-xdark sm:px-8">
          {STRANDED_LINE}
        </p>
      );
    }
    return <Working phase={phase} sentence={sentence} platformName={platformName} approval={approverLine(a.approval)} slow={isSlow(a)} />;
  }
  if (!executed && !failed) return null;
  const receipt = executed ? (a.exec_receipt ?? null) : null;
  const appliedAt = executed && a.executed_at ? clockTime(a.executed_at) : "";
  const who = approverLine(a.approval);
  const meta = [who, appliedAt ? (who ? `applied ${appliedAt}` : `Applied ${appliedAt}`) : null].filter(Boolean).join(" · ");
  const timeline = a.timeline?.length ? a.timeline : null;
  const partial = failed && channelSlipStage(a) === "partial";
  const tone = executed ? "text-success" : partial ? "text-warn" : "text-danger";
  return (
    <div
      data-testid="exec-state"
      data-exec={executed ? "executed" : "failed"}
      data-partial={partial ? "true" : undefined}
      className={plain ? undefined : cn("border-b px-6 py-4 sm:px-8", executed ? "border-ca-border bg-ca-success-bg" : partial ? "border-ca-border bg-ca-subtle" : "border-ca-border bg-ca-danger/10")}
    >
      <p role="status" className={plain ? "text-ca-facts font-medium text-ca-xdark" : cn("flex items-start gap-2 text-[15px] font-semibold leading-6", tone)}>
        {!plain && (executed ? <CheckCheck className="mt-1 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-1 size-4 shrink-0" aria-hidden />)}
        <span data-testid="exec-title">{executed ? (execCopy?.doneFor?.(a) ?? execCopy?.done ?? `${["tiktok_ads", "chatgpt_ads"].includes(a.channel_slug) ? "Applied" : "Live"} in ${platformName}.`) : execFailedTitle(a, platformName, execCopy)}</span>
      </p>
      <div className={plain ? "mt-1 space-y-1 text-ca-action text-ca-secondary" : "mt-1 space-y-1 pl-6 text-[13px] leading-5 text-ca-dark"}>
        {receipt && (
          <p className="flex flex-wrap items-center gap-x-2">
            <span data-testid="exec-receipt">{receipt.line}</span>
            {receipt.url && (
              <a href={receipt.url} target="_blank" rel="noopener noreferrer" data-testid="exec-receipt-link" className="inline-flex items-center gap-1 font-medium text-ca-xdark underline underline-offset-2">
                {receiptLinkLabel(receipt.url)}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </p>
        )}
        {failed && <ExecFailedBody a={a} platformName={platformName} execCopy={execCopy} />}
        {executed && a.outcome && (
          <p data-testid="exec-outcome" data-verdict={a.outcome.verdict ?? "pending"}>
            {outcomeLine(a.outcome)}
          </p>
        )}
        {(meta || timeline) && (
          <p data-testid="exec-approver" className="flex flex-wrap items-center gap-x-1 text-ca-secondary">
            {meta && <span>{meta}</span>}
            {meta && timeline && <span aria-hidden>·</span>}
            {timeline && (
              <button type="button" data-testid="exec-history" onClick={() => setHistory(true)} className="cursor-pointer font-semibold text-ca-xdark underline underline-offset-2">
                History
              </button>
            )}
          </p>
        )}
      </div>
      {history && timeline && <CardHistoryDrawer a={a} events={timeline} platformName={platformName} onClose={() => setHistory(false)} />}
    </div>
  );
}

const STEPS = ["Approved", "Sending to", "Making the change"] as const;
const STEP_AT = { approving: 0, queued: 1, dispatching: 2 } as const;
const BAR = { approving: "w-[12%]", queued: "w-[40%]", dispatching: "w-[75%]" } as const;

function Working({ phase, sentence, platformName, approval, slow }: { phase: keyof typeof STEP_AT; sentence: string; platformName: string; approval?: string | null; slow?: boolean }) {
  const at = STEP_AT[phase];
  return (
    <div
      data-testid="exec-state"
      data-exec={phase}
      data-slow={slow ? "true" : undefined}
      role="status"
      className={cn("relative border-b px-6 py-4 sm:px-8", slow ? "border-ca-border bg-ca-subtle" : "border-ca-border bg-ca-subtle")}
    >
      <p className={cn("flex items-start gap-2 text-[15px] font-semibold leading-6", slow ? "text-warn" : "text-ca-xdark")}>
        {slow ? <Clock className="mt-1 size-4 shrink-0" aria-hidden /> : <Loader2 className="mt-1 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
        <span data-testid="exec-title">{slow ? SLOW_LINE : sentence}</span>
      </p>
      <ol data-testid="exec-steps" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[13px] text-ca-secondary">
        {STEPS.map((label, i) => (
          <li key={label} data-step-state={i < at ? "done" : i === at ? "now" : "todo"} className={cn("inline-flex items-center gap-1.5", i === at && "font-semibold text-ca-xdark", i < at && "text-ca-dark")}>
            {i > 0 && <span aria-hidden className="text-ca-secondary">→</span>}
            {i < at && <Check className="size-3.5" aria-hidden />}
            {label === "Sending to" ? `Sending to ${platformName}` : label}
          </li>
        ))}
      </ol>
      {approval && <p data-testid="exec-approver" className="mt-1 pl-6 text-[13px] text-ca-secondary">{approval}.</p>}
      <span aria-hidden className={cn("absolute bottom-0 left-0 h-[3px] bg-ca-focus/70 transition-[width] duration-700 ease-out motion-reduce:transition-none", BAR[phase], !slow && "animate-pulse motion-reduce:animate-none")} />
    </div>
  );
}
