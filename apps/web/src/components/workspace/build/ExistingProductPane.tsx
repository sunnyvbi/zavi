"use client";

import { useCallback, useState } from "react";
import { Wrench } from "lucide-react";
import { lockedTierOf, planUpgradeMessage } from "@/lib/workspace/planUpgrade";
import { CreditWallNotice } from "../CreditWallNotice";
import { useWorkspace } from "../WorkspaceShell";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { RecentBuilds } from "./BuildModePane";
import { ModeComposer, SendCircle } from "../ModeComposer";
import {
  WORKSPACE_MODE_SUGGESTION_CHIPS,
  WorkspaceModeWelcome,
  type SuggestionChip,
} from "../ZaviWelcome";

export const CODE_AGENT = "engineer";

const FIX_MY_SITE_CHIP: SuggestionChip = {
  label: "Fix something on my site",
  prompt: "Fix a bug on my site",
  icon: Wrench,
  color: "text-amber-500",
};

export function existingProductChips(): SuggestionChip[] {
  return [...WORKSPACE_MODE_SUGGESTION_CHIPS.build, FIX_MY_SITE_CHIP];
}

export function ExistingProductPane() {
  const { seedComposer, treeAgents, openBuildTab } = useWorkspace();
  const { sessions = [], currentSessionId = null } = useBuildSessions();
  const [draft, setDraft] = useState("");
  const [blocked, setBlocked] = useState(false);
  const engineerRow = (treeAgents ?? []).find((a) => a.slug === CODE_AGENT);
  const canRun = engineerRow !== undefined && lockedTierOf(engineerRow) === null;

  const open = useCallback(
    (prompt: string) => {
      if (!canRun) {
        setDraft(prompt);
        setBlocked(true);
        return;
      }
      seedComposer({ agentSlug: CODE_AGENT, text: prompt, autoSend: true });
    },
    [seedComposer, canRun],
  );

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    open(text);
  };

  const input = (
    <ModeComposer
      borderless
      value={draft}
      onChange={setDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      }}
      ariaLabel="Describe what you want to build or fix"
      placeholder="Describe what you want to build or fix…"
      trailing={
        <SendCircle onClick={send} disabled={!draft.trim()} ariaLabel="Send" />
      }
    />
  );

  const composer =
    blocked && !canRun ? (
      <>
        {input}
        <div className="mt-3">
          <CreditWallNotice
            inline
            wall={{
              kind: "plan",
              message: planUpgradeMessage(null, lockedTierOf(engineerRow)),
              tier: lockedTierOf(engineerRow),
            }}
          />
        </div>
      </>
    ) : (
      input
    );

  return (
    <WorkspaceModeWelcome
      mode="build"
      composer={composer}
      suggestions={existingProductChips()}
      afterSuggestions={
        sessions.length > 0 ? (
          <RecentBuilds
            sessions={sessions}
            currentSessionId={currentSessionId}
            onOpen={(id) => openBuildTab(id)}
          />
        ) : undefined
      }
      onPickSuggestion={open}
    />
  );
}
