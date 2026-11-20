"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { NextChevron } from "@/components/ui/NextChevron";
import { useSetupOptional } from "./SetupProvider";
import { strategyCardState } from "./setupState";
import * as copy from "./setupCopy";
import { CGO_LABEL } from "../layout/shared";

const POLL_MS = 10_000;

export function StrategyProgressNotice({ embedded = false }: { embedded?: boolean }) {
  const setup = useSetupOptional();
  const workspace = useWorkspaceOptional();
  const card = strategyCardState(setup?.state ?? null, !!setup?.canManageSetup, !!setup?.draftStartFailed && !setup.draftStarting);
  const refresh = setup?.refresh;

  useEffect(() => {
    if (card !== "writing" || !refresh) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [card, refresh]);

  if (!card || !workspace || !setup) return null;

  const openStrategy = () => {
    if (card === "ready") {
      void setup.mark({ step: "home" }).catch((e: Error) => console.warn(`[setup] strategy card dismissal failed: ${e.message}`));
    } else if (setup.state?.enabled === true && setup.state.draft.status === "none") {
      void setup.startDraft(false);
    }
    workspace.openTab({
      kind: "autopilot",
      title: CGO_LABEL,
      payload: { kind: "autopilot" },
      dirty: false,
      pinned: false,
    });
  };

  const label = card === "writing" ? copy.STRATEGY_CARD_WRITING : card === "ready" ? copy.STRATEGY_CARD_READY : copy.STRATEGY_CARD_FAILED;
  const icon =
    card === "writing" ? (
      <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-inkMuted motion-reduce:animate-none" />
    ) : (
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", card === "ready" ? "bg-success" : "bg-warn")} />
    );
  const wrap = embedded ? "mb-4 flex shrink-0 justify-center font-sans" : "shrink-0 px-4 pb-2 pt-1 font-sans";
  const surface = embedded
    ? "inline-flex min-h-9 max-w-full flex-wrap items-center gap-2.5 rounded-xl border border-rule bg-cream px-4 py-2 text-left text-detail leading-5"
    : "mx-auto flex min-h-10 w-full flex-wrap items-center gap-2.5 rounded-2xl border border-rule bg-cream px-3.5 py-1.5 text-left font-sans text-detail leading-5 shadow-notice";
  const text = cn("min-w-0 flex-1 truncate", embedded ? "text-inkSoft" : "text-inkMuted");

  return (
    <div className={wrap}>
      <div className={embedded ? "" : "mx-auto w-full max-w-2xl"}>
        {card === "writing" ? (
          <div role="status" data-testid="strategy-progress-card" data-state={card} className={surface}>
            {icon}
            <span className={text}>{label}</span>
            <span className="shrink-0 text-inkMuted">{copy.STRATEGY_CARD_WRITING_DETAIL}</span>
          </div>
        ) : (
          <Button
            type="button"
            data-testid="strategy-progress-card"
            data-state={card}
            onClick={openStrategy}
            className={cn("group cursor-pointer justify-start transition-colors hover:border-inkMuted/40 hover:bg-creamDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink", surface)}
          >
            {icon}
            <span className={text}>{label}</span>
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ink">
              {copy.STRATEGY_CARD_OPEN}
              <NextChevron className="transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5 motion-reduce:transition-none" />
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}
