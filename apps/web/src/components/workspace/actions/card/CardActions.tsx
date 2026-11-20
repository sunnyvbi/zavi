import type { MouseEvent, ReactNode } from "react";
import { ArrowUpRight, Check, Copy, Loader2, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { explainControl } from "../ActionTooltip";
import { CardButton } from "./CardButton";
import type { PrimarySpec } from "./cardPrimary";
import type { CardFlow } from "./useCardFlow";
import { cardButton } from "./styles";

export type SecondaryAction = { key: string; label: string; onClick: () => void; haspopup?: boolean; approve?: boolean };

const actionRow = "ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5";

export function CardActions({ flow, moving, primary, secondary, onRun, onConfirm, onBack, onUndo, onHandoff, busy, blocked, waiting, menu, primaryReplacement }: {
  flow: CardFlow;
  moving?: boolean;
  primary: PrimarySpec | null;
  secondary: SecondaryAction[];
  onRun: (target: HTMLElement) => void;
  onConfirm: () => void;
  onBack?: () => void;
  onUndo?: () => void;
  onHandoff?: () => void;
  busy?: boolean;
  blocked?: boolean;
  waiting?: boolean;
  menu?: ReactNode;
  primaryReplacement?: ReactNode;
}) {
  if (flow.s === "resolved") {
    return (
      <span className={`${actionRow} text-ca-action font-medium`}>
        <span role="status" className={flow.tone === "success" ? "text-ca-success" : "text-ca-secondary"}>{flow.label}</span>
        {moving && <span data-testid="moving-to-history" className="text-ca-secondary motion-safe:animate-pulse">· Moving to History</span>}
        {flow.undo && onUndo && <CardButton variant="ghost" onClick={onUndo}><Undo2 className="size-4" aria-hidden />Undo</CardButton>}
      </span>
    );
  }
  if (flow.s === "confirming" && primary) {
    return (
      <span className={actionRow}>
        {flow.copied && <span role="status" className="px-1 text-ca-action font-medium text-ca-secondary">Copied</span>}
        {primary.mode === "steps" && onBack && <CardButton variant="ghost" onClick={onBack}>Back</CardButton>}
        <CardButton variant="primary" disabled={busy} onClick={onConfirm}>
          <Check className="size-4" aria-hidden />
          {primary.confirm}
        </CardButton>
      </span>
    );
  }
  const working = flow.s === "working";
  const locked = working || !!busy;
  const withHint = (node: ReactNode) => (primary?.describe ? explainControl(node, primary.describe, primary.label) : node);
  return (
    <span className={actionRow}>
      {menu}
      {secondary.map((b) => (
        <CardButton key={b.key} data-approve={b.approve ? true : undefined} disabled={locked} aria-haspopup={b.haspopup ? "dialog" : undefined} onClick={b.onClick}>{b.label}</CardButton>
      ))}
      {primaryReplacement !== undefined ? primaryReplacement : primary?.directLink && primary.href && !blocked ? (
        withHint(
        <a
          href={primary.href}
          target={primary.sameTab ? undefined : "_blank"}
          rel={primary.sameTab ? undefined : "noopener noreferrer"}
          data-testid={primary.testId}
          onClick={primary.handoff ? onHandoff : undefined}
          className={cn(cardButton.base, cardButton.primary)}
        >
          {primary.label}
          {!primary.sameTab && <ArrowUpRight className="size-4" aria-hidden />}
        </a>,
        )
      ) : primary && (
        <CardButton
          variant="primary"
          data-primary
          data-approve={primary.mode === "approve" ? true : undefined}
          data-testid={primary.testId}
          aria-busy={working || undefined}
          aria-disabled={waiting || undefined}
          disabled={locked || blocked}
          onClick={(e: MouseEvent<HTMLButtonElement>) => onRun(e.currentTarget)}
          className={cn(working && "cursor-progress", waiting && "opacity-50")}
        >
          {primary.icon === "copy" && <Copy className="size-4" aria-hidden />}
          {working && primary.mode === "audience" && <Loader2 data-testid="primary-spinner" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {working && primary.mode === "audience" ? "Creating…" : primary.label}
          {primary.icon === "external" && <ArrowUpRight className="size-4" aria-hidden />}
        </CardButton>
      )}
    </span>
  );
}
