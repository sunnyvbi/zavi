"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { ZaviMascot } from "@/components/ZaviMascot";
import { GrowthCoachPage } from "./GrowthCoachPage";
import { GrowthMemoSkeleton } from "./growth/GrowthMemoSkeleton";
import { useGrowthStrategy } from "@/lib/workspace/useGrowthStrategy";
import { GROWTH_OFFICER_SLUG, agentDisplayName } from "@/lib/agentRegistry";
import { useWorkspaceOptional } from "./WorkspaceShell";
import { useSetupActive, useSetupOn, useSetupOptional } from "./setup/SetupProvider";
import { SetupMascot, setupMascotShown } from "./setup/SetupMascot";
import { SetupChatChips } from "./setup/SetupChatChips";
import { PastChatsPopover } from "./sidechat/PastChatsPopover";
import { cx, FAB_CLEARANCE, FOCUS_RING } from "./layout/shared";
import { listAgentChats } from "@/lib/workspace/agentChatsApi";
import type { ChannelThread } from "@/lib/workspace/channelThreadsApi";
import { HOME_AGENT_SLUG, urlTabKindFromParam } from "@/lib/workspace/tabUrl";
import { agentThreadOpenStep } from "./navigation/threadBinding";
import {
  GROWTH_CHAT_PARAM,
  readWorkspaceLocation,
  replaceWorkspaceLocation,
} from "./navigation/workspaceRoutes";
import { WORKSPACE_UUID_RE } from "./deepLinkSeed";
import {
  SideChat,
  SideChatFab,
  SideChatRail,
  useSideChatState,
} from "./sidechat/SideChat";

const HIDDEN_KEY = "zavi:growth-chat-hidden";
const WIDTH_KEY = "zavi.growth.chatWidth";

