"use client";

import { CalendarClock } from "lucide-react";
import { isDraftActionType } from "@zavi/shared";
import { cn } from "@/lib/cn";
import { ActionTooltip } from "../ActionTooltip";
import { actionHint } from "../actionHints";
import { useChannelPlanLock } from "../channelPlanLock";
import { PopMenu } from "../PopMenu";
import type { ActionHandlers, ActionItem } from "../types";
import { SchedulePanel } from "./SchedulePanel";
import { cardIconButton } from "./styles";

const PANEL_HEIGHT = 340;
const footerOf = (button: HTMLElement): Element | null => button.closest('[data-testid="card-footer"]');

export function CardSchedule({ a, onMove, disabled }: { a: ActionItem; onMove?: ActionHandlers["onMovePlanDay"]; disabled?: boolean }) {
  const planLock = useChannelPlanLock();
  if (!onMove || !isDraftActionType(a.action_type) || !("plan_day" in a) || a.status !== "pending") return null;
  const label = a.plan_day ? "Move" : "Schedule";
  const style = cn(cardIconButton, "shrink-0 border border-ca-strong bg-ca-bg text-ca-primary hover:bg-ca-hover aria-expanded:border-ca-border-focus");
  const icon = <CalendarClock className="size-4" aria-hidden />;
  if (planLock?.tierName) {
    return (
      <ActionTooltip description={actionHint(a, "open", `Open upgrade options for ${planLock.tierName} to use scheduling.`)} label={label}>
        <button type="button" aria-label={label} disabled={disabled} onClick={() => planLock.upgrade()} className={style}>{icon}</button>
      </ActionTooltip>
    );
  }
  return (
    <PopMenu
      items={[]}
      panel={(close) => <SchedulePanel action={a} onMove={onMove} onDone={close} />}
      anchor={footerOf}
      placement="below"
      height={PANEL_HEIGHT}
      width="w-80"
      label={label}
      description={actionHint(a, "open", "Open the date picker for this post. Choose a day there to change its planned or scheduled date.")}
      disabled={disabled}
      className={style}
      trigger={() => icon}
    />
  );
}
