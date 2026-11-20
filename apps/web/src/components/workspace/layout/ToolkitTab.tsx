"use client";

import { useRef } from "react";
import { useWorkspaceLocation } from "../navigation/useWorkspaceLocation";
import {
  DATA_ACCESS_ENTRY_PARAMS,
  readWorkspaceLocation,
  replaceWorkspaceLocation,
} from "../navigation/workspaceRoutes";
import { SettingsTab } from "../SettingsTab";
import { useWorkspace } from "../WorkspaceShell";
import { DataAccessTab } from "./DataAccessTab";
import { SkillsCreateMenu } from "./SkillsCreateMenu";
import { ToolkitSkills, type ToolkitSkillsHandle } from "./ToolkitSkills";
import { cx, FOCUS_RING } from "./shared";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";

const TABS = [
  { id: "integrations", label: "Integrations" },
  { id: "skills", label: "Skills" },
  { id: "data-access", label: "Data access", adminOnly: true },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ToolkitTab({ active = true }: { active?: boolean }) {
  const location = useWorkspaceLocation();
  const { role } = useWorkspace();
  const skillsRef = useRef<ToolkitSkillsHandle>(null);
  const current = new URL(location, "https://workspace.local");
  const raw = current.hash.slice(1);
  const isAdmin = role === "owner" || role === "admin";
  const tabs = TABS.filter((t) => !("adminOnly" in t) || isAdmin);
  const tab: TabId =
    tabs.find((candidate) => candidate.id === raw)?.id ?? "integrations";
  const entryId =
    DATA_ACCESS_ENTRY_PARAMS.map((k) => current.searchParams.get(k)).find(Boolean) ?? null;
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);
  const selectTab = (id: TabId) => {
    if (!active) return;
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    url.hash = id;
    replaceWorkspaceLocation(`${url.pathname}${url.search}${url.hash}`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-[1080px] shrink-0 items-center justify-between gap-4 px-8 pb-2 pt-5 compact:gap-3 compact:px-4 compact:pt-3">
        <div
          ref={listRef}
          role="tablist"
          aria-label="Connectors"
          className="relative flex items-center gap-7 compact:gap-5"
        >
          <SlidingIndicator box={box} className="border-b-2 border-ink" />
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={cx(
                "relative border-b-2 border-transparent pb-1.5 text-base font-medium transition-colors duration-300 motion-reduce:transition-none compact:min-h-[40px]",
                tab === t.id ? "text-ink" : "text-inkMuted hover:text-ink",
                FOCUS_RING,
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "skills" && role !== "member" && (
          <SkillsCreateMenu
            onUpload={() => skillsRef.current?.startUpload()}
          />
        )}
      </div>
      <div className="ws-scroll min-h-0 flex-1">
        {tab === "integrations" && <SettingsTab only="integration" />}
        {tab === "skills" && <ToolkitSkills ref={skillsRef} />}
        {tab === "data-access" && <DataAccessTab entryId={entryId} />}
      </div>
    </div>
  );
}
