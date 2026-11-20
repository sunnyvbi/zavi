"use client";

import { useWorkspaceOptional } from "../WorkspaceShell";
import { GROWTH_OFFICER_SLUG } from "@/lib/agentRegistry";
import { FAQ_SUGGESTIONS } from "./setupCopy";

export function SetupChatChips({ tabId }: { tabId: string }) {
  const workspace = useWorkspaceOptional();
  if (!workspace) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-rule px-4 py-2.5">
      {FAQ_SUGGESTIONS.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => workspace.seedComposer({ agentSlug: GROWTH_OFFICER_SLUG, tabId, text: q, autoSend: true })}
          className="rounded-full border border-rule bg-cream px-3 py-1.5 text-[13px] font-medium text-inkSoft hover:bg-creamDeep"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