export function AutopilotTab({
  tabId = "growth",
  isActive = true,
  focusDecisionId,
}: {
  tabId?: string;
  isActive?: boolean;
  focusDecisionId?: string;
} = {}) {
  const { loading } = useGrowthStrategy();
  const workspace = useWorkspaceOptional();
  const setupActive = !!useSetupActive();
  const setup = useSetupOn();
  const setupCtx = useSetupOptional();
  const sideChat = useSideChatState({ storageKey: HIDDEN_KEY, defaultOpen: true });
  const tabPayload = workspace?.tabs.find((t) => t.id === tabId)?.payload;
  const boundThreadId = tabPayload?.kind === "autopilot" ? tabPayload.threadId : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const askZavi = workspace
    ? (text: string) => {
        sideChat.show();
        workspace.seedComposer({ agentSlug: GROWTH_OFFICER_SLUG, tabId, text });
      }
    : undefined;

  const [threadId, setThreadId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [pastOpen, setPastOpen] = useState(false);
  const actRef = useRef(0);
  const keepNamedRef = useRef(false);
  useEffect(() => {
    const token = actRef.current;
    let live = true;
    const named = new URLSearchParams(window.location.search).get(GROWTH_CHAT_PARAM);
    listAgentChats(GROWTH_OFFICER_SLUG)
      .then(
        (rows) => {
          const own = rows.filter((r) => !r.from_home);
          const pick = own.find((r) => r.id === named) ?? own.find((r) => !r.from_email);
          if (live && actRef.current === token && pick) setThreadId(pick.id);
        },
        (e: unknown) => {
          keepNamedRef.current = true;
          console.warn(`[growth chat] could not look up past chats: ${(e as Error)?.message ?? e}`);
        },
      )
      .finally(() => {
        if (live) setResolving(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!isActive || resolving) return;
    const url = new URL(readWorkspaceLocation(), window.location.origin);
    if (urlTabKindFromParam(url.searchParams.get("tab")) !== "autopilot") return;
    if (threadId && WORKSPACE_UUID_RE.test(threadId)) url.searchParams.set(GROWTH_CHAT_PARAM, threadId);
    else if (!keepNamedRef.current) url.searchParams.delete(GROWTH_CHAT_PARAM);
    replaceWorkspaceLocation(`${url.pathname}${url.search}${url.hash}`);
  }, [isActive, resolving, threadId]);
  const bindThread = useCallback((id: string | null) => {
    actRef.current += 1;
    keepNamedRef.current = false;
    setResolving(false);
    setThreadId(id);
  }, []);
  const loadPast = useCallback(() => listAgentChats(GROWTH_OFFICER_SLUG), []);
  const pickPast = (row: ChannelThread) => {
    if (!row.from_home) {
      bindThread(row.id);
      return;
    }
    if (!workspace) return;
    const step = agentThreadOpenStep(workspace.tabs, HOME_AGENT_SLUG, row.id, { preferHome: true });
    if (step.kind === "open") void workspace.openAgentTab(HOME_AGENT_SLUG, { threadId: row.id, push: true });
    else if (step.kind === "activate") workspace.setActiveTab(step.tabId, { push: true });
    else workspace.setTabThreadId(step.tabId, row.id, { activate: true, push: true });
  };

  const chat = (fullBleed: boolean, open: boolean) => (
    <SideChat
      agentSlug={GROWTH_OFFICER_SLUG}
      tabId={tabId}
      thread="fresh"
      threadId={threadId}
      onThreadIdChange={bindThread}
      resolvingThread={resolving}
      escapeOwnedElsewhere={pastOpen}
      headerActions={
        <>
          <PastChatsPopover
            load={loadPast}
            placeName="Growth"
            currentThreadId={threadId}
            onPick={pickPast}
            onOpenChange={setPastOpen}
            fullBleed={fullBleed}
          />
          <button
            type="button"
            onClick={() => bindThread(null)}
            disabled={threadId === null}
            aria-label="New chat"
            title="New chat"
            className={cx(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent",
              fullBleed && "h-10 w-10 text-ink",
              FOCUS_RING,
            )}
          >
            <Plus className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </>
      }
      id="growth-chat-panel"
      avatar={<ZaviMascot size={32} className="shrink-0" />}
      hideAvatarWhenEmpty
      title="Zavi"
      contextLine="Growth strategy"
      emptyStateName="Zavi"
      ariaLabel={agentDisplayName(GROWTH_OFFICER_SLUG)}
      open={open}
      onClose={sideChat.hide}
      widthKey={WIDTH_KEY}
      defaultWidthPx={380}
      resizeLabel="Resize the growth conversation"
      containerRef={containerRef}
      fullBleed={fullBleed}
      emptyState={
        setup && setupMascotShown(setup, setupCtx?.canManageSetup ?? false, setupCtx?.draftStarting ?? false)
          ? <SetupMascot state={setup} />
          : <ZaviMascot size={120} />
      }
      contextBar={setupActive ? <SetupChatChips tabId={tabId} /> : undefined}
    />
  );

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 overflow-clip bg-cream text-ink">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cx("mx-auto max-w-6xl px-4 py-4 compact:px-4 compact:pt-3 lg:px-8", FAB_CLEARANCE)}>
          {}
          {}
          {loading ? <GrowthMemoSkeleton /> : <GrowthCoachPage onAsk={askZavi} live={isActive} focusDecisionId={focusDecisionId} />}
        </div>
      </main>
      {}
      <div
        className={
          sideChat.compact
            ? cn(
                "fixed inset-x-0 bottom-0 top-[var(--service-banner-h,0px)] z-40 bg-cream",
                sideChat.compactOpen
                  ? "flex animate-slide-in-right motion-reduce:animate-none"
                  : "hidden",
              )
            : "contents"
        }
      >
        {(sideChat.mountColumn || sideChat.mountOverlay) &&
          chat(sideChat.compact, sideChat.compact ? sideChat.compactOpen : sideChat.open)}
      </div>
      {sideChat.compact
        ? !sideChat.compactOpen && (
            <SideChatFab onOpen={sideChat.show} label="Chat with Zavi about your growth" />
          )
        : !sideChat.open && <SideChatRail onOpen={sideChat.show} label="Chat" />}
    </div>
  );
}
