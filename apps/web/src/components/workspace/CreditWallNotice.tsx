"use client";

import { isMember } from "@/lib/members";
import { openBillingSettings, wallBillingTarget } from "@/lib/workspace/openBilling";
import { useWorkspace } from "./WorkspaceShell";
import { cx, FOCUS_RING } from "./layout/shared";

export type CreditWall = {
  message: string;
  kind: "credits" | "plan";
  tier?: string | null;
};

export function CreditWallNotice({
  wall,
  inline = false,
}: {
  wall: CreditWall;
  inline?: boolean;
}) {
  const { role, openTab } = useWorkspace();
  const canManageBilling = !isMember(role);
  return (
    <div
      role="alert"
      className={cx(
        "w-full",
        inline ? "mb-3" : "mx-auto max-w-3xl px-6 pb-2 compact:px-4",
      )}
    >
      <div className="flex w-full min-w-0 gap-3">
        {}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-[18rem]">
            <div className="whitespace-pre-wrap break-words text-[14px] leading-[24.75px] tracking-[-0.2344px] text-ink">
              {wall.message}
              {!canManageBilling &&
                (wall.kind === "plan"
                  ? " Ask your workspace owner to upgrade the plan."
                  : " Ask your workspace owner to add credits.")}
            </div>
          </div>
          {canManageBilling && (
            <button
              type="button"
              onClick={() => openBillingSettings(openTab, wallBillingTarget(wall.kind, wall.tier))}
              className={cx(
                "inline-flex shrink-0 items-center rounded-full bg-ink px-4 py-2 text-[14px] font-semibold text-cream transition-opacity hover:opacity-90 motion-reduce:transition-none",
                FOCUS_RING,
              )}
            >
              {wall.kind === "plan" ? "See plans" : "Buy Credits"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
