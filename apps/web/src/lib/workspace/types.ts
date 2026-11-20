
import type { Citation } from "@/lib/citations";
import type { Department } from "@/lib/agentRegistry";
import type { NextTile } from "@zavi/shared";

export type WorkspaceNextTilesPayload = {
  tiles: NextTile[];
  first_run_done: boolean;
};

export type TabKind =
  | "home"
  | "agent"
  | "run"
  | "brain"
  | "settings"
  | "members"
  | "autopilot"
  | "competitor"
  | "website"
  | "onboarding"
  | "analytics"
  | "channels"
  | "needs-you"
  | "messaging"
  | "meet"
  | "memory"
  | "calendar"
  | "artifacts"
  | "fundraising"
  | "supply-demand"
  | "engineer"
  | "agent-builder"
  | "dispute-detail"
  | "build";

export type TabDescriptor = {
  id: string;
  kind: TabKind;
  title: string;
  payload:
    | { kind: "home"; threadId?: string | null }
    | { kind: "analytics" }
    | {
        kind: "channels";
        channel?: string;
        action?: string;
      }
    | { kind: "needs-you"; decision?: string }
    | { kind: "messaging" }
    | { kind: "meet" }
    | { kind: "memory" }
    | { kind: "calendar" }
    | { kind: "artifacts" }
    | { kind: "fundraising" }
    | { kind: "supply-demand" }
    | { kind: "engineer" }
    | {
        kind: "agent-builder";
        agentId?: string | null;
        runId?: string | null;
      }
    | {
        kind: "agent";
        slug: string;
        threadId?: string | null;
        draftText?: string;
      }
    | { kind: "run"; runId: string }
    | { kind: "brain"; entityId?: string }
    | { kind: "settings"; section?: string }
    | { kind: "members" }
    | { kind: "autopilot"; decision?: string }
    | { kind: "competitor" }
    | { kind: "website" }
    | { kind: "onboarding" }
    | {
        kind: "build";
        sessionId: string | null;
        threadId?: string | null;
      }
    | {
        kind: "dispute-detail";
        disputeId: string;
        threadId?: string | null;
      };
  dirty: boolean;
  pinned: boolean;
  customTitle?: boolean;
  unread?: boolean;
};

export type WorkspaceViewMode = "chat" | "threaded";

export type WorkspacePrefs = {
  viewMode?: WorkspaceViewMode;
  paneWidthPct?: number;
};

export type InspectorContent =
  | { kind: "empty" }
  | { kind: "home_default" }
  | { kind: "agent_default"; slug: string }
  | { kind: "citation_preview"; citation: Citation; pinnedToTabId: string }
  | { kind: "entity"; entityId: string }
  | { kind: "decision_context"; decisionId: string };

