"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useWorkspace } from "../WorkspaceShell";
import { STATIC_TITLES } from "../layout/shared";
import { SidebarUserBar } from "./SidebarUserBar";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import {
  HowZaviWorksModal,
  howZaviConnectDestination,
  type HowZaviAction,
} from "../HowZaviWorksModal";
import { AgentAvatar } from "../AgentAvatar";
import {
  agentDisplayName,
  fleetRank,
  getAgentMeta,
} from "@/lib/agentRegistry";
import IconBell from "../IconBell";
import { ArtifactsIcon } from "@/components/icons/ArtifactsIcon";
import {
  useAgentPins,
  MAIN_AGENT_SLUGS,
  isMainAgent,
} from "../useAgentPins";
import { OPEN_THREAD_HISTORY_EVENT } from "../threadHistory";
import { useCompetitorIntel } from "../useCompetitorIntel";
import { apiFetch } from "@/lib/api";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

type TreeAgent = {
  slug: string;
  department?: string;
  latest_run_started_at: string | null;
  latest_run_status: string | null;
  latest_event_preview: string;
  pending_decisions_count: number;
  has_unseen_pending: boolean;
  unseen_thread_count: number;
};

type ExplorerTreeProps = {
  agents: TreeAgent[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

type SidebarTab = "main" | "all";

const SIDEBAR_TAB_KEY = "zavi:sidebar-agents-tab";

export function ExplorerTree({
  agents,
  collapsed = false,
  onToggleCollapse,
}: ExplorerTreeProps) {
  const {
    openTab,
    openAgentTab,
    activeTabId,
    tabs,
    tenantName,
    userEmail,
    refreshTree,
  } = useWorkspace();
  const [howOpen, setHowOpen] = useState(false);

  const [tab, setTab] = useState<SidebarTab>("main");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_TAB_KEY) === "all") {
        setTab("all");
      }
    } catch {
    }
  }, []);
  const switchTab = (next: SidebarTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(SIDEBAR_TAB_KEY, next);
    } catch {
    }
  };

  const { pins, isPinned, togglePin } = useAgentPins();

  const { data: competitorIntel } = useCompetitorIntel();
  const competitorEnabled = competitorIntel?.enabled === true;

  const fleetAgents = agents;

  const sortedFleet = useMemo(
    () =>
      fleetAgents.slice().sort((x, y) => {
        const r = fleetRank(x.slug) - fleetRank(y.slug);
        if (r !== 0) return r;
        return agentDisplayName(x.slug).localeCompare(agentDisplayName(y.slug));
      }),
    [fleetAgents],
  );

  const pinnedAgents = useMemo(() => {
    const effective = [...MAIN_AGENT_SLUGS, ...(pins ?? [])];
    const bySlug = new Map(agents.map((a) => [a.slug, a]));
    const seen = new Set<string>();
    return effective.flatMap((slug) => {
      if (seen.has(slug)) return [];
      seen.add(slug);
      const a = bySlug.get(slug);
      return a ? [a] : [];
    });
  }, [agents, pins]);

  const markUnread = (slug: string) => {
    void apiFetch("/api/workspace/agent-unread", {
      method: "POST",
      body: JSON.stringify({ slug }),
    })
      .then((res) => {
        if (res.ok) return refreshTree();
      })
      .catch(() => {
      });
  };

  const openHistory = (slug: string) => {
    void openAgentTab(slug);
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(OPEN_THREAD_HISTORY_EVENT, { detail: { slug } }),
        );
      }, 400);
    }
  };

  const isActiveAgent = (slug: string): boolean => {
    const t = tabs.find((t) => t.id === activeTabId);
    return (
      !!t &&
      t.kind === "agent" &&
      (t.payload as { slug: string }).slug === slug
    );
  };

  const activeKind = (() => {
    const t = tabs.find((t) => t.id === activeTabId);
    return t?.kind ?? null;
  })();

  const companyName = tenantName ?? "Zavi";
  const companyInitial = (companyName.trim()[0] || "Z").toUpperCase();

  const openHome = () =>
    openTab({
      kind: "home",
      title: "Home",
      payload: { kind: "home" },
      dirty: false,
      pinned: true,
    });

  const openArtifacts = () =>
    openTab({
      kind: "artifacts",
      title: "Artifacts",
      payload: { kind: "artifacts" },
      dirty: false,
      pinned: false,
    });

  const handleHow = (action: HowZaviAction) => {
    setHowOpen(false);
    switch (action) {
      case "ask":
        openHome();
        break;
      case "connectSlack":
      case "connect": {
        const kind = howZaviConnectDestination(action);
        openTab({
          kind,
          title: kind === "messaging" ? "Messaging" : "Connectors",
          payload: { kind },
          dirty: false,
          pinned: false,
        });
        break;
      }
      case "brain":
        openTab({
          kind: "brain",
          title: "Brain",
          payload: { kind: "brain" },
          dirty: false,
          pinned: false,
        });
        break;
      case "team":
        switchTab("all");
        break;
      case "review":
        openTab({
          kind: "home",
          title: "Home",
          payload: { kind: "home" },
          dirty: false,
          pinned: true,
        });
        break;
      case "autopilot":
        openTab({
          kind: "autopilot",
          title: STATIC_TITLES.autopilot,
          payload: { kind: "autopilot" },
          dirty: false,
          pinned: false,
        });
        break;
    }
  };

  const howModal = (
    <HowZaviWorksModal
      open={howOpen}
      onClose={() => setHowOpen(false)}
      onAction={handleHow}
    />
  );

  const agentRowFor = (a: TreeAgent) => (
    <AgentRow
      key={a.slug}
      row={a}
      active={isActiveAgent(a.slug)}
      core={isMainAgent(a.slug)}
      pinned={isPinned(a.slug)}
      onClick={(e) => {
        const newThread = e.metaKey || e.ctrlKey;
        void openAgentTab(a.slug, { newThread });
      }}
      onNewThread={() => {
        void openAgentTab(a.slug, { newThread: true });
      }}
      onTogglePin={() => togglePin(a.slug)}
      onMarkUnread={() => markUnread(a.slug)}
      onHistory={() => openHistory(a.slug)}
    />
  );

  if (collapsed) {
    const userInitial = (userEmail?.trim()[0] || "?").toUpperCase();
    return (
      <div className="flex h-full flex-col items-center bg-white py-2 font-sans text-[#0e0f11]">
        {onToggleCollapse && (
          <RailPlainButton
            tip="Expand sidebar"
            ariaLabel="Expand sidebar"
            onClick={onToggleCollapse}
            className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-[#595959] transition-colors duration-150 hover:bg-[#f5f5f5] hover:text-[#0e0f11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
          >
            <IconPanelToggle />
          </RailPlainButton>
        )}

        {}
        <RailPlainButton
          tip={companyName}
          ariaLabel={`${companyName}: home`}
          onClick={openHome}
          className="mt-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[10px] transition-colors duration-150 hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-full border-[0.5px] border-[#f0f0f0] bg-ink text-[13px] font-medium text-white"
          >
            {companyInitial}
          </span>
        </RailPlainButton>

        <RailDivider />

        {}
        <div className="scrollbar-none flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          <RailButton
            label="Home"
            icon={<IconHome />}
            active={activeKind === "home"}
            onClick={openHome}
          />
          <RailButton
            label="Artifacts"
            icon={<ArtifactsIcon className="h-5 w-5" aria-hidden="true" />}
            active={activeKind === "artifacts"}
            onClick={openArtifacts}
          />

          {sortedFleet.length > 0 && <RailDivider />}
          {sortedFleet.map((a) => (
            <RailAgent
              key={a.slug}
              row={a}
              active={isActiveAgent(a.slug)}
              onClick={(e) => {
                const newThread = e.metaKey || e.ctrlKey;
                void openAgentTab(a.slug, { newThread });
              }}
            />
          ))}

          <RailDivider />
          <RailButton
            label={STATIC_TITLES.autopilot}
            icon={<IconAutopilot />}
            active={activeKind === "autopilot"}
            onClick={() =>
              openTab({
                kind: "autopilot",
                title: STATIC_TITLES.autopilot,
                payload: { kind: "autopilot" },
                dirty: false,
                pinned: false,
              })
            }
          />
          <RailButton
            label="Brain"
            icon={<IconBrain />}
            active={activeKind === "brain"}
            onClick={() =>
              openTab({
                kind: "brain",
                title: "Brain",
                payload: { kind: "brain" },
                dirty: false,
                pinned: false,
              })
            }
          />
          {}
          <RailButton label={CREATOR_MARKETPLACE_ENABLED ? "Human" : "Creative Library"} icon={<IconHuman />} active={false} href={CREATOR_MARKETPLACE_ENABLED ? "/humans" : "/humans/library"} />
          {competitorEnabled && (
            <RailButton
              label="Competitor Intel"
              icon={<IconCompetitor />}
              active={activeKind === "competitor"}
              onClick={() =>
                openTab({
                  kind: "competitor",
                  title: "Competitor Intel",
                  payload: { kind: "competitor" },
                  dirty: false,
                  pinned: false,
                })
              }
            />
          )}
          {}
          <RailButton
            label="Your Website"
            icon={<IconWebsite />}
            active={activeKind === "website"}
            onClick={() =>
              openTab({
                kind: "website",
                title: "Your Website",
                payload: { kind: "website" },
                dirty: false,
                pinned: false,
              })
            }
          />
          <RailButton
            label="Settings"
            icon={<IconSettings />}
            active={activeKind === "settings"}
            onClick={() =>
              openTab({
                kind: "settings",
                title: "Settings",
                payload: { kind: "settings" },
                dirty: false,
                pinned: false,
              })
            }
          />
          <RailDivider />
          <RailButton
            label="How Zavi works"
            icon={<IconHelp />}
            active={false}
            onClick={() => setHowOpen(true)}
          />
        </div>

        {}
        {userEmail && (
          <>
            <RailDivider />
            <RailPlainButton
              tip="Account"
              tipBody={userEmail}
              ariaLabel="Expand sidebar for account menu"
              onClick={onToggleCollapse}
              className="mt-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[10px] transition-colors duration-150 hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-full border-[0.5px] border-[#f0f0f0] bg-ink text-[13px] font-medium text-white"
              >
                {userInitial}
              </span>
            </RailPlainButton>
          </>
        )}
        {howModal}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white font-sans text-[16px] text-[#0e0f11]">
      {}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {}
        <div className="sticky top-0 z-20 flex items-center gap-1 border-b border-[#f0f0f0] bg-white/60 px-2 py-2 backdrop-blur-[20px]">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher
              companyName={companyName}
              companyInitial={companyInitial}
              onOpenHome={openHome}
            />
          </div>
          {onToggleCollapse && (
            <RailPlainButton
              tip="Collapse sidebar"
              ariaLabel="Collapse sidebar"
              onClick={onToggleCollapse}
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-[#595959] transition-colors duration-150 hover:bg-[#f5f5f5] hover:text-[#0e0f11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <IconPanelToggle />
            </RailPlainButton>
          )}
        </div>

        {}
        <div className="border-b border-[#f0f0f0] px-3 pb-3 pt-2">
          <div
            role="tablist"
            aria-label="Sidebar agents view"
            className="flex w-full items-center rounded-full bg-[#f0f0f0] p-1"
          >
            <TabPill
              label="Main"
              selected={tab === "main"}
              onClick={() => switchTab("main")}
            />
            <TabPill
              label="All Agents"
              selected={tab === "all"}
              onClick={() => switchTab("all")}
            />
          </div>
        </div>

        {tab === "main" ? (
          <>
            {}
            <div className="border-b border-[#f0f0f0] px-2 py-2">
              <NavItem
                label="Home"
                icon={<IconHome />}
                active={activeKind === "home"}
                onClick={openHome}
              />
              <NavItem
                label="Artifacts"
                icon={<ArtifactsIcon className="h-5 w-5" aria-hidden="true" />}
                active={activeKind === "artifacts"}
                onClick={openArtifacts}
              />
            </div>

            {}
            <div className="px-2 py-2">
              {}
              <div className="flex w-full items-center gap-2 py-1.5 pl-2 pr-3">
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.03em] text-[#595959]">
                  Agents
                </span>
                {}
                <button
                  type="button"
                  onClick={() => switchTab("all")}
                  className="cursor-pointer text-[12px] font-medium tracking-[0.01px] text-[#027bff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
                >
                  View all
                </button>
              </div>

              {pinnedAgents.length === 0 ? (
                <div className="px-3 py-2.5 text-[13px] text-[#8c8c8c]">
                  No pinned agents. Pin one from{" "}
                  <button
                    type="button"
                    onClick={() => switchTab("all")}
                    className="cursor-pointer font-medium text-[#027bff] hover:underline"
                  >
                    All Agents
                  </button>
                  .
                </div>
              ) : (
                <ul role="list" className="mt-0.5 flex flex-col">
                  {pinnedAgents.map((a) => (
                    <li key={a.slug}>{agentRowFor(a)}</li>
                  ))}
                </ul>
              )}
            </div>

          </>
        ) : (
          <div className="px-2 py-2">
            {sortedFleet.length === 0 ? (
              <div className="px-3 py-2.5 text-[13px] text-[#8c8c8c]">
                No agents yet.
              </div>
            ) : (
              <ul role="list" className="flex flex-col">
                {sortedFleet.map((a) => (
                  <li key={a.slug}>{agentRowFor(a)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {}
      {tab === "main" && (
        <div className="shrink-0 border-t border-[#f0f0f0] px-2 py-2">
          <NavItem
            label={STATIC_TITLES.autopilot}
            icon={<IconAutopilot />}
            active={activeKind === "autopilot"}
            onClick={() =>
              openTab({
                kind: "autopilot",
                title: STATIC_TITLES.autopilot,
                payload: { kind: "autopilot" },
                dirty: false,
                pinned: false,
              })
            }
          />
          <NavItem
            label="Brain"
            icon={<IconBrain />}
            active={activeKind === "brain"}
            onClick={() =>
              openTab({
                kind: "brain",
                title: "Brain",
                payload: { kind: "brain" },
                dirty: false,
                pinned: false,
              })
            }
          />
          {}
          <NavItem label={CREATOR_MARKETPLACE_ENABLED ? "Human" : "Creative Library"} icon={<IconHuman />} active={false} href={CREATOR_MARKETPLACE_ENABLED ? "/humans" : "/humans/library"} />
          {}
          {competitorEnabled && (
            <NavItem
              label="Competitor Intel"
              icon={<IconCompetitor />}
              active={activeKind === "competitor"}
              onClick={() =>
                openTab({
                  kind: "competitor",
                  title: "Competitor Intel",
                  payload: { kind: "competitor" },
                  dirty: false,
                  pinned: false,
                })
              }
            />
          )}
          {}
          <NavItem
            label="Your Website"
            icon={<IconWebsite />}
            active={activeKind === "website"}
            onClick={() =>
              openTab({
                kind: "website",
                title: "Your Website",
                payload: { kind: "website" },
                dirty: false,
                pinned: false,
              })
            }
          />
          {}
          <NavItem
            label="Settings"
            icon={<IconSettings />}
            active={activeKind === "settings"}
            onClick={() =>
              openTab({
                kind: "settings",
                title: "Settings",
                payload: { kind: "settings" },
                dirty: false,
                pinned: false,
              })
            }
          />
          <NavItem
            label="How Zavi works"
            icon={<IconHelp />}
            active={false}
            onClick={() => setHowOpen(true)}
          />
        </div>
      )}

      {}
      {userEmail && <SidebarUserBar email={userEmail} />}
      {howModal}
    </div>
  );
}

function TabPill({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-2xl px-4 text-[16px] font-semibold tracking-[0.01px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${
        selected
          ? "bg-white text-[#1f1f1f] shadow-[0px_1px_2px_rgba(16,18,20,0.06)]"
          : "text-[#454545] hover:text-[#1f1f1f]"
      }`}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
  href,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const cls = `
        flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-[16px] font-medium tracking-[0.14px] transition-colors duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20
        ${
          active
            ? "bg-[#f0f0f0] text-[#0e0f11]"
            : "text-[#0e0f11] hover:bg-[#f5f5f5]"
        }
      `;
  const inner = (
    <>
      <span
        aria-hidden
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#1f1f1f]"
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} aria-current={active ? "page" : undefined} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cls}
    >
      {inner}
    </button>
  );
}

function RailDivider() {
  return <div aria-hidden className="my-1 h-px w-6 shrink-0 bg-[#f0f0f0]" />;
}

function useRailTip() {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const show = (
    e: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>,
  ) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: r.right + 10, top: r.top + r.height / 2 });
  };
  const hide = () => setPos(null);
  return { pos, show, hide };
}

function RailTip({
  pos,
  title,
  body,
}: {
  pos: { left: number; top: number } | null;
  title: string;
  body?: string;
}) {
  if (!pos) return null;
  return createPortal(
    <div
      role="tooltip"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-50 w-max max-w-[240px] -translate-y-1/2 rounded-[10px] border border-[#f0f0f0] bg-white px-3 py-2 shadow-[0px_8px_24px_rgba(16,18,20,0.14)]"
    >
      <p className="text-[12px] font-semibold leading-4 text-[#0e0f11]">
        {title}
      </p>
      {body ? (
        <p className="mt-0.5 text-[12px] leading-4 text-[#595959]">{body}</p>
      ) : null}
    </div>,
    document.body,
  );
}

function RailPlainButton({
  tip,
  tipBody,
  ariaLabel,
  onClick,
  className,
  children,
}: {
  tip: string;
  tipBody?: string;
  ariaLabel: string;
  onClick?: () => void;
  className: string;
  children: ReactNode;
}) {
  const { pos, show, hide } = useRailTip();
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={className}
      >
        {children}
      </button>
      <RailTip pos={pos} title={tip} body={tipBody} />
    </>
  );
}

function RailButton({
  label,
  icon,
  active,
  onClick,
  href,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const { pos, show, hide } = useRailTip();
  const cls = `flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${
    active ? "bg-[#f0f0f0] text-[#0e0f11]" : "text-[#1f1f1f] hover:bg-[#f5f5f5]"
  }`;
  const glyph = (
    <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center">
      {icon}
    </span>
  );
  return (
    <>
      {href ? (
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          className={cls}
        >
          {glyph}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          className={cls}
        >
          {glyph}
        </button>
      )}
      <RailTip pos={pos} title={label} />
    </>
  );
}

function infoCardHalfHeight(description: string | undefined, bulletCount: number): number {
  return (
    (58 + (description ? 44 : 0) + (bulletCount > 0 ? 52 + bulletCount * 18 : 0)) / 2
  );
}

function infoCardPos(
  r: DOMRect,
  description: string | undefined,
  bulletCount: number,
): { left: number; top: number } {
  const half = infoCardHalfHeight(description, bulletCount);
  const mid = r.top + r.height / 2;
  return {
    left: r.right + 10,
    top: Math.min(Math.max(mid, half + 8), window.innerHeight - half - 8),
  };
}

function AgentInfoCard({
  slug,
  pos,
}: {
  slug: string;
  pos: { left: number; top: number } | null;
}) {
  if (!pos) return null;
  const name = agentDisplayName(slug);
  const meta = getAgentMeta(slug);
  const description = meta.roleDescription ?? meta.subtitle;
  const roleBullets = meta.roleBullets ?? [];
  return createPortal(
    <div
      role="tooltip"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-50 w-[280px] -translate-y-1/2 overflow-hidden rounded-[16px] border border-[#f0f0f0] bg-white shadow-[0px_32px_64px_-12px_rgba(16,18,20,0.14)]"
    >
      {}
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[16px] font-semibold leading-5 text-[#0e0f11]">
            {name}
          </p>
          <span className="shrink-0 rounded-[6px] bg-[#f5faf8] px-1.5 py-1 text-[13px] font-medium leading-[18px] tracking-[0.13px] text-[#167f50]">
            Active
          </span>
        </div>
        {description && (
          <p className="text-[12px] leading-[18px] tracking-[0.01px] text-[#595959]">
            {description}
          </p>
        )}
      </div>
      {}
      {roleBullets.length > 0 && (
        <div className="border-t border-[#f0f0f0] p-4">
          <p className="text-[12px] font-medium leading-4 tracking-[0.01px] text-[#595959]">
            Role description
          </p>
          <ul className="mt-1 text-[12px] leading-[18px] tracking-[0.01px] text-[#0e0f11]">
            {roleBullets.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>,
    document.body,
  );
}

function RailAgent({
  row,
  active,
  onClick,
}: {
  row: TreeAgent;
  active: boolean;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const unreadCount = row.unseen_thread_count;
  const RUNNING_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
  const startedAtMs = row.latest_run_started_at
    ? Date.parse(row.latest_run_started_at)
    : NaN;
  const isFresh =
    Number.isNaN(startedAtMs) || Date.now() - startedAtMs < RUNNING_STALE_AFTER_MS;
  const isRunning =
    (row.latest_run_status === "running" || row.latest_run_status === "queued") &&
    isFresh;
  const name = agentDisplayName(row.slug);
  const meta = getAgentMeta(row.slug);
  const cardDescription = meta.roleDescription ?? meta.subtitle;
  const cardBulletCount = meta.roleBullets?.length ?? 0;
  const [infoPos, setInfoPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const showInfo = (
    e: ReactMouseEvent<HTMLButtonElement> | ReactFocusEvent<HTMLButtonElement>,
  ) => {
    setInfoPos(
      infoCardPos(
        e.currentTarget.getBoundingClientRect(),
        cardDescription,
        cardBulletCount,
      ),
    );
  };
  const hideInfo = () => setInfoPos(null);
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={unreadCount > 0 ? `${name}, unread chats` : name}
        aria-current={active ? "page" : undefined}
        onMouseEnter={showInfo}
        onMouseLeave={hideInfo}
        onFocus={showInfo}
        onBlur={hideInfo}
        className={`relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-cta transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${
          active ? "bg-[#f0f0f0]" : "hover:bg-[#f5f5f5]"
        }`}
      >
        <span className="relative">
          <AgentAvatar slug={row.slug} size="sm" shape="tile" />
          {isRunning && (
            <span
              className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5"
              aria-label="Working"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-white bg-emerald-500" />
            </span>
          )}
        </span>
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[#f0f0f0] bg-white text-[#1f1f1f]">
            <IconBell size={12} />
          </span>
        )}
      </button>
      <AgentInfoCard slug={row.slug} pos={infoPos} />
    </>
  );
}

const MENU_W = 200;
const MENU_ITEM_H = 40;
const MENU_PAD_Y = 16;

function AgentRow({
  row,
  active,
  core,
  pinned,
  onClick,
  onNewThread,
  onTogglePin,
  onMarkUnread,
  onHistory,
}: {
  row: TreeAgent;
  active: boolean;
  core: boolean;
  pinned: boolean;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onNewThread: () => void;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onHistory: () => void;
}) {
  const RUNNING_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
  const startedAtMs = row.latest_run_started_at
    ? Date.parse(row.latest_run_started_at)
    : NaN;
  const isFresh =
    Number.isNaN(startedAtMs) || Date.now() - startedAtMs < RUNNING_STALE_AFTER_MS;
  const isRunning =
    (row.latest_run_status === "running" ||
      row.latest_run_status === "queued") &&
    isFresh;

  const name = agentDisplayName(row.slug);
  const meta = getAgentMeta(row.slug);
  const description = meta.roleDescription ?? meta.subtitle;
  const roleBullets = meta.roleBullets ?? [];

  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [removeStep, setRemoveStep] = useState<0 | 1 | 2>(0);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuPos) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuPos(null);
    }
    function onScroll() {
      setMenuPos(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuPos]);

  const menuH = (core ? 3 : 4) * MENU_ITEM_H + MENU_PAD_Y;

  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const top =
      r.bottom + 6 + menuH > window.innerHeight
        ? r.top - menuH - 6
        : r.bottom + 6;
    setMenuPos({ left: Math.max(8, r.right - MENU_W), top });
  };

  const showTip = (
    e:
      | ReactMouseEvent<HTMLButtonElement>
      | ReactFocusEvent<HTMLButtonElement>,
  ) => {
    setTipPos(
      infoCardPos(
        e.currentTarget.getBoundingClientRect(),
        description,
        roleBullets.length,
      ),
    );
  };

  const menuOpen = menuPos !== null;

  return (
    <div
      className={`group relative flex items-center rounded-[10px] transition-colors duration-150 ${
        active ? "bg-[#f0f0f0]" : menuOpen ? "bg-[#f9f9f9]" : "hover:bg-[#f9f9f9]"
      }`}
    >
      {}
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-cta py-2 pl-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
      >
        <span className="relative shrink-0">
          <AgentAvatar slug={row.slug} size="sm" shape="tile" />
          {isRunning && (
            <span
              className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5"
              aria-label="Working"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-white bg-emerald-500" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[16px] tracking-[0.14px]">
          <span className="font-medium text-[#0e0f11]">{name}</span>
          {}
          {isRunning && (
            <span className="ml-1.5 align-middle text-[11px] font-medium tracking-[0.01px] text-emerald-600">
              Working…
            </span>
          )}
        </span>
        {row.pending_decisions_count > 0 && (
          <span
            className={`h-2 w-2 shrink-0 rounded-full bg-[#2563eb] group-hover:hidden ${
              menuOpen ? "hidden" : ""
            }`}
            title={`${name} needs your decision`}
            aria-label={`${name} needs your decision`}
          />
        )}
        {row.unseen_thread_count > 0 && (
          <span
            className={`shrink-0 text-[#1f1f1f] group-hover:hidden ${
              menuOpen ? "hidden" : ""
            }`}
            title={`${name} has unread chats`}
            aria-label={`${name} has unread chats`}
          >
            <IconBell />
          </span>
        )}
      </button>

      {}
      <div
        className={`mr-2 shrink-0 items-center gap-2 ${
          menuOpen ? "flex" : "hidden group-hover:flex"
        }`}
      >
        <button
          type="button"
          onMouseEnter={showTip}
          onMouseLeave={() => setTipPos(null)}
          onFocus={showTip}
          onBlur={() => setTipPos(null)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`About ${name}`}
          className="flex h-6 w-6 cursor-default items-center justify-center rounded-cta p-1 text-[#0e0f11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <IconHelpSmall />
        </button>
        <button
          type="button"
          onClick={openMenu}
          aria-label={`More actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-cta border border-[#d9d9d9] bg-white p-1 text-[#0e0f11] transition-colors duration-150 hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <IconMoreVerticalSmall />
        </button>
      </div>

      {}
      <AgentInfoCard slug={row.slug} pos={tipPos} />

      {}
      {menuPos &&
        createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${name}`}
          style={{
            position: "fixed",
            left: menuPos.left,
            top: menuPos.top,
            width: MENU_W,
          }}
          className="z-50 overflow-hidden rounded-[16px] border border-[#f0f0f0] bg-white py-2 shadow-[0px_32px_64px_-12px_rgba(16,18,20,0.14)]"
        >
          {!core && (
            <MenuItemRow
              icon={<IconPin />}
              label={pinned ? "Unpin" : "Pin"}
              onClick={() => {
                setMenuPos(null);
                onTogglePin();
              }}
            />
          )}
          <MenuItemRow
            icon={<IconEyeOff />}
            label="Mark as unread"
            onClick={() => {
              setMenuPos(null);
              onMarkUnread();
            }}
          />
          <MenuItemRow
            icon={<IconPlusSmall />}
            label="New Chat"
            onClick={() => {
              setMenuPos(null);
              onNewThread();
            }}
          />
          <MenuItemRow
            icon={<IconClock />}
            label="History"
            onClick={() => {
              setMenuPos(null);
              onHistory();
            }}
          />
          {}
          {!core && (
            <>
              <div className="my-1 h-px bg-[#f0f0f0]" role="separator" />
              <MenuItemRow
                icon={<IconTrash />}
                label="Remove"
                danger
                onClick={() => {
                  setMenuPos(null);
                  setRemoveStep(1);
                }}
              />
            </>
          )}
        </div>,
        document.body,
      )}

      {removeStep !== 0 && (
        <RemoveConfirm
          name={name}
          step={removeStep}
          onAdvance={() => setRemoveStep(2)}
          onCancel={() => setRemoveStep(0)}
          onConfirm={() => {
            setRemoveStep(0);
            onTogglePin();
          }}
        />
      )}
    </div>
  );
}

function MenuItemRow({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-[16px] font-medium transition-colors duration-150 focus-visible:outline-none ${
        danger
          ? "text-[#d92d20] hover:bg-[#fef3f2] focus-visible:bg-[#fef3f2]"
          : "text-[#1f1f1f] hover:bg-[#f5f5f5] focus-visible:bg-[#f5f5f5]"
      }`}
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      {label}
    </button>
  );
}

function IconPanelToggle() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function IconHelpSmall() {
  return (
    <svg width="16" height="16" viewBox="0 0 17.9167 17.9167" fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.95833 1.25004C4.70114 1.25004 1.25 4.70118 1.25 8.95837C1.25 13.2156 4.70114 16.6667 8.95833 16.6667C13.2155 16.6667 16.6667 13.2156 16.6667 8.95837C16.6667 4.70118 13.2155 1.25004 8.95833 1.25004ZM0 8.95837C0 4.01082 4.01078 4.06951e-05 8.95833 4.06951e-05C13.9059 4.06951e-05 17.9167 4.01082 17.9167 8.95837C17.9167 13.9059 13.9059 17.9167 8.95833 17.9167C4.01078 17.9167 0 13.9059 0 8.95837Z"
        fill="currentColor"
      />
      <path
        d="M8.95931 12.2914C9.41955 12.2914 9.79232 12.6651 9.79232 13.1254C9.79214 13.5855 9.41944 13.9584 8.95931 13.9584H8.9515C8.49152 13.9582 8.11867 13.5853 8.11849 13.1254C8.11849 12.6652 8.49141 12.2916 8.9515 12.2914H8.95931ZM8.95833 4.16638C10.224 4.16638 11.2503 5.19272 11.2503 6.45837C11.2503 6.91366 11.1161 7.34008 10.8861 7.69763C10.742 7.92141 10.5735 8.13556 10.4183 8.32849C10.39 8.36367 10.3617 8.39816 10.3343 8.43201C10.2055 8.59144 10.0871 8.73788 9.97786 8.88806C9.70837 9.25846 9.58344 9.53707 9.58333 9.79138V10.2084C9.58333 10.5536 9.30351 10.8334 8.95833 10.8334C8.61316 10.8334 8.33333 10.5536 8.33333 10.2084V9.79138C8.33344 9.12555 8.66008 8.57472 8.96712 8.15271C9.0969 7.97435 9.23918 7.79802 9.36849 7.63806C9.39435 7.60608 9.42004 7.57491 9.44466 7.54431C9.59895 7.35256 9.73037 7.18392 9.83529 7.02087C9.93946 6.85899 10.0003 6.66668 10.0003 6.45837C10.0003 5.88308 9.53363 5.41638 8.95833 5.41638C8.38304 5.41638 7.91634 5.88308 7.91634 6.45837C7.91634 6.80355 7.63652 7.08337 7.29134 7.08337C6.94631 7.0832 6.66634 6.80344 6.66634 6.45837C6.66634 5.19272 7.69268 4.16638 8.95833 4.16638Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconMoreVerticalSmall() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="5" r="0.5" />
      <circle cx="12" cy="12" r="0.5" />
      <circle cx="12" cy="19" r="0.5" />
    </svg>
  );
}

function RemoveConfirm({
  name,
  step,
  onAdvance,
  onCancel,
  onConfirm,
}: {
  name: string;
  step: 1 | 2;
  onAdvance: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="remove-agent-title"
        aria-describedby="remove-agent-body"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] rounded-[16px] bg-white p-6 shadow-[0px_32px_64px_-12px_rgba(16,18,20,0.24)] focus:outline-none"
      >
        <h2
          id="remove-agent-title"
          className="text-[16px] font-semibold text-[#1f1f1f]"
        >
          {step === 1 ? `Remove ${name} from Main?` : `Remove ${name}?`}
        </h2>
        <p id="remove-agent-body" className="mt-2 text-[16px] leading-5 text-[#5c5c5c]">
          {step === 1 ? (
            <>
              It stays in <strong>All Agents</strong> and keeps its chat history.
              Chatting with it again brings it back to Main.
            </>
          ) : (
            <>This removes it from your Main tab. You can undo this by chatting with it again.</>
          )}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-cta border border-[#e0e0e0] px-4 py-2 text-[16px] font-medium text-[#1f1f1f] hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f1f1f]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={step === 1 ? onAdvance : onConfirm}
            className="rounded-cta bg-[#d92d20] px-4 py-2 text-[16px] font-medium text-white hover:bg-[#b42318] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d92d20]"
          >
            {step === 1 ? "Remove" : "Yes, remove"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6 4V2.75c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75V4m2 0v9.25c0 .41-.34.75-.75.75h-8.5a.75.75 0 0 1-.75-.75V4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.5 7v4M9.5 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width="17" height="17" viewBox="0 0 16.2498 16.2504" fill="none" aria-hidden>
      <path
        d="M11.9682 0.0206654C12.2311 0.0601264 12.4959 0.15641 12.7495 0.248204C12.7609 0.252347 12.7722 0.256779 12.7836 0.2609C14.2827 0.802863 15.4476 1.96701 15.9897 3.46598C15.9939 3.47746 15.9982 3.4896 16.0024 3.50113C16.0942 3.75471 16.1895 4.01948 16.229 4.28238C16.2755 4.59295 16.2449 4.88561 16.1284 5.21012C15.8786 5.90533 15.3185 6.21634 14.7016 6.55875C14.6677 6.57757 14.6333 6.59631 14.5991 6.61539L13.4858 7.23649C13.0459 7.48184 12.7552 7.64522 12.5483 7.78824C12.347 7.92745 12.2899 8.00576 12.2661 8.05192C12.2535 8.07645 12.2138 8.19524 12.2241 8.57926C12.2338 8.94263 12.2814 9.4356 12.3491 10.1369C12.4581 11.2675 12.2701 12.3874 11.6176 13.4308C11.6122 13.4395 11.6065 13.4484 11.601 13.4572C11.4909 13.6335 11.369 13.8294 11.2143 13.9943C11.0316 14.189 10.8213 14.3269 10.5502 14.4367C10.2742 14.5485 10.0224 14.5933 9.75142 14.5812C9.52097 14.5709 9.28682 14.5182 9.06587 14.4679C9.05575 14.4656 9.04566 14.4634 9.0356 14.4611C7.53518 14.1204 6.09558 13.3097 4.89497 12.2384L1.06685 16.0675C0.822809 16.3112 0.42705 16.3113 0.183058 16.0675C-0.0610194 15.8235 -0.0610194 15.4269 0.183058 15.1828L4.01118 11.3546C2.94019 10.1542 2.13015 8.71509 1.7895 7.215C1.78719 7.20483 1.78499 7.19398 1.78267 7.18375C1.73244 6.96293 1.67867 6.72863 1.66841 6.4982C1.6564 6.22734 1.70205 5.97628 1.81392 5.70035C1.92387 5.42915 2.06139 5.21807 2.2563 5.03531C2.42125 4.88068 2.61719 4.75856 2.79341 4.6486C2.8021 4.64317 2.81118 4.63834 2.81978 4.63297C3.84858 3.99025 4.95937 3.7916 6.0815 3.89078C6.79804 3.95416 7.30375 3.99826 7.67525 4.00602C7.85856 4.00984 7.98933 4.00463 8.08345 3.99235C8.12931 3.98635 8.16152 3.97884 8.18306 3.97281C8.20347 3.96709 8.21198 3.96324 8.21236 3.96305C8.25728 3.93964 8.33526 3.88168 8.47505 3.67887C8.61816 3.47119 8.78122 3.17971 9.02681 2.73942L9.63423 1.65055C9.65334 1.61629 9.673 1.58197 9.69185 1.54801C10.0341 0.931399 10.3447 0.372007 11.0395 0.122228C11.3642 0.00558404 11.6575 -0.0259323 11.9682 0.0206654ZM11.7827 1.25699C11.6925 1.24348 11.6083 1.24559 11.4624 1.29801C11.2547 1.37262 11.1599 1.482 10.726 2.25992L10.104 3.37418C9.87661 3.7818 9.68526 4.12636 9.50435 4.38883C9.31622 4.66176 9.09735 4.91105 8.7895 5.07145C8.45889 5.24359 8.04895 5.26437 7.64888 5.25602C7.23005 5.24727 6.68266 5.19854 5.99653 5.13785L5.97212 5.1359C5.07855 5.05687 4.24681 5.21471 3.48189 5.69254C3.2683 5.82597 3.17752 5.88584 3.11177 5.94742C3.06769 5.98875 3.02457 6.04071 2.97212 6.17008C2.92181 6.29423 2.9141 6.36672 2.91743 6.44254C2.92214 6.54831 2.94838 6.67393 3.00825 6.93766C3.33168 8.36213 4.17597 9.77815 5.32368 10.9259C6.47145 12.0737 7.88746 12.9179 9.31196 13.2414C9.57567 13.3012 9.70125 13.3284 9.80708 13.3332C9.88317 13.3366 9.95628 13.3288 10.0805 13.2785C10.2098 13.2261 10.2618 13.183 10.3032 13.1388C10.3648 13.0731 10.4245 12.9823 10.5581 12.7687C11.0412 11.9962 11.1921 11.161 11.1049 10.257L11.102 10.2316C11.0373 9.56133 10.986 9.02471 10.9751 8.61246C10.9645 8.21627 10.9836 7.8106 11.1547 7.47867C11.3146 7.16864 11.5639 6.949 11.8374 6.75992C12.0997 6.57857 12.4436 6.38699 12.8501 6.16031L13.9907 5.5236C14.7684 5.08979 14.877 4.99491 14.9516 4.78727C15.0039 4.64169 15.0061 4.55791 14.9926 4.46793C14.9738 4.34207 14.9231 4.19388 14.8139 3.89176C14.3982 2.74184 13.5088 1.85144 12.3588 1.4357C12.0567 1.32646 11.9085 1.27588 11.7827 1.25699Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg width="18" height="17" viewBox="0 0 17.916 16.2499" fill="none" aria-hidden>
      <path
        d="M1.01562 0.183058C1.2597 -0.0610194 1.65631 -0.0610194 1.90039 0.183058L16.9004 15.1831C17.1443 15.427 17.144 15.8227 16.9004 16.0668C16.6563 16.3109 16.2597 16.3109 16.0156 16.0668L13.248 13.2993C12.026 14.042 10.5798 14.5834 8.95801 14.5834C6.81587 14.5834 4.97996 13.6404 3.55859 12.5307C2.13596 11.4201 1.0843 10.1085 0.496094 9.28364C0.481566 9.26327 0.466095 9.24288 0.451172 9.22212C0.240262 8.92879 3.22639e-05 8.59377 0 8.12544C0 7.65713 0.240269 7.32208 0.451172 7.02876C0.466137 7.00795 0.481526 6.98669 0.496094 6.96626C1.09084 6.13233 2.16403 4.79361 3.62012 3.67134L1.01562 1.06685C0.772004 0.82275 0.771741 0.426993 1.01562 0.183058ZM4.5127 4.56392C3.13015 5.59762 2.09191 6.882 1.51367 7.69282C1.37795 7.88314 1.31304 7.97616 1.27441 8.05025C1.24987 8.0974 1.24993 8.11083 1.25 8.12349V8.12739C1.24993 8.14002 1.25 8.15272 1.27441 8.19966C1.31302 8.27383 1.37762 8.36729 1.51367 8.55806C2.06384 9.32953 3.03466 10.5373 4.32715 11.5463C5.62091 12.5564 7.19246 13.3334 8.95801 13.3334C10.1867 13.3334 11.3202 12.9557 12.334 12.3852L10.6484 10.6997C10.1522 11.0454 9.54913 11.2504 8.89844 11.2504C7.20556 11.2503 5.83325 9.87788 5.83301 8.18501C5.83301 7.53424 6.03701 6.93033 6.38281 6.43403L4.5127 4.56392ZM8.95801 1.66743C11.1 1.66743 12.9361 2.60966 14.3574 3.71919C15.7799 4.82968 16.8317 6.14142 17.4199 6.96626C17.4345 6.98669 17.4499 7.00795 17.4648 7.02876C17.6757 7.32208 17.916 7.65713 17.916 8.12544C17.916 8.59377 17.6758 8.92879 17.4648 9.22212C17.4499 9.24287 17.4344 9.26328 17.4199 9.28364C17.0167 9.8491 16.3997 10.639 15.5977 11.435C15.3527 11.6782 14.957 11.6761 14.7139 11.4311C14.4707 11.1861 14.4718 10.7905 14.7168 10.5473C15.4558 9.8138 16.0282 9.08267 16.4023 8.55806C16.5384 8.36729 16.603 8.27383 16.6416 8.19966C16.666 8.15272 16.6661 8.14002 16.666 8.12739V8.12349C16.6661 8.11083 16.6661 8.0974 16.6416 8.05025C16.603 7.97616 16.5381 7.88314 16.4023 7.69282C15.8522 6.92137 14.8813 5.71356 13.5889 4.70454C12.2951 3.69452 10.7236 2.91743 8.95801 2.91743C8.27363 2.91743 7.61988 3.03348 7 3.23482C6.67171 3.34147 6.31856 3.16174 6.21191 2.83345C6.10548 2.50531 6.28522 2.15304 6.61328 2.04634C7.34517 1.80857 8.12952 1.66743 8.95801 1.66743ZM7.29004 7.34126C7.15763 7.59322 7.08301 7.88041 7.08301 8.18501C7.08325 9.18752 7.89592 10.0003 8.89844 10.0004C9.2029 10.0004 9.48933 9.92474 9.74121 9.79243L7.29004 7.34126Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 17.9165 17.9168" fill="none" aria-hidden>
      <path
        d="M6.68082 0.308586C11.1882 -0.894948 15.8149 1.5245 17.4279 5.78124C17.4982 5.96694 17.4761 6.17499 17.3683 6.34179C17.2605 6.50854 17.0802 6.61479 16.882 6.62694L14.7902 6.7539C14.4457 6.77487 14.1491 6.5125 14.1281 6.16796C14.1073 5.82354 14.3696 5.5278 14.714 5.50683L15.9074 5.43359C14.2804 2.27251 10.6003 0.555109 7.00309 1.51562C2.86373 2.62105 0.410633 6.85034 1.51481 10.957C2.61931 15.0647 6.8676 17.5059 11.008 16.4004C14.0804 15.58 16.2255 13.0375 16.674 10.1006C16.7262 9.75956 17.0449 9.52527 17.3859 9.57714C17.727 9.62924 17.9612 9.94796 17.9093 10.2891C17.388 13.7026 14.8962 16.6562 11.3302 17.6084C6.53005 18.8899 1.59298 16.0609 0.307777 11.2812C-0.977361 6.50087 1.88003 1.59061 6.68082 0.308586ZM8.95817 4.99999C9.30335 4.99999 9.58317 5.27981 9.58317 5.62499V8.69921L11.0666 10.1826C11.3106 10.4267 11.3106 10.8223 11.0666 11.0664C10.8225 11.3104 10.4268 11.3104 10.1828 11.0664L8.51676 9.40038C8.39955 9.28317 8.33317 9.12376 8.33317 8.958V5.62499C8.33317 5.27987 8.61307 5.00009 8.95817 4.99999Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPlusSmall() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconHome() {
  return (
    <svg viewBox="20 18 20 20" fill="none" className="h-5 w-5" aria-hidden>
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M29.166 32.1666C29.166 31.7063 29.5391 31.3333 29.9993 31.3333H30.0068C30.4671 31.3333 30.8402 31.7063 30.8402 32.1666C30.8402 32.6268 30.4671 32.9999 30.0068 32.9999H29.9993C29.5391 32.9999 29.166 32.6268 29.166 32.1666Z" fill="currentColor" />
      <path d="M29.9991 19.458C30.873 19.458 31.6243 19.8037 32.4092 20.3779C33.1711 20.9353 34.0296 21.7586 35.1124 22.7969L38.7647 26.2988C39.0138 26.5377 39.0222 26.9335 38.7833 27.1826C38.5443 27.4316 38.1486 27.44 37.8995 27.2012L37.2911 26.6172V29.2969C37.2911 30.8283 37.2908 32.0419 37.1631 32.9912C37.0318 33.9681 36.7545 34.7583 36.1309 35.3818C35.5073 36.0054 34.7171 36.2827 33.7403 36.4141C32.7909 36.5417 31.5774 36.542 30.0459 36.542H29.9522C28.4207 36.542 27.2072 36.5417 26.2579 36.4141C25.281 36.2827 24.4908 36.0054 23.8672 35.3818C23.2437 34.7583 22.9664 33.9681 22.835 32.9912C22.7074 32.0419 22.7071 30.8283 22.7071 29.2969V26.6172L22.0987 27.2012C21.8496 27.44 21.4538 27.4316 21.2149 27.1826C20.976 26.9335 20.9843 26.5377 21.2334 26.2988L24.8858 22.7969C25.9686 21.7586 26.8271 20.9353 27.5889 20.3779C28.3739 19.8037 29.1251 19.458 29.9991 19.458ZM29.9991 20.708C29.4924 20.708 28.9975 20.8957 28.3262 21.3867C27.6397 21.889 26.8412 22.6533 25.7178 23.7305L23.9571 25.4189V29.25C23.9571 30.839 23.9591 31.9678 24.0743 32.8242C24.187 33.6626 24.3984 34.1454 24.751 34.498C25.1037 34.8507 25.5864 35.0621 26.4249 35.1748C27.2812 35.2899 28.4101 35.292 29.9991 35.292C31.5881 35.292 32.7169 35.2899 33.5733 35.1748C34.4117 35.0621 34.8944 34.8507 35.2471 34.498C35.5998 34.1454 35.8112 33.6626 35.9239 32.8242C36.039 31.9678 36.0411 30.839 36.0411 29.25V25.4189L34.2803 23.7305C33.1569 22.6533 32.3585 21.889 31.6719 21.3867C31.0007 20.8956 30.5058 20.708 29.9991 20.708Z" fill="currentColor" />
    </svg>
  );
}

function IconAutopilot() {
  return (
    <svg viewBox="20 22 20 20" fill="none" className="h-5 w-5" aria-hidden>
      <path opacity="0.4" d="M36.6657 34.2925H23.3414C23.2323 34.2925 23.1248 34.2641 23.0306 34.2091C22.1831 33.7225 20.6932 32.215 21.1232 29.9933C21.2848 29.1583 22.0664 28.2333 23.5114 27.1658C24.4873 26.4458 25.7507 25.6691 27.2665 24.8575C28.4482 24.2241 29.0998 23.875 30.0031 23.875C30.9065 23.875 31.5573 24.2241 32.7398 24.8575C34.2556 25.6691 35.519 26.445 36.4948 27.1658C37.9407 28.2333 38.7214 29.1575 38.8831 29.9933C39.3131 32.215 37.8239 33.7225 36.9764 34.2091C36.8814 34.2633 36.7748 34.2925 36.6648 34.2925H36.6657ZM23.5273 33.0425H36.4798C36.864 32.7691 37.9656 31.8299 37.6565 30.2316C37.589 29.8849 36.994 28.5525 32.1498 25.9608C31.0806 25.3875 30.5923 25.1266 30.0031 25.1266C29.414 25.1266 28.9257 25.3883 27.8565 25.9608C23.0123 28.5533 22.4173 29.8858 22.3498 30.2316C22.0407 31.8266 23.1456 32.77 23.5273 33.0425Z" fill="currentColor" />
      <path d="M36.5517 33.0434C36.7058 33.0434 36.8546 33.1002 36.9687 33.2035C37.8854 34.0277 38.327 35.4228 38.042 36.5961C37.7802 37.6718 36.9624 38.4402 35.7392 38.7602C33.9918 39.2151 32.0418 39.7003 31.0351 39.9486C30.566 40.0636 30.3079 40.1273 30.0029 40.1273L30.0039 40.1264C29.6973 40.1263 29.424 40.0593 28.9717 39.9477C27.965 39.6993 26.015 39.2151 24.2676 38.7602C23.0443 38.441 22.2266 37.6726 21.9648 36.5961C21.6799 35.4229 22.1207 34.0277 23.0371 33.2035C23.1521 33.1002 23.3009 33.0434 23.4551 33.0434H36.5517ZM23.7158 34.2934C23.25 34.825 23.0215 35.6487 23.1806 36.3012C23.3332 36.9268 23.805 37.3469 24.584 37.5502H24.583C26.3228 38.0035 28.2671 38.4863 29.2705 38.7338C29.6818 38.8354 29.8547 38.8763 30.0029 38.8764C30.1512 38.8764 30.324 38.8354 30.7363 38.7338C31.7396 38.4863 33.6839 38.0043 35.4238 37.5502C36.2028 37.3469 36.6745 36.9267 36.8271 36.3012C36.9855 35.6487 36.7578 34.825 36.292 34.2934H23.7158ZM29.2851 27.392C29.7351 27.147 30.2726 27.147 30.7226 27.392L31.6445 27.8939C32.1492 28.1689 32.3995 28.7343 32.2539 29.2699C32.0522 30.0133 31.5167 31.327 30.1992 31.7611C30.136 31.7819 30.0696 31.7923 30.0039 31.7924L29.9052 31.7846C29.8725 31.7793 29.8401 31.7715 29.8086 31.7611C28.4914 31.3271 27.9565 30.0142 27.7539 29.2699C27.6081 28.735 27.8584 28.169 28.3633 27.8939L29.2851 27.392ZM30.126 28.4906C30.0502 28.4498 29.9596 28.4499 29.8838 28.4906L28.9726 28.9857H28.9717C29.1025 29.4464 29.3976 30.1773 30.0039 30.4916C30.6105 30.1774 30.9062 29.4457 31.0371 28.9857L30.126 28.4906Z" fill="currentColor" />
    </svg>
  );
}

function IconWebsite() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.9" y="3.1" width="16.2" height="13.8" rx="3.6" />
      <path d="M1.9 7.4h16.2" />
      <path d="M4.9 5.25h.01M7.4 5.25h.01" strokeWidth="1.6" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M15.8 12.3a1.3 1.3 0 0 0 .26 1.43l.05.05a1.55 1.55 0 1 1-2.2 2.2l-.04-.05a1.3 1.3 0 0 0-1.43-.26 1.3 1.3 0 0 0-.79 1.19v.14a1.55 1.55 0 1 1-3.1 0v-.08a1.3 1.3 0 0 0-.85-1.19 1.3 1.3 0 0 0-1.43.26l-.05.05a1.55 1.55 0 1 1-2.2-2.2l.05-.05a1.3 1.3 0 0 0 .26-1.43 1.3 1.3 0 0 0-1.19-.79H2.9a1.55 1.55 0 1 1 0-3.1h.08a1.3 1.3 0 0 0 1.19-.85 1.3 1.3 0 0 0-.26-1.43l-.05-.05a1.55 1.55 0 1 1 2.2-2.2l.05.05a1.3 1.3 0 0 0 1.43.26h.06a1.3 1.3 0 0 0 .79-1.19V2.9a1.55 1.55 0 1 1 3.1 0v.08a1.3 1.3 0 0 0 .79 1.19 1.3 1.3 0 0 0 1.43-.26l.05-.05a1.55 1.55 0 1 1 2.2 2.2l-.05.05a1.3 1.3 0 0 0-.26 1.43v.06a1.3 1.3 0 0 0 1.19.79h.14a1.55 1.55 0 1 1 0 3.1h-.08a1.3 1.3 0 0 0-1.19.79Z" />
    </svg>
  );
}

function IconHelp() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7.4" />
      <path d="M7.9 7.7a2.1 2.1 0 0 1 4.05.77c0 1.4-2.1 2.1-2.1 2.1" />
      <path d="M10 14.2h.01" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg viewBox="20 102 20 20" fill="none" className="h-5 w-5" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M27.916 104.292C27.1106 104.292 26.4577 104.945 26.4577 105.75C26.4577 106.227 26.6858 106.65 27.0414 106.917C27.3174 107.124 27.3731 107.516 27.1657 107.792C26.9584 108.068 26.5666 108.124 26.2907 107.917C25.814 107.559 25.4585 107.046 25.2996 106.452C24.5237 106.682 23.9577 107.4 23.9577 108.25C23.9577 108.606 24.0565 108.938 24.2279 109.221C24.3341 109.396 24.3478 109.612 24.2647 109.799C24.1815 109.986 24.012 110.12 23.811 110.159C22.9452 110.324 22.291 111.086 22.291 112C22.291 112.78 22.768 113.45 23.4464 113.732C23.8005 113.314 24.2628 112.99 24.7911 112.803C25.1165 112.688 25.4736 112.859 25.5886 113.184C25.7037 113.51 25.5331 113.867 25.2076 113.982C24.7973 114.127 24.4512 114.412 24.2279 114.78C24.0565 115.062 23.9577 115.394 23.9577 115.75C23.9577 116.786 24.7971 117.625 25.8327 117.625C26.1779 117.625 26.4577 117.905 26.4577 118.25C26.4577 119.055 27.1106 119.708 27.916 119.708C28.7214 119.708 29.3743 119.055 29.3743 118.25V105.75C29.3743 104.945 28.7214 104.292 27.916 104.292ZM22.8447 114.833C21.7792 114.335 21.041 113.254 21.041 112C21.041 110.746 21.7792 109.665 22.8447 109.168C22.7556 108.877 22.7077 108.569 22.7077 108.25C22.7077 106.717 23.812 105.441 25.2687 105.176C25.5321 103.956 26.6173 103.042 27.916 103.042C29.4118 103.042 30.6243 104.254 30.6243 105.75V118.25C30.6243 119.746 29.4118 120.958 27.916 120.958C26.6173 120.958 25.5321 120.044 25.2687 118.824C23.812 118.559 22.7077 117.283 22.7077 115.75C22.7077 115.431 22.7556 115.123 22.8447 114.833Z" fill="currentColor" />
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M32.084 119.708C32.8894 119.708 33.5423 119.055 33.5423 118.25C33.5423 117.773 33.3142 117.35 32.9586 117.083C32.6826 116.876 32.6269 116.484 32.8343 116.208C33.0416 115.932 33.4334 115.876 33.7093 116.083C34.186 116.441 34.5415 116.954 34.7004 117.548C35.4763 117.318 36.0423 116.6 36.0423 115.75C36.0423 115.394 35.9435 115.062 35.7721 114.779C35.6659 114.604 35.6522 114.388 35.7353 114.201C35.8185 114.014 35.988 113.88 36.189 113.841C37.0548 113.676 37.709 112.914 37.709 112C37.709 111.22 37.232 110.55 36.5536 110.268C36.1995 110.686 35.7372 111.01 35.2089 111.197C34.8835 111.312 34.5264 111.141 34.4114 110.816C34.2963 110.49 34.4669 110.133 34.7924 110.018C35.2027 109.873 35.5488 109.588 35.7721 109.22C35.9435 108.938 36.0423 108.606 36.0423 108.25C36.0423 107.214 35.2029 106.375 34.1673 106.375C33.8221 106.375 33.5423 106.095 33.5423 105.75C33.5423 104.945 32.8894 104.292 32.084 104.292C31.2786 104.292 30.6257 104.945 30.6257 105.75L30.6257 118.25C30.6257 119.055 31.2786 119.708 32.084 119.708ZM37.1553 109.167C38.2208 109.665 38.959 110.746 38.959 112C38.959 113.254 38.2208 114.335 37.1553 114.832C37.2444 115.123 37.2923 115.431 37.2923 115.75C37.2923 117.283 36.188 118.559 34.7313 118.824C34.4679 120.044 33.3827 120.958 32.084 120.958C30.5882 120.958 29.3757 119.746 29.3757 118.25L29.3757 105.75C29.3757 104.254 30.5882 103.042 32.084 103.042C33.3827 103.042 34.4679 103.956 34.7313 105.176C36.188 105.441 37.2923 106.717 37.2923 108.25C37.2923 108.569 37.2444 108.877 37.1553 109.167Z" fill="currentColor" />
    </svg>
  );
}

function IconHuman() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden
    >
      <path d="M16 19v-1.5a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3V19" />
      <circle cx="9.5" cy="7.5" r="3" />
      <path d="M21 19v-1.5a3 3 0 0 0-2.25-2.9" />
      <path d="M16 4.6a3 3 0 0 1 0 5.8" />
    </svg>
  );
}

function IconCompetitor() {
  return (
    <svg viewBox="20 142 20 20" fill="none" className="h-5 w-5" aria-hidden>
      <path opacity="0.4" d="M25.833 153.875C26.7245 153.875 27.2581 153.875 27.6914 154.292C28.1245 154.742 28.124 155.275 28.124 156.167V160.334C28.1238 160.675 27.8406 160.959 27.499 160.959H22.916C22.5745 160.959 22.2912 160.675 22.291 160.334V157C22.291 155.692 22.2912 154.975 22.8408 154.426C23.3908 153.876 24.1077 153.875 25.416 153.875H25.833ZM34.583 155.542C35.8909 155.542 36.6073 155.542 37.1572 156.092C37.7072 156.642 37.708 157.358 37.708 158.667V160.334C37.7078 160.675 37.4244 160.959 37.083 160.959H32.499C32.1576 160.959 31.8742 160.675 31.874 160.334V157.834C31.874 156.942 31.8745 156.409 32.291 155.975C32.741 155.542 33.2743 155.542 34.166 155.542H34.583ZM25.416 155.125C24.5079 155.125 23.9081 155.125 23.7246 155.308C23.5413 155.492 23.541 156.092 23.541 157V159.709H26.874V156.167C26.874 155.759 26.8741 155.243 26.8076 155.176C26.7576 155.126 26.2413 155.125 25.833 155.125H25.416ZM34.166 156.792C33.7583 156.792 33.2427 156.792 33.1748 156.858C33.1248 156.908 33.124 157.425 33.124 157.834V159.709H36.458V158.667C36.458 157.759 36.4576 157.159 36.2744 156.975C36.0911 156.792 35.4912 156.792 34.583 156.792H34.166ZM30.0166 143.042C30.4747 143.042 30.8911 143.35 31.1494 143.875L31.7334 145.058C31.7365 145.059 31.7674 145.067 31.7832 145.075L32.8164 145.242C33.3831 145.342 33.7831 145.65 33.9248 146.084C34.0664 146.525 33.9078 147.001 33.5078 147.409L32.6826 148.242L32.9082 149.301C33.1164 150.184 32.7577 150.592 32.5244 150.767C32.3994 150.859 32.1907 150.967 31.8994 150.967L31.8828 150.959C31.6412 150.959 31.3498 150.892 31 150.683L30.0078 150.092L28.9912 150.683C28.2167 151.141 27.7169 150.934 27.4834 150.767C27.2501 150.601 26.9002 150.184 27.1084 149.301L27.3418 148.275L26.5078 147.409C26.1078 147.001 25.9579 146.517 26.0996 146.075C26.2413 145.642 26.642 145.342 27.2002 145.242L28.2744 145.067L28.8662 143.875C29.1329 143.342 29.575 143.033 30.0166 143.042ZM29.9834 144.433L29.3994 145.608C29.2161 145.95 28.8495 146.225 28.4912 146.292L27.4082 146.467C27.4082 146.467 27.3745 146.467 27.3662 146.475C27.3745 146.492 27.3915 146.501 27.4082 146.517L28.2334 147.35C28.5166 147.634 28.6585 148.117 28.5752 148.525L28.3418 149.558C28.3418 149.558 28.333 149.6 28.333 149.617C28.3497 149.617 28.3583 149.6 28.375 149.592L29.3662 149C29.5578 148.892 29.7912 148.834 30.0244 148.834L30 148.842C30.2331 148.842 30.4662 148.9 30.6494 149.009L31.6416 149.6C31.6439 149.602 31.6678 149.617 31.6836 149.625C31.6836 149.608 31.6831 149.592 31.6748 149.575L31.4414 148.551C31.3581 148.134 31.4999 147.65 31.7832 147.358L32.6084 146.525C32.6105 146.522 32.6335 146.491 32.6494 146.483C32.6329 146.483 32.6161 146.484 32.5996 146.475L31.541 146.301C31.1578 146.225 30.7912 145.95 30.6162 145.625L30.0244 144.426C30.0244 144.426 30.0161 144.401 30.0078 144.392C30.0072 144.401 29.9916 144.417 29.9834 144.433Z" fill="currentColor" />
      <path d="M29.999 152.208C31.3072 152.208 32.0242 152.208 32.5742 152.758C33.1242 153.308 33.124 154.025 33.124 155.333V159.708H38.333C38.6745 159.709 38.958 159.992 38.958 160.333C38.958 160.675 38.6745 160.958 38.333 160.958H21.666C21.3243 160.958 21.041 160.675 21.041 160.333C21.041 159.992 21.3243 159.708 21.666 159.708H26.874V155.333C26.874 154.025 26.8748 153.308 27.4248 152.758C27.9747 152.209 28.6912 152.208 29.999 152.208ZM29.999 153.458C29.0909 153.458 28.4909 153.459 28.3076 153.642C28.1244 153.825 28.124 154.425 28.124 155.333V159.708H31.874V155.333C31.874 154.426 31.8744 153.826 31.6914 153.642C31.5081 153.459 30.9074 153.458 29.999 153.458Z" fill="currentColor" />
    </svg>
  );
}
