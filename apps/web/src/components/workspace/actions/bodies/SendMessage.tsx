"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function SendMessage(props: ActionBodyProps) {
  const r = props.action.body?.recipient;
  const extra =
    r && (r.name || r.channel) ? (
      <p data-testid="message-recipient" className="text-[16px] text-inkSoft">
        <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">To</span>
        {[r.name, r.channel].filter(Boolean).join(" · ")}
      </p>
    ) : null;
  return <ActionCard {...props} kindLabel="Message" deliverableLabel="Message" extra={extra} />;
}