export type WorkspaceContextValue = {
  tabs: TabDescriptor[];
  activeTabId: string;
  openTab: (
    descriptor: Omit<TabDescriptor, "id">,
    opts?: { push?: boolean },
  ) => string;
  openAgentTab: (
    slug: string,
    opts?: { newThread?: boolean; threadId?: string; push?: boolean },
  ) => Promise<string>;
  closeTab: (id: string, opts?: { toHome?: boolean }) => void;
  setActiveTab: (id: string, opts?: { push?: boolean }) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  setTabThreadId: (
    tabId: string,
    threadId: string | null,
    opts?: { activate?: boolean; push?: boolean },
  ) => void;
  openBuildTab: (
    sessionId?: string | null,
    opts?: { activate?: boolean; push?: boolean },
  ) => string;
  buildSessionId: string | null;
  setTabTitle: (tabId: string, title: string) => void;
  renameTab: (tabId: string, title: string) => void;
  reorderTabs: (activeId: string, overId: string) => void;

  inspectorByTab: Record<string, InspectorContent>;
  setInspectorForTab: (tabId: string, content: InspectorContent) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  seedComposer: (opts: {
    agentSlug: string;
    text: string;
    tabId?: string;
    thread?: "current" | "new";
    autoSend?: boolean;
    placeholderHint?: string;
    origin?: "edit";
    editMessageId?: string;
  }) => void;
  composerSeeds: Record<
    string,
    {
      text: string;
      nonce: number;
      autoSend?: boolean;
      placeholderHint?: string;
      origin?: "edit";
      editMessageId?: string;
    }
  >;
  consumeComposerSeed: (tabId: string) => void;

  builderRetryNonce: number;
  requestBuilderRetry: () => void;
  ackBuilderRetry: (nonce: number) => void;

  markUrlWritten: (qs: string) => void;

  unreadTabIds: Record<string, true>;
  markTabUnread: (tabId: string) => void;
  clearTabUnread: (tabId: string) => void;

  treeAgents: Array<{
    slug: string;
    department?: string;
    latest_run_started_at: string | null;
    latest_run_status: string | null;
    latest_event_preview: string;
    pending_decisions_count: number;
    has_unseen_pending: boolean;
    unseen_thread_count: number;
    locked_tier?: string | null;
    name?: string;
    custom?: boolean;
    custom_agent_id?: string;
  }>;
  userEmail?: string;
  tenantName?: string;
  tenantId?: string;
  initialNextTiles: WorkspaceNextTilesPayload | null;
  currentUserId?: string;

  role: "owner" | "admin" | "member" | "viewer" | null;

  supplyDemandEligible: boolean;

  supplyDemandReachable: boolean;

  creditsRemaining: number | null;
  creditsAllowance: number | null;
  creditsTotal: number | null;
  creditsEnforced: boolean;

  approvalsPending: number;

  seenThisSession: Set<string>;
  markAgentSeen: (slug: string) => void;

  markThreadSeen: (threadId: string, opts?: { again?: boolean }) => void;
  viewMode: WorkspaceViewMode;
  setViewMode: (mode: WorkspaceViewMode) => void;
  paneWidthPct: number;
  setPaneWidthPct: (pct: number) => void;
  layout: "zavi" | "legacy";

  refreshTree: () => Promise<void>;
};

export type ExplorerAgentNode = {
  slug: string;
  name: string;
  pip: "live" | "idle" | "failed" | null;
  pendingDecisions: number;
};

export type ExplorerNode =
  | { kind: "home" }
  | {
      kind: "department";
      name: Department;
      collapsed: boolean;
      agents: ExplorerAgentNode[];
    }
  | { kind: "brain" }
  | { kind: "settings" };

export type ChatThreadState = {
  rows: unknown[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  activeRunId: string | null;
  cronExpanded: Record<string, boolean>;
  errorMsg: string | null;
};

export type InlineStatusState = {
  phase:
    | "spawning"
    | "reading"
    | "calling"
    | "drafting"
    | "done"
    | "error"
    | "cancelled"
    | "waiting";
  detail: string;
  elapsedSec: number;
  costUsd: number | null;
};

export type WorkspaceBootstrapPayload = {
  tree: {
    agents: Array<{
      slug: string;
      department?: string;
      latest_run_started_at: string | null;
      latest_run_status: string | null;
      latest_event_preview: string;
      pending_decisions_count: number;
      has_unseen_pending: boolean;
      unseen_thread_count: number;
      locked_tier?: string | null;
      name?: string;
      custom?: boolean;
      custom_agent_id?: string;
    }>;
  };
  tabs_session: {
    tabs: TabDescriptor[];
    active_tab_id: string | null;
  };
  status_counters: {
    drift_pct: number;
    cost_today_usd: number;
    active_runs: number;
    approvals_pending: number;
    credits_remaining: number | null;
    credits_enforced: boolean;
    included_allowance: number | null;
    credits_total?: number | null;
  };
  prefs: WorkspacePrefs;
  supply_demand_eligible?: boolean;
  supply_demand_reachable?: boolean;
};
