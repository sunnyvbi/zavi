"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Columns2 } from "lucide-react";
import { AgentTab } from "./AgentTab";
import { ProPlanGate } from "./ProPlanGate";
import { PaneViewSwitch } from "./PaneViewSwitch";
import { useResizablePane } from "@/hooks/useResizablePane";
import { agentDisplayName } from "@/lib/agentRegistry";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

const CHAT_MIN_PX = 340;
const CHAT_DEFAULT_PX = 460;
const CHAT_MAX_FRACTION = 0.55;
const SPLIT_MIN_VIEWPORT = 1024;

export function AgentPageTab({
  slug,
  Dashboard,
  tabId,
  isActive = true,
}: {
  slug: string;
  Dashboard: ComponentType;
  tabId: string;
  isActive?: boolean;
}) {
  const openKey = `zavi.agentPage.${slug}.chatOpen`;
  const [chatOpen, setChatOpenState] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(openKey) === "0") setChatOpenState(false);
    } catch {
    }
  }, [openKey]);
  const setChatOpen = (update: (v: boolean) => boolean) => {
    setChatOpenState((prev) => {
      const next = update(prev);
      try {
        window.localStorage.setItem(openKey, next ? "1" : "0");
      } catch {
      }
      return next;
    });
  };
  const [wideEnough, setWideEnough] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const name = agentDisplayName(slug);
  const panelId = `agent-page-chat-${slug}`;

  useEffect(() => {
    const read = () => setWideEnough(window.innerWidth >= SPLIT_MIN_VIEWPORT);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const { sizePx, dragging, startResize, separatorProps } = useResizablePane({
    anchor: "right",
    containerRef,
    storageKey: `zavi.agentPage.${slug}.chatWidth`,
    min: CHAT_MIN_PX,
    maxFraction: CHAT_MAX_FRACTION,
    defaultPx: CHAT_DEFAULT_PX,
    resetTo: CHAT_DEFAULT_PX,
    keyboard: true,
    ariaLabel: `Resize the ${name} conversation`,
  });

  const split = chatOpen && wideEnough;
  const chatWidth = sizePx ?? CHAT_DEFAULT_PX;

  return (
    <ProPlanGate slug={slug} feature={name}>
      <div
        ref={containerRef}
        className="relative flex h-full min-h-0 flex-col bg-cream text-ink"
      >
        <div className="absolute left-3 top-3 z-10 compact:hidden">
          <IconButton
            label={chatOpen ? "Hide the conversation" : "Show the conversation"}
            className="bg-cream"
            aria-expanded={chatOpen}
            aria-controls={panelId}
            onClick={() => setChatOpen((v) => !v)}
          >
            <Columns2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        <PaneViewSwitch
          label={`${name} view`}
          boardLabel="Board"
          chatOpen={chatOpen}
          onChange={(next) => setChatOpen(() => next)}
          controls={panelId}
        />

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              chatOpen && !wideEnough && "hidden",
            )}
          >
            <div className="mx-auto max-w-6xl px-4 pb-6 pt-14 compact:px-4 compact:pt-3 lg:px-8">
              <Dashboard />
            </div>
          </main>

          {split ? (
            <div
              {...separatorProps}
              onMouseDown={startResize}
              className={cn(
                "group relative w-px shrink-0 cursor-col-resize bg-rule",
                "after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-['']",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
              )}
            >
              <div
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
                  dragging ? "bg-ink/40" : "bg-transparent group-hover:bg-ink/20",
                )}
              />
            </div>
          ) : null}

          <aside
            id={panelId}
            aria-label={name}
            hidden={!chatOpen}
            style={split ? { width: chatWidth } : undefined}
            className={cn(
              "min-h-0 shrink-0 flex-col",
              chatOpen ? "flex" : "hidden",
              split ? "" : "w-full flex-1",
              dragging ? "" : "transition-[width] duration-150",
            )}
          >
            <div className="min-h-0 flex-1">
              <AgentTab
                slug={slug}
                tabId={tabId}
                isActive={isActive && chatOpen}
                chatOnly
                sidePanel
              />
            </div>
          </aside>
        </div>
      </div>
    </ProPlanGate>
  );
}
