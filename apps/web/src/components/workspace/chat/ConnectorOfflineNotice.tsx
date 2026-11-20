"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { WifiOff } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import { ANSWER_WITHOUT_DATA_TEXT, lastSeenLine, type ConnectorOfflineInfo } from "../actions/dbChatCards";

export function ConnectorOfflineNotice({
  info,
  agentSlug,
  isLast,
}: {
  info: ConnectorOfflineInfo;
  agentSlug: string | null;
  isLast: boolean;
}) {
  const { seedComposer } = useWorkspace();
  const [sent, setSent] = useState(false);
  const send = (text: string) => {
    if (sent || !agentSlug) return;
    setSent(true);
    seedComposer({ agentSlug, text, autoSend: true });
  };
  const actions = isLast && !!agentSlug;

  return (
    <div data-testid="connector-offline-card" className="mt-2 rounded-xl border border-warn bg-warnBg p-4">
      <div className="flex items-start gap-3">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-ink">Your connector is offline</div>
          <p className="mt-1 text-sm leading-relaxed text-inkMuted">
            {lastSeenLine(info)} Retry once it is back, or get an answer that does not use your data.
          </p>
          {actions && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => info.retryText && send(info.retryText)}
                disabled={sent || !info.retryText}
                variant="primary"
              >
                Retry
              </Button>
              <Button
                type="button"
                onClick={() => send(ANSWER_WITHOUT_DATA_TEXT)}
                disabled={sent}
                variant="secondary"
              >
                Answer without your data
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
