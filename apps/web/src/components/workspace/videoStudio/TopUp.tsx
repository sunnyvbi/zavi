"use client";

import { BILLING_URL } from "@/components/workspace/CreditRefusalNotice";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { isMember } from "@/lib/members";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { cx, FOCUS_RING } from "../layout/shared";

export function TopUp({ className, testId }: { className: string; testId?: string }) {
  const ws = useWorkspaceOptional();
  if (ws && isMember(ws.role ?? null)) {
    return (
      <span data-testid={testId} className={cx(className, "font-normal text-inkMuted no-underline")}>
        Ask your workspace owner to add credits.
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        if (ws) openBillingSettings(ws.openTab);
        else window.location.href = BILLING_URL;
      }}
      className={cx(className, FOCUS_RING)}
    >
      Top up credits
    </button>
  );
}
