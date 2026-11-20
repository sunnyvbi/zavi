"use client";

import { useState, type ReactNode } from "react";
import { useOpenStatic, FOCUS_RING, cx } from "../layout/shared";
import { useActiveTenant } from "../brain/useActiveTenant";
import { useSetupOptional } from "./SetupProvider";
import * as copy from "./setupCopy";
import { NextChevron } from "@/components/ui/NextChevron";

export const buildPanelDismissedKey = (tenantId: string) =>
  `zavi.buildSetupPanel.dismissed.${tenantId}`;

function readDismissed(tenantId: string): boolean {
  try {
    return window.sessionStorage.getItem(buildPanelDismissedKey(tenantId)) === "1";
  } catch {
    return false;
  }
}

function saveDismissed(tenantId: string): void {
  try {
    window.sessionStorage.setItem(buildPanelDismissedKey(tenantId), "1");
  } catch {
    return;
  }
}

export function BuildSetupFrame({ children }: { children: ReactNode }) {
  const setup = useSetupOptional();
  const openStatic = useOpenStatic();
  const tenantId = useActiveTenant();
  const [dismissedIn, setDismissedIn] = useState<string[]>([]);
  const dismissed =
    typeof tenantId === "string" &&
    (dismissedIn.includes(tenantId) || readDismissed(tenantId));
  const show =
    !!setup?.locked && setup.buildOpen && !(setup.state?.enabled === true && setup.state.from_scratch) && typeof tenantId === "string" && !dismissed;
  const dismiss = () => {
    if (typeof tenantId !== "string") return;
    saveDismissed(tenantId);
    setDismissedIn((prev) => [...prev, tenantId]);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {show && (
        <aside
          aria-label={copy.BUILD_PANEL_TITLE}
          className="mx-3 mt-3 shrink-0 rounded-xl border border-rule bg-bone px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ink">
              {copy.BUILD_PANEL_TITLE}
            </p>
            <p className="mt-0.5 text-[13px] leading-5 text-inkMuted">
              {copy.BUILD_PANEL_BODY}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => openStatic("autopilot")}
                className={cx(
                  "inline-flex items-center gap-1 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-cream hover:opacity-90",
                  FOCUS_RING,
                )}
              >
                {copy.BUILD_PANEL_CONTINUE}{" "}
                <NextChevron />
              </button>
              <button
                type="button"
                onClick={dismiss}
                className={cx(
                  "rounded-cta px-2 py-1.5 text-[13px] font-medium text-inkMuted hover:text-ink",
                  FOCUS_RING,
                )}
              >
                {copy.BUILD_PANEL_DISMISS}
              </button>
            </div>
          </div>
        </aside>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
