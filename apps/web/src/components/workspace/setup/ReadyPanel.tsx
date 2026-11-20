"use client";

import { Check } from "lucide-react";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { useSetupOptional } from "./SetupProvider";
import type { SetupResponse } from "./setupState";
import * as copy from "./setupCopy";
import { NextChevron } from "@/components/ui/NextChevron";

export function showReadyPanel(s: SetupResponse | null, hasPlan: boolean, canManageSetup: boolean): boolean {
  return canManageSetup && !!s && s.enabled === true && s.done && !s.home_seen && hasPlan;
}

export function ReadyPanel() {
  const workspace = useWorkspaceOptional();
  const setup = useSetupOptional();
  return (
    <div className="relative mx-auto w-full max-w-[720px] overflow-hidden rounded-2xl border border-success/25 bg-cream px-6 py-6 compact:px-5 compact:py-5">
      <div aria-hidden className="pointer-events-none absolute -left-16 -top-20 h-56 w-56 rounded-full bg-success/15 blur-3xl" />
      <div className="relative flex items-start gap-4 compact:gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/15 ring-1 ring-success/30">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success text-cream">
            <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-success">Setup complete</p>
          <p className="mt-1 text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink compact:text-[18px] compact:leading-6">{copy.READY_TITLE}</p>
          <p className="mt-1 text-[14px] leading-6 text-inkMuted">{copy.READY_BODY}</p>
          <button
            type="button"
            onClick={async () => {
              try {
                await setup?.mark({ step: "home" });
              } catch (e) {
                console.warn(`[setup] ready card dismissal failed: ${(e as Error).message}`);
              }
              void workspace?.openAgentTab("operator", { newThread: true, push: true });
            }}
            className="mt-4 inline-flex h-11 items-center justify-center gap-1.5 rounded-full bg-ink px-5 text-[15px] font-semibold text-cream transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-2 compact:w-full"
          >
            {copy.GO_HOME} <NextChevron />
          </button>
        </div>
      </div>
    </div>
  );
}
