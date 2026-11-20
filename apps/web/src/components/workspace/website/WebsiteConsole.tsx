"use client";

import { publicAppUrl } from "@/lib/workspace/publicAppUrl";
import {
  BUILTIN_BLOCKED_TITLE,
  BUILTIN_NOT_LIVE_COPY,
  BUILTIN_STUCK_TITLE,
  DNS_NOT_CONFIGURED_COPY,
  builtinStuckCopy,
} from "./PublishPopover";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LayoutGrid,
  Users,
  Database,
  Globe,
  Search,
  Pencil,
  Copy,
  CopyPlus,
  Check,
  ExternalLink,
  Link2,
  Send,
  Eye,
  EyeOff,
  ChevronDown,
  Loader2,
  Activity,
  MoreHorizontal,
  SlidersHorizontal,
  UserPlus,
  Table2,
  ArrowDownAZ,
  ArrowLeft,
  Info,
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  X,
  KeyRound,
  Code2,
  Clock,
} from "lucide-react";
import { SITE_FUNCTIONS_TIMEOUT_MS, SiteFunctionsSettings, SiteSectionSkeleton, withDeadline } from "./SiteFunctionsSettings";
import { SiteDomainsSkeleton, SiteDomainsView } from "./SiteDomainsView";
import { Skeleton } from "../Skeleton";
import { BusinessInboxAddress } from "../BusinessInboxAddress";
import { SiteRename } from "./SiteRename";
import { AppInitialTile } from "./AppInitialTile";
import { apiFetch } from "@/lib/api";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { AppUsageCard } from "./AppUsageCard";
import { DuplicateSiteDialog } from "./DuplicateSiteDialog";
import { notifyBuildSessionsChanged } from "@/lib/workspace/useBuildSessions";
import { Tooltip } from "../Tooltip";
import { useWorkspace } from "../WorkspaceShell";
import { readWebsiteParam, writeWebsiteParam } from "./websiteUrlParams";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { siteName } from "@/lib/workspace/buildHistory";

type Visibility = "public" | "private" | "unlisted";

type OverviewPayload = {
  app: {
    name: string;
    description: string | null;
    created_at: string | null;
    deployed_url: string | null;
    build_status: string | null;
  };
  visibility: Visibility | null;
  badge_hidden: boolean | null;
  site?: { id: string; hostname: string; status: string } | null;
};

export const WORKSPACE_OVERVIEW_URL = "/api/website/overview?app=workspace";

export function overviewUrl(buildSessionId: string | null | undefined): string {
  return buildSessionId
    ? `/api/website/overview?build_session_id=${encodeURIComponent(buildSessionId)}`
    : WORKSPACE_OVERVIEW_URL;
}

type NavKey = "overview" | "users" | "data" | "domains" | FunctionsNavKey;
type FunctionsNavKey = "secrets" | "functions" | "schedules";
const FUNCTIONS_NAV_KEYS: readonly string[] = ["secrets", "functions", "schedules"];
const SITE_NAV_KEYS: readonly string[] = [...FUNCTIONS_NAV_KEYS];
const SITE_MEMBER_NAV_KEYS: readonly string[] = ["overview", "domains"];
const WORKSPACE_NAV_KEYS: readonly string[] = ["users", "data"];
const isNavKey = (s: unknown): s is NavKey =>
  s === "overview" || s === "domains" || WORKSPACE_NAV_KEYS.includes(s as string) || SITE_NAV_KEYS.includes(s as string);

type NavItem = {
  key: NavKey;
  label: string;
  icon: typeof LayoutGrid;
  expandable?: boolean;
  wired?: boolean;
};

const NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid, wired: true },
  { key: "users", label: "Users", icon: Users },
  { key: "data", label: "Data", icon: Database, expandable: true },
  { key: "domains", label: "Domains", icon: Globe },
];

const SITE_NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid, wired: true },
  { key: "domains", label: "Domains", icon: Globe, wired: true },
  { key: "secrets", label: "Secrets", icon: KeyRound, wired: true },
  { key: "functions", label: "Functions", icon: Code2, wired: true },
  { key: "schedules", label: "Schedules", icon: Clock, wired: true },
];

export function expectedNavRowsAfterOverview(session: { site?: unknown } | undefined, manager: boolean): number {
  const site = session ? !!session.site : true;
  const nav = site
    ? SITE_NAV.filter((n) => SITE_MEMBER_NAV_KEYS.includes(n.key) || manager)
    : NAV;
  return nav.length - 1;
}

export function relativeCreated(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days <= 0) return "Created today";
  if (days === 1) return "Created 1 day ago";
  if (days < 30) return `Created ${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "Created 1 month ago" : `Created ${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "Created 1 year ago" : `Created ${years} years ago`;
}

export function WebsiteConsole({
  navSignal,
  onDeployedUrlChanged,
  usageRunIds = null,
  buildSessionId = null,
}: {
  navSignal?: { section: string; nonce: number } | null;
  buildSessionId?: string | null;
  onDeployedUrlChanged?: () => void;
  usageRunIds?: ReadonlyArray<string> | null;
  usageChangeCount?: number;
} = {}) {
  const { openTab, role, openBuildTab } = useWorkspace();
  const [duplicating, setDuplicating] = useState(false);
  const [active, setActive] = useState<NavKey>(() => {
    const s = readWebsiteParam("section");
    return isNavKey(s) ? s : "overview";
  });
  useEffect(() => {
    writeWebsiteParam("section", active);
  }, [active]);
  useEffect(() => {
    const s = navSignal?.section;
    if (isNavKey(s)) {
      setActive(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSignal?.nonce]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [inviteRequested, setInviteRequested] = useState(false);
  const requestInvite = useCallback(() => {
    setInviteRequested(true);
    setActive("users");
  }, []);
  const clearInviteRequest = useCallback(() => setInviteRequested(false), []);
  useEffect(() => {
    if (active !== "users") setInviteRequested(false);
  }, [active]);
  const [search, setSearch] = useState("");

  const openSettings = useCallback((section?: string) => {
    if (section && typeof window !== "undefined") {
      const target = `#${section}`;
      if (window.location.hash === target) {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } else {
        window.location.hash = section;
      }
    }
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
  }, [openTab]);

  useEffect(() => {
    let cancelled = false;
    const deadline = withDeadline(SITE_FUNCTIONS_TIMEOUT_MS);
    setPhase("loading");
    setData(null);
    void (async () => {
      try {
        const res = await apiFetch(overviewUrl(buildSessionId), { signal: deadline.signal });
        if (cancelled) return;
        if (!res.ok) {
          setPhase("error");
          return;
        }
        const j = (await res.json()) as OverviewPayload;
        if (cancelled) return;
        setData(j);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      } finally {
        deadline.dispose();
      }
    })();
    return () => {
      cancelled = true;
      deadline.dispose();
    };
  }, [buildSessionId]);

  const isSite = !!data?.site;
  const { sessions: buildSessions, flags: siteFlags } = useBuildSessions();
  const shownSiteName = isSite && siteFlags.siteNames
    ? siteName(buildSessions.find((row) => row.id === buildSessionId)?.site)
    : null;
  const overviewData = useMemo(
    () => (data && shownSiteName ? { ...data, app: { ...data.app, name: shownSiteName } } : data),
    [data, shownSiteName],
  );
  const workspaceAppConsole = phase === "ready" && !!data && !isSite;
  useEffect(() => {
    if (phase !== "ready" || !data) return;
    if (isSite ? WORKSPACE_NAV_KEYS.includes(active) : SITE_NAV_KEYS.includes(active)) setActive("overview");
  }, [phase, data, isSite, active]);

  const canManageInvites = role === "owner" || role === "admin";
  const overviewDeployedUrl = data?.app.deployed_url ?? null;
  const [inviteProbe, setInviteProbe] = useState<"loading" | "ready" | "roles_not_configured" | "no_signup" | "error">("loading");
  useEffect(() => {
    if (!workspaceAppConsole || !canManageInvites || !overviewDeployedUrl) return;
    let cancelled = false;
    setInviteProbe("loading");
    void (async () => {
      try {
        const res = await apiFetch("/api/website/app-invites");
        const payload = (await res.json().catch(() => null)) as
          | { connected?: boolean; signup_available?: boolean | null; error?: { code?: string } }
          | null;
        if (cancelled) return;
        if (res.ok && payload?.connected === true && payload.signup_available === false) setInviteProbe("no_signup");
        else if (res.ok && payload?.connected === true) setInviteProbe("ready");
        else if (
          (res.status === 409 && payload?.error?.code === "roles_not_configured") ||
          (res.ok && payload?.connected === false)
        ) setInviteProbe("roles_not_configured");
        else setInviteProbe("error");
      } catch {
        if (!cancelled) setInviteProbe("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceAppConsole, canManageInvites, overviewDeployedUrl]);
  const inviteBlockedReason = !overviewDeployedUrl
    ? "Publish your app before inviting people"
    : !canManageInvites
      ? "Only workspace owners and admins can invite people"
      : inviteProbe === "roles_not_configured"
        ? "Roles aren’t set up on this site yet"
        : inviteProbe === "no_signup"
          ? NO_SIGNUP_COPY
        : inviteProbe === "error"
          ? "We couldn’t check invites right now. Refresh to try again."
          : inviteProbe === "loading"
            ? "Checking whether this site supports invites…"
            : null;

  const patchSettings = useCallback(
    async (patch: {
      visibility?: Visibility;
      badge_hidden?: boolean;
      app?: { name: string; description: string | null };
    }) => {
      if (patch.visibility !== undefined || patch.badge_hidden !== undefined) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
                ...(patch.badge_hidden !== undefined ? { badge_hidden: patch.badge_hidden } : {}),
              }
            : prev,
        );
      }
      try {
        const res = await apiFetch("/api/website/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as {
          visibility: Visibility;
          badge_hidden: boolean;
          app?: { name: string; description: string | null };
        };
        setData((prev) =>
          prev
            ? {
                ...prev,
                visibility: j.visibility,
                badge_hidden: j.badge_hidden,
                ...(j.app ? { app: { ...prev.app, ...j.app } } : {}),
              }
            : prev,
        );
        if (patch.app !== undefined) {
          try {
            const fresh = await apiFetch(WORKSPACE_OVERVIEW_URL);
            if (fresh.ok) setData((await fresh.json()) as OverviewPayload);
          } catch {
          }
        }
        return true;
      } catch {
        try {
          const res = await apiFetch(WORKSPACE_OVERVIEW_URL);
          if (res.ok) setData((await res.json()) as OverviewPayload);
        } catch {
        }
        return false;
      }
    },
    [],
  );

  const navUnknown = phase !== "ready" && !!buildSessionId;
  const navLoading = phase === "loading" && !!buildSessionId;
  const navSkeletonRows = expectedNavRowsAfterOverview(
    buildSessions.find((row) => row.id === buildSessionId),
    role === "owner" || role === "admin",
  );
  const filteredNav = useMemo(() => {
    const nav = navUnknown
      ? NAV.filter((n) => n.key === "overview")
      : isSite
      ? SITE_NAV.filter((n) => SITE_MEMBER_NAV_KEYS.includes(n.key) || role === "owner" || role === "admin")
      : NAV;
    const q = search.trim().toLowerCase();
    if (!q) return nav;
    return nav.filter((n) => n.label.toLowerCase().includes(q));
  }, [search, isSite, role, navUnknown]);

  const { catalog: navCatalog } = useAppCatalog(workspaceAppConsole);
  const navTables = useMemo(() => {
    if (!navCatalog?.connected) return [];
    const tables = navCatalog.tables ?? [];
    const usersTableName = findUsersTable(tables)?.name;
    return tables.filter((table) => table.name !== usersTableName);
  }, [navCatalog]);
  const [dataOpen, setDataOpen] = useState(true);
  const [tableSignal, setTableSignal] = useState<{ name: string; nonce: number } | null>(null);
  const [openTableName, setOpenTableName] = useState<string | null>(null);
  const openTable = useCallback((name: string) => {
    setActive("data");
    setTableSignal((prev) => ({ name, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
      {}
      <nav aria-busy={navLoading || undefined} className="flex w-[220px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[#f0f0f0] p-3">
        <div className="mb-1 flex h-9 items-center gap-2 rounded-full border border-[#f0f0f0] px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-[#8c8c8c]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            aria-label="Search console"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[#0e0f11] outline-none placeholder:text-[#8c8c8c]"
          />
        </div>
        {filteredNav.map((item) => {
          const Icon = item.icon;
          const isActive = item.key === active;
          const canExpand = item.expandable && navTables.length > 0;
          return (
            <div key={item.key}>
              {}
              <div
                className={`relative flex w-full items-center rounded-cta font-medium transition-colors duration-150 motion-reduce:transition-none ${
                  isActive ? "bg-bone text-ink" : "text-inkSoft hover:bg-bone hover:text-ink"
                }`}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute -left-1 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-ink"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setActive(item.key)}
                  aria-current={isActive ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-cta px-2.5 py-[7px] text-left text-[13px]"
                >
                  <Icon className="h-4 w-4 shrink-0 text-inkSoft" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
                {canExpand && (
                  <button
                    type="button"
                    aria-label={dataOpen ? "Collapse tables" : "Expand tables"}
                    aria-expanded={dataOpen}
                    onClick={() => setDataOpen((v) => !v)}
                    className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-cta text-[#b0b0b0] transition-colors hover:bg-[#ececec] hover:text-[#595959]"
                  >
                    {dataOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>

              {canExpand && dataOpen && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {navTables.map((t) => {
                    const tableActive = active === "data" && openTableName === t.name;
                    return (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => openTable(t.name)}
                        title={t.name}
                        aria-current={tableActive ? "page" : undefined}
                        className={`truncate rounded-cta py-1.5 pl-[38px] pr-2.5 text-left text-[13px] transition-colors ${
                          tableActive
                            ? "bg-[#f4f4f4] font-semibold text-[#0e0f11]"
                            : "text-[#595959] hover:bg-[#f9f9f9] hover:text-[#0e0f11]"
                        }`}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {navLoading && !search.trim() && (
          <div aria-hidden data-testid="console-nav-skeleton" className="flex flex-col gap-1">
            {Array.from({ length: navSkeletonRows }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-2.5 py-2.5">
                <Skeleton className="h-4 w-4 shrink-0" rounded="rounded" delayMs={i * 80} />
                <Skeleton className="h-3 w-20" delayMs={i * 80} />
              </div>
            ))}
          </div>
        )}
      </nav>

      {}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {phase === "loading" && <ConsoleSkeleton section={active} />}
        {phase === "error" && (
          <div className="p-6">
            <div className="rounded-xl border border-[#f0f0f0] bg-[#f9f9f9] p-4 text-[13px] text-[#595959]">
              We couldn&rsquo;t load your app details. Refresh to try again.
            </div>
          </div>
        )}
        {phase === "ready" && data && (
          <>
            {(active === "overview" || (isSite && active !== "domains" && !SITE_NAV_KEYS.includes(active))) && (
              <OverviewView
                data={overviewData ?? data}
                canManage={role === "owner" || role === "admin"}
                onPatch={patchSettings}
                onOpenSettings={openSettings}
                onSendInvites={requestInvite}
                inviteBlockedReason={inviteBlockedReason}
                usageRunIds={usageRunIds}
                onDuplicate={(overviewData ?? data).site ? () => setDuplicating(true) : undefined}
              />
            )}
            {duplicating && (overviewData ?? data).site && (
              <DuplicateSiteDialog
                siteId={(overviewData ?? data).site!.id}
                siteName={(overviewData ?? data).app.name}
                onClose={() => setDuplicating(false)}
                onDuplicated={(copy) => {
                  setDuplicating(false);
                  notifyBuildSessionsChanged();
                  openBuildTab(copy.conductor_run_id, { activate: true });
                }}
              />
            )}
            {isSite && active === "domains" && <BusinessInboxAddress variant="card" />}
            {isSite && buildSessionId && FUNCTIONS_NAV_KEYS.includes(active) && (
              <SiteFunctionsSettings
                key={`${buildSessionId}:${active}`}
                buildSessionId={buildSessionId}
                section={active as FunctionsNavKey}
              />
            )}
            {active === "users" && !isSite && (
              <UsersView
                deployedUrl={data.app.deployed_url}
                inviteRequested={inviteRequested}
                onInviteRequestHandled={clearInviteRequest}
              />
            )}
            {active === "data" && !isSite && (
              <DataView tableSignal={tableSignal} onOpenTableChange={setOpenTableName} />
            )}
            {active === "domains" && data.site && (
              <SiteDomainsView site={data.site} deployedUrl={data.app.deployed_url} />
            )}
            {active === "domains" && !isSite && (
              <DomainsView
                deployedUrl={data.app.deployed_url}
                onDeployedUrlChanged={onDeployedUrlChanged}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function OverviewView({
  data,
  canManage,
  onPatch,
  onOpenSettings,
  onSendInvites,
  inviteBlockedReason,
  usageRunIds = null,
  onDuplicate,
}: {
  data: OverviewPayload;
  canManage: boolean;
  onPatch: (p: {
    visibility?: Visibility;
    badge_hidden?: boolean;
    app?: { name: string; description: string | null };
  }) => Promise<boolean>;
  onOpenSettings: (section?: string) => void;
  onSendInvites: () => void;
  inviteBlockedReason?: string | null;
  usageRunIds?: ReadonlyArray<string> | null;
  onDuplicate?: () => void;
}) {
  const { app } = data;
  const isSite = !!data.site;
  const sendInvitesBlockedReason = !app.deployed_url
    ? "Publish your app before inviting people"
    : inviteBlockedReason ?? null;
  const created = relativeCreated(app.created_at, Date.now());
  const [copiedFrom, setCopiedFrom] = useState<"button" | "menu" | null>(null);
  const [savingBadge, setSavingBadge] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenu = useDismissableMenu(moreRef, moreBtnRef);

  const copyLink = useCallback(
    async (source: "button" | "menu") => {
      if (!app.deployed_url) return;
      try {
        await navigator.clipboard.writeText(app.deployed_url);
        setCopiedFrom(source);
        window.setTimeout(() => setCopiedFrom(null), 3000);
      } catch {
      }
    },
    [app.deployed_url],
  );

  return (
    <div className="mx-auto max-w-[840px] p-6">
      {}
      <div className="flex items-start gap-4">
        <AppInitialTile name={app.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[20px] font-semibold leading-7 text-[#0e0f11]">
              {app.name}
            </h2>
            {canManage && data.site && <SiteRename key={`${data.site.id}:${app.name}`} siteId={data.site.id} name={app.name} />}
            {canManage && !isSite && (
              <button
                type="button"
                onClick={() => setEditingDetails(true)}
                aria-label="Edit app details"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-cta text-[#595959] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </button>
            )}
            <div className="flex-1" />
            {}
          </div>
          {app.description && (
            <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-[#595959]">
              {app.description}
            </p>
          )}
          {(created || app.build_status) && (
            <p className="mt-1.5 flex items-center gap-2 text-[12px] text-[#8c8c8c]">
              {created && <span>{created}</span>}
              {app.build_status && app.build_status !== "done" && (
                <span className="rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-medium capitalize text-[#595959]">
                  build {app.build_status}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {editingDetails && (
        <EditAppDetailsDialog
          app={app}
          onClose={() => setEditingDetails(false)}
          onSave={async (nextApp) => {
            const saved = await onPatch({ app: nextApp });
            if (saved) setEditingDetails(false);
            return saved;
          }}
        />
      )}

      {}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!usageRunIds && (
          <button
            type="button"
            onClick={() => onOpenSettings("billing")}
            className="inline-flex h-10 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
          >
            <Activity className="h-4 w-4 text-[#595959]" /> View usage
          </button>
        )}
        <div ref={moreRef} className="relative">
          <button
            ref={moreBtnRef}
            type="button"
            onClick={moreMenu.toggle}
            aria-haspopup="menu"
            aria-expanded={moreMenu.open}
            aria-label="More actions"
            className="inline-flex h-10 w-10 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white text-[#595959] transition-colors hover:bg-[#f9f9f9]"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {moreMenu.open && (
            <div
              role="menu"
              className="absolute left-0 z-10 mt-1.5 w-44 rounded-xl border border-[#ececec] bg-white p-1 shadow-lg"
            >
              {app.deployed_url ? (
                <a
                  role="menuitem"
                  href={app.deployed_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => moreMenu.close(false)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[#0e0f11] transition-colors hover:bg-[#f4f4f4]"
                >
                  <ExternalLink className="h-4 w-4 text-[#595959]" /> Open app
                </a>
              ) : (
                <span className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[#c4c4c4]">
                  <ExternalLink className="h-4 w-4" /> Not published yet
                </span>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={!app.deployed_url}
                onClick={() => void copyLink("menu")}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-[#0e0f11] transition-colors hover:bg-[#f4f4f4] disabled:cursor-not-allowed disabled:text-[#c4c4c4]"
              >
                {copiedFrom === "menu" ? <Check className="h-4 w-4 text-[#0e9f6e]" /> : <Copy className="h-4 w-4 text-[#595959]" />}
                {copiedFrom === "menu" ? "Copied" : "Copy link"}
              </button>
              {isSite && canManage && onDuplicate && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    moreMenu.close(false);
                    onDuplicate();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-[#0e0f11] transition-colors hover:bg-[#f4f4f4]"
                >
                  <CopyPlus className="h-4 w-4 text-[#595959]" /> Duplicate site
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {}
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
        {usageRunIds && (
          <AppUsageCard
            runIds={usageRunIds}
            onOpenBilling={() => onOpenSettings("billing")}
          />
        )}
        {isSite && <BusinessInboxAddress variant="card" />}
        {!isSite && (
        <div className="rounded-2xl border border-[#f0f0f0] p-4">
          <h3 className="text-[16px] font-semibold text-[#0e0f11]">Invite Users</h3>
          <p className="mt-0.5 text-[12px] leading-5 text-[#8c8c8c]">
            Grow your user base by inviting others.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyLink("button")}
              disabled={!app.deployed_url}
              aria-live="polite"
              className="inline-flex h-10 min-w-[124px] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:cursor-not-allowed disabled:text-[#c4c4c4]"
            >
              {copiedFrom === "button" ? (
                <>
                  <Check className="h-4 w-4 text-[#0e9f6e]" /> Copied!
                </>
              ) : (
                <>
                  <Link2 className="h-4 w-4" /> Copy Link
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onSendInvites}
              disabled={sendInvitesBlockedReason !== null}
              title={sendInvitesBlockedReason ?? undefined}
              className="inline-flex h-10 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-cta bg-[#0e0f11] px-3 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-4 w-4 shrink-0" aria-hidden /> Send Invites
            </button>
          </div>
        </div>
        )}
      </div>

      {}
      {!isSite && (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#f0f0f0] p-4">
        <div className="min-w-0">
          <h3 className="text-[16px] font-semibold text-[#0e0f11]">Platform Badge</h3>
          <p className="mt-0.5 text-[12px] leading-5 text-[#8c8c8c]">
            Controls whether the &ldquo;Made with Zavi&rdquo; badge appears on your live
            app. Hide it to remove the badge from your deployed site.
          </p>
        </div>
        <button
          type="button"
          disabled={savingBadge || !canManage}
          title={canManage ? undefined : "Only owners and admins can change this"}
          onClick={async () => {
            setSavingBadge(true);
            await onPatch({ badge_hidden: !data.badge_hidden });
            setSavingBadge(false);
          }}
          className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
        >
          {savingBadge ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : data.badge_hidden ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
          {data.badge_hidden ? "Show Badge" : "Hide Badge"}
        </button>
      </div>
      )}
    </div>
  );
}

function EditAppDetailsDialog({
  app,
  onClose,
  onSave,
}: {
  app: OverviewPayload["app"];
  onClose: () => void;
  onSave: (app: { name: string; description: string | null }) => Promise<boolean>;
}) {
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = name.trim().length > 0 && name.trim().length <= 120 && description.trim().length <= 500;

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    const saved = await onSave({ name: name.trim(), description: description.trim() || null });
    if (!saved) {
      setError("We couldn’t save your app details. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-app-details-title"
        className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="edit-app-details-title" className="text-[20px] font-semibold text-[#0e0f11]">
              Edit app details
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-[#595959]">
              Update the name and description shown on your app overview.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close edit app details"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-cta text-[#595959] hover:bg-[#f4f4f4] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-5 block text-[14px] font-medium text-[#0e0f11]">
          App name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            autoFocus
            className="mt-1.5 h-10 w-full rounded-lg border border-[#d9d9d9] px-3 text-[14px] outline-none transition-colors focus:border-[#0e0f11]"
          />
        </label>
        <label className="mt-4 block text-[14px] font-medium text-[#0e0f11]">
          Description <span className="font-normal text-[#8c8c8c]">(optional)</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            rows={4}
            className="mt-1.5 w-full resize-y rounded-lg border border-[#d9d9d9] px-3 py-2 text-[14px] leading-5 outline-none transition-colors focus:border-[#0e0f11]"
          />
        </label>
        {error && <p role="alert" className="mt-3 text-[13px] text-[#b42318]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-10 rounded-cta px-3 text-[13px] font-medium text-[#454545] hover:bg-[#f4f4f4] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave || saving}
            className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#0e0f11] px-3 text-[13px] font-medium text-white hover:bg-[#2c2c2c] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  Icon,
  title,
  body,
}: {
  Icon: typeof Users;
  title: string;
  body: string;
}) {
  return (
    <div className="mx-auto max-w-[720px] p-6">
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[#e6e6e6] bg-[#fafafa] px-6 py-16 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#f0f0f0] text-[#8c8c8c]">
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">{title}</h3>
        <p className="max-w-[420px] text-[13px] leading-5 text-[#8c8c8c]">{body}</p>
      </div>
    </div>
  );
}

type CatalogColumn = {
  name: string;
  type: string;
  nullable?: boolean;
  has_default?: boolean;
  generated?: boolean;
  primary_key?: boolean;
  writable?: boolean;
  enum_values?: string[] | null;
};
type CatalogTable = {
  name: string;
  row_estimate: number | null;
  columns: CatalogColumn[];
  primary_key?: string[];
  writable?: boolean;
};
type AppCatalog = {
  connected: boolean;
  can_write?: boolean;
  reason?: string;
  discovery_error?: string;
  dialect?: string | null;
  tables?: CatalogTable[];
  entities?: { users?: { table: string; id_field?: string } } & Record<string, unknown>;
};

export function isProtectedConsoleColumnName(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const parts = normalized.split("_").filter(Boolean);
  const has = (value: string) => parts.includes(value);
  const pair = (left: string, right: string) =>
    parts.some((part, index) => part === left && parts[index + 1] === right);
  return has("password") || has("passwd") || has("pwd") || has("credential") ||
    has("credentials") || has("secret") ||
    normalized === "token" || normalized.endsWith("_token") ||
    normalized === "otp" || normalized.endsWith("_otp") ||
    normalized === "mfa_code" || normalized.endsWith("_mfa_code") ||
    pair("api", "key") || pair("access", "key") || pair("private", "key") ||
    pair("secret", "key") || pair("access", "token") || pair("refresh", "token") ||
    pair("auth", "token") || pair("bearer", "token") || pair("session", "token") ||
    pair("api", "token");
}

function isHiddenConsoleDisplayColumnName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "id" || normalized.endsWith("_id") || normalized === "slug";
}

const USERS_TABLE_NAMES = ["users", "user", "accounts", "account", "profiles", "profile"];
const NAME_KEYS = ["name", "full_name", "username", "display_name"];
const EMAIL_KEYS = ["email", "email_address"];
const ROLE_KEYS = ["role", "user_role"];
const USER_SHAPED_COLUMNS = new Set([...NAME_KEYS, ...EMAIL_KEYS]);

function hasUserShapedColumn(table: CatalogTable): boolean {
  return table.columns.some((column) => USER_SHAPED_COLUMNS.has(column.name.toLowerCase()));
}

export function findUsersTable(tables: CatalogTable[]): CatalogTable | null {
  const byName = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  for (const candidate of USERS_TABLE_NAMES) {
    const match = byName.get(candidate);
    if (match && hasUserShapedColumn(match)) return match;
  }
  return tables.find((table) => /(^|_)users?$/i.test(table.name) && hasUserShapedColumn(table)) ?? null;
}

let catalogInFlight: Promise<AppCatalog> | null = null;

function fetchAppCatalogOnce(): Promise<AppCatalog> {
  if (catalogInFlight) return catalogInFlight;
  const request = (async () => {
    const response = await apiFetch("/api/website/app-catalog");
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as AppCatalog;
  })();
  catalogInFlight = request;
  const release = () => {
    if (catalogInFlight === request) catalogInFlight = null;
  };
  request.then(release, release);
  return request;
}

export function __resetAppCatalogInflight(): void {
  catalogInFlight = null;
}

function useAppCatalog(enabled = true): { phase: "loading" | "ready" | "error"; catalog: AppCatalog | null } {
  const [state, setState] = useState<{ phase: "loading" | "ready" | "error"; catalog: AppCatalog | null }>({
    phase: "loading",
    catalog: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const catalog = await fetchAppCatalogOnce();
        if (cancelled) return;
        setState({ phase: "ready", catalog });
      } catch {
        if (!cancelled) setState({ phase: "error", catalog: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

function fmtCount(n: number | null): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

function ConnectDbState({
  icon: Icon,
  reason,
  error,
}: {
  icon: typeof Users;
  reason?: string;
  error?: string;
}) {
  if (
    reason === "app_db_not_provisioned" ||
    reason === "app_db_not_ready" ||
    reason === "not_ready"
  ) {
    return (
      <EmptyState
        Icon={Icon}
        title="No app database yet"
        body={
          reason === "app_db_not_ready" || reason === "not_ready"
            ? "Your app's database is still being set up. This finishes automatically. Check back shortly."
            : "Once Zavi builds and deploys your app, its database appears here with your live data."
        }
      />
    );
  }
  if (reason === "discovery_failed" || reason === "read_failed") {
    return (
      <EmptyState
        Icon={Icon}
        title="Couldn't read your app database"
        body={`Your app's database is provisioned, but we couldn't read it${error ? `: ${error}` : "."} This is usually temporary. Retry shortly.`}
      />
    );
  }
  if (reason === "app_db_unsupported") {
    return (
      <EmptyState
        Icon={Icon}
        title="This database isn't viewable yet"
        body="Your app is using a database shape this viewer doesn't read yet. Your app is unaffected."
      />
    );
  }
  const body =
    reason === "discovery_pending"
      ? "We're still reading your app database's structure. This finishes automatically; check back shortly."
      : reason === "empty"
        ? "Your app's database is connected, but it has no tables yet. Once your app writes its first data, it will appear here."
        : "Once your app is built and running, its tables, columns and rows appear here live.";
  return <EmptyState Icon={Icon} title="No app data yet" body={body} />;
}

function SchemaTable({ table }: { table: CatalogTable }) {
  const visibleColumns = table.columns.filter((column) =>
    !isProtectedConsoleColumnName(column.name) && !isHiddenConsoleDisplayColumnName(column.name),
  );
  return (
    <div className="overflow-hidden rounded-xl border border-[#f0f0f0]">
      <div className="grid grid-cols-[1fr_140px] border-b border-[#f0f0f0] bg-[#f9f9f9] px-3 py-2 text-[12px] font-semibold text-[#595959]">
        <span>Column</span>
        <span>Type</span>
      </div>
      {visibleColumns.map((c) => (
        <div
          key={c.name}
          className="grid grid-cols-[1fr_140px] border-b border-[#f4f4f4] px-3 py-2 text-[13px] last:border-b-0"
        >
          <span className="truncate font-medium text-[#0e0f11]">{c.name}</span>
          <span className="truncate text-[#8c8c8c]">{c.type}</span>
        </div>
      ))}
    </div>
  );
}

type RowCell = string | number | boolean | null;
type AppRows =
  | {
      connected: true;
      supported: true;
      dialect: string;
      table: string;
      columns: {
        name: string;
        type: string;
        nullable?: boolean;
        writable?: boolean;
        primary_key?: boolean;
        generated?: boolean;
        enum_values?: string[] | null;
      }[];
      rows: Record<string, RowCell>[];
      row_keys: Record<string, RowCell>[];
      row_versions: string[];
      truncated_columns?: string[][];
      has_more: boolean;
      masked_columns: string[];
      writable: boolean;
    }
  | { connected: true; supported: false; reason: string; message?: string }
  | { connected: false; reason?: string };

const ROWS_PAGE = 25;

function TableDetail({
  table,
  dialect,
  canWrite,
  onBack,
}: {
  table: CatalogTable;
  dialect: string | null;
  canWrite: boolean;
  onBack: () => void;
}) {
  const [view, setView] = useState<"data" | "schema">("data");
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-2 text-[13px] font-medium text-[#595959] transition-colors hover:text-[#0e0f11]"
      >
        <ArrowLeft className="h-4 w-4" /> All tables
      </button>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="truncate text-[20px] font-semibold text-[#0e0f11]">{table.name}</h3>
        <span className="shrink-0 rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[12px] font-medium text-[#595959]">
          ~{fmtCount(table.row_estimate)} rows · {table.columns.filter((column) =>
            !isProtectedConsoleColumnName(column.name) && !isHiddenConsoleDisplayColumnName(column.name)
          ).length} cols
        </span>
        <div className="flex-1" />
        <PillTabs
          value={view}
          onChange={setView}
          options={[
            { id: "data", label: "Data" },
            { id: "schema", label: "Schema" },
          ]}
        />
      </div>

      {view === "schema" ? (
        <>
          <SchemaTable table={table} />
          <p className="mt-3 text-[12px] text-[#b0b0b0]">
            Live structure of your app database{dialect ? ` (${dialect})` : ""}.
          </p>
        </>
      ) : (
        <RowsBrowser table={table} canWrite={canWrite} />
      )}
    </>
  );
}

export function RowsBrowser({ table, canWrite }: { table: CatalogTable; canWrite: boolean }) {
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [data, setData] = useState<Extract<AppRows, { supported: true }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; rowIndex?: number } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  useEffect(() => {
    setPage(0);
    setQ("");
  }, [table.name]);

  const fetchPage = useCallback(async (targetPage: number): Promise<
    | { kind: "ready"; data: Extract<AppRows, { supported: true }> }
    | { kind: "unsupported"; message: string }
    | { kind: "error" }
  > => {
    try {
      const res = await apiFetch(
        `/api/website/app-rows?table=${encodeURIComponent(table.name)}&limit=${ROWS_PAGE}&offset=${targetPage * ROWS_PAGE}`,
      );
      if (!res.ok) return { kind: "error" };
      const j = (await res.json()) as AppRows;
      if (j.connected === false) return { kind: "error" };
      if (j.supported === false) {
        return {
          kind: "unsupported",
          message: j.message ?? "Row browsing isn't supported for this database type yet.",
        };
      }
      return { kind: "ready", data: j };
    } catch {
      return { kind: "error" };
    }
  }, [table.name]);

  const applyResult = useCallback((result: Awaited<ReturnType<typeof fetchPage>>) => {
    if (result.kind === "error") {
      setPhase("error");
      return;
    }
    if (result.kind === "unsupported") {
      setNote(result.message);
      setPhase("unsupported");
      return;
    }
    setData(result.data);
    setPhase("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      const result = await fetchPage(page);
      if (cancelled) return;
      applyResult(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, applyResult, page, reloadNonce]);

  const mutate = useCallback(async (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
    const res = await apiFetch("/api/website/app-rows", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message ?? "The data change could not be saved.");
    }
  }, []);

  const refreshAfterMutation = useCallback(async () => {
    let target = page;
    for (;;) {
      const result = await fetchPage(target);
      if (result.kind !== "ready") {
        applyResult(result);
        return;
      }
      if (result.data.rows.length === 0 && target > 0) {
        target -= 1;
        continue;
      }
      applyResult(result);
      if (target !== page) setPage(target);
      else setReloadNonce((current) => current + 1);
      return;
    }
  }, [applyResult, fetchPage, page]);

  const deleteRow = useCallback(async (rowIndex: number) => {
    if (!data || !window.confirm("Delete this row? This cannot be undone.")) return;
    setDeleting(rowIndex);
    setMutationError(null);
    try {
      await mutate("DELETE", {
        table: table.name,
        key: data.row_keys[rowIndex],
        version: data.row_versions[rowIndex],
      });
      await refreshAfterMutation();
    } catch (error) {
      setMutationError((error as Error).message);
    } finally {
      setDeleting(null);
    }
  }, [data, mutate, refreshAfterMutation, table.name]);

  const colNames = useMemo(() => {
    const collect = (skipHidden: boolean) => {
      const names: string[] = [];
      const seen = new Set<string>();
      const take = (name: string) => {
        if (isProtectedConsoleColumnName(name) || seen.has(name)) return;
        if (skipHidden && isHiddenConsoleDisplayColumnName(name)) return;
        seen.add(name);
        names.push(name);
      };
      for (const c of data?.columns ?? []) take(c.name);
      for (const r of data?.rows ?? []) for (const k of Object.keys(r)) take(k);
      return names;
    };
    const names = collect(true);
    return names.length > 0 ? names : collect(false);
  }, [data]);
  const visibleRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      !needle || Object.entries(row).some(([name, value]) =>
        !isProtectedConsoleColumnName(name) &&
        value != null && String(value).toLowerCase().includes(needle),
      ),
    );
  }, [data, q]);

  useEffect(() => {
    if (editor?.rowIndex != null && data && !data.row_keys[editor.rowIndex]) setEditor(null);
  }, [editor, data]);

  if (phase === "loading") return <RowsSkeleton />;
  if (phase === "unsupported") {
    return (
      <div className="rounded-xl border border-dashed border-[#e6e6e6] bg-[#fafafa] px-6 py-10 text-center text-[13px] leading-5 text-[#8c8c8c]">
        {note}
      </div>
    );
  }
  if (phase === "error" || !data) {
    return (
      <div className="rounded-xl border border-[#f0f0f0] bg-[#f9f9f9] px-6 py-8 text-center text-[13px] text-[#595959]">
        We couldn&rsquo;t load this table&rsquo;s rows. Try again in a moment.
      </div>
    );
  }

  const mutable = data.writable && canWrite;
  const from = data.rows.length === 0 ? 0 : page * ROWS_PAGE + 1;
  const to = page * ROWS_PAGE + data.rows.length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-[280px] max-w-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#71717a]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search this page…"
            aria-label="Search rows on this page"
            className="h-9 w-full rounded-full border border-[#e4e4e7] bg-white pl-9 pr-3 text-[13px] text-[#0e0f11] outline-none placeholder:text-[#71717a]"
          />
        </div>
        <div className="flex items-center gap-2">
        {mutable && (
          <button
            type="button"
            onClick={() => { setMutationError(null); setEditor({ mode: "create" }); }}
            className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#18181b] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#27272a]"
          >
            <Plus className="h-4 w-4" /> Add row
          </button>
        )}
        </div>
      </div>

      {mutationError && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {mutationError}
        </div>
      )}
      {!data.writable && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          This table has no primary key, so it is read-only in the console.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[#e4e4e7]">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[#f0f0f0] bg-[#f9f9f9] text-[12px] text-[#44485f]">
              {colNames.map((name) => (
                <th key={name} className="whitespace-nowrap px-4 py-2.5 font-semibold">
                  {name}
                </th>
              ))}
              {mutable && <th className="w-[92px] px-4 py-2.5 text-right font-semibold">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, colNames.length + (mutable ? 1 : 0))}
                  className="px-4 py-10 text-center text-[13px] text-[#8c8c8c]"
                >
                  {data.rows.length === 0 ? "No rows in this table." : "No rows match your search."}
                </td>
              </tr>
            ) : (
              visibleRows.map(({ row, index }) => (
                <tr key={JSON.stringify(data.row_keys[index])} className="border-b border-[#f4f4f4] last:border-b-0 hover:bg-[#fafafa]">
                  {colNames.map((name) => (
                    <RowCellTd key={name} value={row[name]} />
                  ))}
                  {mutable && (
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => { setMutationError(null); setEditor({ mode: "edit", rowIndex: index }); }}
                          aria-label="Edit row"
                          className="grid h-8 w-8 place-items-center rounded-cta text-[#595959] hover:bg-[#f0f0f0]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRow(index)}
                          disabled={deleting === index}
                          aria-label="Delete row"
                          className="grid h-8 w-8 place-items-center rounded-cta text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          {deleting === index ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-[12px] text-[#8c8c8c]">
        <span>
          {data.rows.length > 0 ? `Showing ${from}–${to}` : "No rows"}
          {q.trim() && data.rows.length > 0 ? ` · ${visibleRows.length} on this page match` : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="inline-flex h-8 items-center gap-1 rounded-cta border border-[#e4e4e7] bg-white px-2.5 font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={!data.has_more}
            className="inline-flex h-8 items-center gap-1 rounded-cta border border-[#e4e4e7] bg-white px-2.5 font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {editor && (
        <RowEditorDialog
          key={`${editor.mode}:${editor.rowIndex == null ? "new" : JSON.stringify(data.row_keys[editor.rowIndex])}`}
          table={table}
          mode={editor.mode}
          row={editor.rowIndex == null ? null : data.rows[editor.rowIndex]}
          rowKey={editor.rowIndex == null ? null : data.row_keys[editor.rowIndex]}
          version={editor.rowIndex == null ? null : data.row_versions[editor.rowIndex]}
          truncated={editor.rowIndex == null ? [] : data.truncated_columns?.[editor.rowIndex] ?? []}
          onClose={() => setEditor(null)}
          onSave={async (payload) => {
            try {
              await mutate(editor.mode === "create" ? "POST" : "PATCH", payload);
              setEditor(null);
              await refreshAfterMutation();
              return null;
            } catch (error) {
              return (error as Error).message;
            }
          }}
        />
      )}
    </>
  );
}

export function parseEditorValue(column: CatalogColumn, raw: string): unknown {
  if (raw === "" && column.nullable) return null;
  if (raw === "" && !column.has_default) throw new Error(`${column.name} is required.`);
  if (Array.isArray(column.enum_values) && column.enum_values.length > 0) return raw;
  if (/bool/i.test(column.type)) {
    if (raw !== "true" && raw !== "false") throw new Error(`${column.name} must be true or false.`);
    return raw === "true";
  }
  if (/bigint/i.test(column.type)) {
    if (!/^-?\d+$/.test(raw)) throw new Error(`${column.name} must be an integer.`);
    return raw;
  }
  if (/(numeric|decimal)/i.test(column.type)) {
    if (!Number.isFinite(Number(raw))) throw new Error(`${column.name} must be a number.`);
    return raw;
  }
  if (/(smallint|integer|real|double)/i.test(column.type)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${column.name} must be a number.`);
    return value;
  }
  if (/json/i.test(column.type)) {
    try { return JSON.parse(raw); } catch { throw new Error(`${column.name} must be valid JSON.`); }
  }
  return raw;
}

export function entityLabel(tableName: string): string {
  const words = tableName.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return tableName;
  const last = words[words.length - 1];
  words[words.length - 1] = /ies$/i.test(last) && last.length > 3
    ? `${last.slice(0, -3)}y`
    : /(s|x|z|ch|sh)es$/i.test(last)
      ? last.slice(0, -2)
      : /(ss|us|is)$/i.test(last) || !/s$/i.test(last)
        ? last
        : last.slice(0, -1);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function RowEditorDialog({
  table,
  mode,
  row,
  rowKey,
  version,
  truncated = [],
  onClose,
  onSave,
}: {
  table: CatalogTable;
  mode: "create" | "edit";
  row: Record<string, RowCell> | null;
  rowKey: Record<string, RowCell> | null;
  version: string | null;
  truncated?: string[];
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<string | null>;
}) {
  const truncatedSet = useMemo(() => new Set(truncated), [truncated]);
  const isTruncated = (name: string) => mode === "edit" && truncatedSet.has(name);

  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const columns = table.columns.filter((column) =>
    !isProtectedConsoleColumnName(column.name) && column.writable !== false && !column.generated &&
    (mode === "create" ? !(column.primary_key && column.has_default) : !column.primary_key),
  );
  const title = `${mode === "create" ? "Add New" : "Edit"} ${entityLabel(table.name)}`;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((column) => [column.name, row?.[column.name] == null ? "" : String(row[column.name])])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const changes: Record<string, unknown> = {};
    try {
      for (const column of columns) {
        if (isTruncated(column.name)) continue;
        const raw = values[column.name] ?? "";
        const original = row?.[column.name] == null ? "" : String(row[column.name]);
        if (mode === "edit" && raw === original) continue;
        if (mode === "create" && raw === "" && (column.has_default || column.generated)) continue;
        changes[column.name] = parseEditorValue(column, raw);
      }
      if (mode === "edit" && Object.keys(changes).length === 0) {
        setError("Change at least one field before saving.");
        return;
      }
    } catch (parseError) {
      setError((parseError as Error).message);
      return;
    }
    setSaving(true);
    const payload = mode === "create"
      ? { table: table.name, values: changes }
      : { table: table.name, key: rowKey, version, values: changes };
    const saveError = await onSave(payload);
    setSaving(false);
    if (saveError) setError(saveError);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex justify-end bg-black/35">
      <button type="button" aria-hidden="true" tabIndex={-1} onClick={onClose} className="flex-1 cursor-default" />
      <div ref={panelRef} className="flex h-full w-full max-w-[420px] flex-col border-l border-[#e4e4e7] bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#f0f0f0] px-4 py-4">
          <div>
            <h4 className="text-[16px] font-semibold text-[#09090b]">{title}</h4>
            <p className="text-[12px] text-[#8c8c8c]">{table.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-cta hover:bg-[#f4f4f4]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {columns.map((column) => {
            const required = column.nullable === false && !column.has_default;
            const options = Array.isArray(column.enum_values) ? column.enum_values : null;
            const shortened = isTruncated(column.name);
            return (
              <label key={column.name} className="block">
                <span className="mb-1 flex items-center gap-1 text-[14px] font-medium text-[#454545]">
                  {column.name}
                  {required && <span className="text-red-600" aria-hidden="true">*</span>}
                  <span className="font-normal text-[#a1a1aa]">· {column.type}</span>
                </span>
                {shortened ? (
                  <>
                    <textarea
                      value={values[column.name] ?? ""}
                      readOnly
                      rows={3}
                      aria-label={column.name}
                      className="w-full resize-none rounded-lg border border-[#e4e4e7] bg-[#f9f9f9] px-3 py-2 text-[13px] text-[#8c8c8c] outline-none"
                    />
                    <span className="mt-1 block text-[12px] text-amber-700">
                      This value is too long to edit here. It was shortened for display, so saving it
                      would delete the rest. Other fields on this row still save normally.
                    </span>
                  </>
                ) : options && options.length > 0 ? (
                  <select
                    value={values[column.name] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [column.name]: event.target.value }))}
                    aria-label={column.name}
                    className="h-10 w-full rounded-lg border border-[#e4e4e7] bg-white px-3 text-[13px] text-[#0e0f11] outline-none focus:border-[#a1a1aa]"
                  >
                    <option value="">{column.nullable ? "null (leave empty)" : column.has_default ? "default (leave empty)" : "Select…"}</option>
                    {options.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={values[column.name] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [column.name]: event.target.value }))}
                    placeholder={column.nullable ? "null (leave empty)" : column.has_default ? "default (leave empty)" : "Required"}
                    aria-label={column.name}
                    className="h-10 w-full rounded-lg border border-[#e4e4e7] px-3 text-[13px] outline-none focus:border-[#a1a1aa]"
                  />
                )}
              </label>
            );
          })}
          {columns.length === 0 && <p className="text-[13px] text-[#8c8c8c]">This row has no editable columns.</p>}
          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#f0f0f0] bg-white px-4 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-cta border border-[#e4e4e7] px-3 text-[13px] font-medium">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={saving || columns.length === 0} className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#18181b] px-3 text-[13px] font-medium text-white disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

function RowCellTd({ value }: { value: RowCell }) {
  if (value === null || value === undefined) {
    return <td className="px-4 py-2.5 text-[13px] text-[#c4c4c4]">-</td>;
  }
  const text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return (
    <td className="max-w-[280px] truncate px-4 py-2.5 text-[13px] text-[#0e0f11]" title={text}>
      {text}
    </td>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading rows" className="space-y-2">
      <Skeleton className="h-9 w-[280px] max-w-full" rounded="rounded-lg" />
      <div aria-hidden className="overflow-hidden rounded-xl border border-[#f0f0f0]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex h-10 items-center border-b border-[#f0f0f0] px-4 last:border-b-0">
            <Skeleton className="h-3 w-full max-w-[420px]" delayMs={i * 80} />
          </div>
        ))}
      </div>
    </div>
  );
}

const USERS_PAGE = 100;

const PRIVILEGED_ROLE_NAMES = /^(admin|administrator|owner|superuser|root|staff)$/i;

function pickColumn(available: string[], candidates: string[]): string | null {
  const lower = new Map(available.map((n) => [n.toLowerCase(), n]));
  for (const c of candidates) {
    const hit = lower.get(c);
    if (hit) return hit;
  }
  return null;
}

const PILL_SLIDE = "380ms cubic-bezier(0.32,0.72,0,1)";

export function PillTabs<T extends string>({
  value,
  onChange,
  options,
  className = "",
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ id: T; label: string }>;
  className?: string;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  useLayoutEffect(() => {
    const el = refs.current[value];
    if (!el) return;
    const measure = () => {
      const next = { left: el.offsetLeft, width: el.offsetWidth };
      setBox((prev) =>
        next.width === 0 ? null : prev && prev.left === next.left && prev.width === next.width ? prev : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [value]);
  const measured = box !== null;
  useEffect(() => {
    if (!measured || animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [measured, animate]);
  return (
    <div
      role="tablist"
      className={`relative inline-flex h-9 items-center gap-1 rounded-full bg-[#f0f0f0] p-[3px] ${className}`}
    >
      {box && (
        <span
          aria-hidden
          data-testid="pill-indicator"
          className="pointer-events-none absolute left-0 top-[3px] h-[30px] rounded-full bg-white shadow-[0px_1px_1.5px_rgba(0,0,0,0.1)] motion-reduce:!transition-none"
          style={{
            width: box.width,
            transform: `translateX(${box.left}px)`,
            transition: animate ? `transform ${PILL_SLIDE}, width ${PILL_SLIDE}` : "none",
          }}
        />
      )}
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[option.id] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.id)}
            className={`relative z-10 flex h-[30px] items-center rounded-full px-3 text-[16px] transition-colors duration-200 ${
              active
                ? `font-medium text-[#0e0f11] ${box ? "" : "bg-white shadow-[0px_1px_1.5px_rgba(0,0,0,0.1)]"}`
                : "text-[#8c8c8c] hover:text-[#0e0f11]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function UsersView({
  deployedUrl,
  inviteRequested = false,
  onInviteRequestHandled,
}: {
  deployedUrl: string | null;
  inviteRequested?: boolean;
  onInviteRequestHandled?: () => void;
}) {
  const { role } = useWorkspace();
  const canReadUsers = role === "owner" || role === "admin";

  const { phase, catalog } = useAppCatalog();
  const [tab, setTab] = useState<"users" | "pending">("users");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [inviteDialogRole, setInviteDialogRole] = useState<InviteRole | null>(null);

  const usersTable = useMemo(
    () => (catalog?.connected ? findUsersTable(catalog.tables ?? []) : null),
    [catalog],
  );

  const [rows, setRows] = useState<Extract<AppRows, { supported: true }> | null>(null);
  const [rowsPhase, setRowsPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const [reloadNonce, setReloadNonce] = useState(0);
  const [pending, setPending] = useState<{ id: string; role?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    destructive?: boolean;
    run: () => Promise<void> | void;
  } | null>(null);

  const tableName = usersTable?.name ?? null;
  useEffect(() => {
    if (!canReadUsers || !tableName) {
      setRows(null);
      setRowsPhase("idle");
      return;
    }
    let cancelled = false;
    setRowsPhase("loading");
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/website/app-rows?table=${encodeURIComponent(tableName)}&limit=${USERS_PAGE}&offset=0`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setRowsPhase("error");
          return;
        }
        const j = (await res.json()) as AppRows;
        if (cancelled) return;
        if (j.connected === false || j.supported === false) {
          setRowsPhase("error");
          return;
        }
        setRows(j);
        setRowsPhase("ready");
      } catch {
        if (!cancelled) setRowsPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canReadUsers, tableName, reloadNonce]);

  const maskedSet = useMemo(
    () => new Set((rows?.masked_columns ?? []).map((c) => c.toLowerCase())),
    [rows],
  );
  const visibleCols = useMemo(
    () => (rows?.columns ?? []).filter((c) =>
      !maskedSet.has(c.name.toLowerCase()) && !isProtectedConsoleColumnName(c.name),
    ),
    [rows, maskedSet],
  );
  const visibleColNames = useMemo(() => visibleCols.map((c) => c.name), [visibleCols]);

  const nameCol = pickColumn(visibleColNames, NAME_KEYS);
  const emailCol = pickColumn(visibleColNames, EMAIL_KEYS);
  const roleCol = pickColumn(visibleColNames, ROLE_KEYS);
  const extraCols = visibleColNames.filter(
    (n) => n !== nameCol && n !== emailCol && n !== roleCol,
  );

  const [invites, setInvites] = useState<AppInvite[]>([]);
  const [invitesState, setInvitesState] = useState<
    "idle" | "ready" | "roles_not_configured" | "no_signup" | "error"
  >("idle");
  const [invitesNonce, setInvitesNonce] = useState(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const hasRoleCol = !!roleCol;
  useEffect(() => {
    if (!canReadUsers || !tableName || !hasRoleCol) {
      setInvites([]);
      setInvitesState("idle");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/website/app-invites");
        const payload = (await res.json().catch(() => null)) as
          | { connected?: boolean; invites?: AppInvite[]; signup_available?: boolean | null; error?: { code?: string } }
          | null;
        if (cancelled) return;
        if (res.status === 409 && payload?.error?.code === "roles_not_configured") {
          setInvites([]);
          setInvitesState("roles_not_configured");
          return;
        }
        if (!res.ok || payload?.connected !== true) {
          setInvites([]);
          setInvitesState("error");
          return;
        }
        setInvites(Array.isArray(payload.invites) ? payload.invites : []);
        setInvitesState(payload.signup_available === false ? "no_signup" : "ready");
      } catch {
        if (!cancelled) {
          setInvites([]);
          setInvitesState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canReadUsers, tableName, hasRoleCol, invitesNonce]);

  const rolesConfigured = hasRoleCol && invitesState !== "roles_not_configured";
  const canInvite =
    canReadUsers && !!usersTable && rowsPhase !== "error" && !!rows && rolesConfigured && invitesState !== "no_signup";
  useEffect(() => {
    if (!inviteRequested || !canInvite) return;
    setInviteDialogRole("user");
    onInviteRequestHandled?.();
  }, [inviteRequested, canInvite, onInviteRequestHandled]);

  const roleOptions = useMemo(() => {
    if (!roleCol || !rows) return [];
    const declared = (rows.columns ?? []).find((c) => c.name === roleCol)?.enum_values;
    if (Array.isArray(declared) && declared.length > 0) return declared;
    const seen = new Set<string>();
    for (const r of rows.rows) {
      const v = r[roleCol];
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s) seen.add(s);
      if (seen.size >= 20) break;
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [rows, roleCol]);

  const roleFilterOptions = useMemo(() => {
    if (!roleFilter || roleOptions.includes(roleFilter)) return roleOptions;
    return [...roleOptions, roleFilter].sort((a, b) => a.localeCompare(b));
  }, [roleOptions, roleFilter]);

  const searchable = visibleColNames.length > 0;

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    return rows.rows
      .map((row, origIndex) => ({ row, origIndex }))
      .filter(({ row: r }) => {
        if (roleCol && roleFilter && String(r[roleCol] ?? "") !== roleFilter) return false;
        if (!needle) return true;
        return visibleColNames.some((n) => String(r[n] ?? "").toLowerCase().includes(needle));
      });
  }, [rows, q, roleFilter, roleCol, visibleColNames]);

  const roleColMeta = useMemo(
    () => (roleCol ? (rows?.columns ?? []).find((c) => c.name === roleCol) ?? null : null),
    [rows, roleCol],
  );

  const roleColIsEnum = Array.isArray(roleColMeta?.enum_values)
    && (roleColMeta?.enum_values?.length ?? 0) > 0;
  const roleTypeIsWritable = roleColIsEnum
    || /^(text|character varying|character|varchar|char|citext|name)$/i
      .test((roleColMeta?.type ?? "").trim());

  const canEditRole =
    canReadUsers &&
    rows?.writable === true &&
    !!roleCol &&
    !!roleColMeta &&
    roleColMeta.writable === true &&
    roleColMeta.primary_key !== true &&
    roleColMeta.generated !== true &&
    !isProtectedConsoleColumnName(roleCol) &&
    roleTypeIsWritable;

  const canDeleteUser = canReadUsers && rows?.writable === true;

  const noAdminYet =
    canInvite &&
    rowsPhase === "ready" &&
    !!roleCol &&
    !!rows &&
    rows.rows.length > 0 &&
    rows.has_more === false &&
    roleOptions.includes("admin") &&
    !rows.rows.some((r) => String(r[roleCol] ?? "") === "admin");

  const reloading = rowsPhase === "loading" && !!rows;

  const mutate = useCallback(
    async (method: "PATCH" | "DELETE", body: Record<string, unknown>) => {
      const res = await apiFetch("/api/website/app-rows", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true as const };
      const payload = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      return {
        ok: false as const,
        status: res.status as number | undefined,
        code: payload?.error?.code,
        message: payload?.error?.message ?? "That change could not be saved.",
      };
    },
    [],
  );

  const runRoleChange = useCallback(
    async (origIndex: number, next: string) => {
      if (!rows || !roleCol || !tableName) return;
      const key = rows.row_keys?.[origIndex];
      const version = rows.row_versions?.[origIndex];
      if (!key || !version) return;

      setPending({ id: JSON.stringify(key), role: next });
      setNotice(null);
      try {
        const result = await mutate("PATCH", {
          table: tableName,
          key,
          version,
          values: { [roleCol]: next },
        });
        if (result.ok) {
          if (roleFilter && roleFilter !== next) {
            setNotice(`Changed to "${next}", which no longer matches the "${roleFilter}" filter.`);
          }
          setReloadNonce((n) => n + 1);
          return;
        }
        setNotice(result.message);
        if (result.status === 409) setReloadNonce((n) => n + 1);
      } catch {
        setNotice("That change could not be saved. Check your connection and try again.");
      } finally {
        setPending(null);
      }
    },
    [rows, roleCol, tableName, roleFilter, mutate],
  );

  const changeRole = useCallback(
    (origIndex: number, next: string) => {
      if (!rows || !roleCol) return;
      const current = String(rows.rows[origIndex]?.[roleCol] ?? "");
      if (next === current) return;

      if (!PRIVILEGED_ROLE_NAMES.test(next.trim())) {
        void runRoleChange(origIndex, next);
        return;
      }
      setConfirming({
        title: `Give this user the “${next}” role?`,
        body: `They'll get whatever elevated access your app grants the “${next}” role in the live app. You can change it back at any time.`,
        confirmLabel: `Set as ${next}`,
        run: () => runRoleChange(origIndex, next),
      });
    },
    [rows, roleCol, runRoleChange],
  );

  const runRemoveUser = useCallback(
    async (origIndex: number) => {
      if (!rows || !tableName) return;
      const key = rows.row_keys?.[origIndex];
      const version = rows.row_versions?.[origIndex];
      if (!key || !version) return;
      setPending({ id: JSON.stringify(key) });
      setNotice(null);
      try {
        const result = await mutate("DELETE", { table: tableName, key, version });
        if (result.ok) {
          setReloadNonce((n) => n + 1);
          return;
        }
        setNotice(
          result.status === 409
            ? "That user changed or was already removed. Reloading the list."
            : result.message,
        );
        if (result.status === 409) setReloadNonce((n) => n + 1);
      } catch {
        setNotice("That user could not be removed. Check your connection and try again.");
      } finally {
        setPending(null);
      }
    },
    [rows, tableName, mutate],
  );

  const removeUser = useCallback(
    (origIndex: number) => {
      if (!rows) return;
      const who = nameCol ? String(rows.rows[origIndex]?.[nameCol] ?? "").trim() : "";
      const email = emailCol ? String(rows.rows[origIndex]?.[emailCol] ?? "").trim() : "";
      setConfirming({
        title: "Remove this user?",
        body: `${who || email || "This user"} will be deleted from your app's database. This is permanent. There is no undo and no restore window.`,
        confirmLabel: "Remove user",
        destructive: true,
        run: () => runRemoveUser(origIndex),
      });
    },
    [rows, nameCol, emailCol, runRemoveUser],
  );

  const runRevokeInvite = useCallback(async (id: string) => {
    setRevokingId(id);
    setNotice(null);
    try {
      const res = await apiFetch(`/api/website/app-invites/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
      });
      if (res.ok) {
        setInvites((prev) => prev.filter((i) => i.id !== id));
      } else if (res.status === 404) {
        setNotice("That invite link was already used, revoked or expired.");
      } else {
        const payload = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setNotice(payload?.error?.message ?? "That invite link could not be revoked. Try again shortly.");
      }
    } catch {
      setNotice("That invite link could not be revoked. Check your connection and try again.");
    } finally {
      setRevokingId(null);
      setInvitesNonce((n) => n + 1);
    }
  }, []);

  const revokeInvite = useCallback(
    (invite: AppInvite) => {
      setConfirming({
        title: "Revoke this invite link?",
        body:
          invite.role === "admin"
            ? "This admin link stops working right away. Nobody can use it to join or become an admin."
            : "This link stops working right away. Nobody can use it to create an account.",
        confirmLabel: "Revoke link",
        destructive: true,
        run: () => runRevokeInvite(invite.id),
      });
    },
    [runRevokeInvite],
  );

  if (phase === "loading") return <ViewSkeleton />;
  if (phase === "error" || !catalog?.connected)
    return (
      <ConnectDbState icon={Users} reason={catalog?.reason} error={catalog?.discovery_error} />
    );

  const countLabel =
    rowsPhase === "ready" && rows ? (rows.has_more ? `${USERS_PAGE}+` : `${rows.rows.length}`) : null;

  return (
    <div className="mx-auto max-w-[900px] p-6">
      {}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">
            Users{countLabel ? ` (${countLabel})` : ""}
          </h2>
          <p className="mt-0.5 text-[13px] text-[#8c8c8c]">
            Manage the app&rsquo;s users and their roles
          </p>
        </div>
        {canReadUsers && (
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip label="User schema">
              <button
                type="button"
                onClick={() => setSchemaOpen(true)}
                aria-label="View user schema"
                className="grid h-10 w-10 place-items-center rounded-cta border border-[#f0f0f0] bg-white text-[#595959] transition-colors hover:bg-[#f9f9f9]"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
            </Tooltip>
            {canInvite && (
              <button
                type="button"
                onClick={() => setInviteDialogRole("user")}
                className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#0e0f11] px-3 text-[16px] font-medium text-white transition-opacity hover:opacity-90"
              >
                <UserPlus className="h-4 w-4" /> Invite User
              </button>
            )}
          </div>
        )}
      </div>

      {}
      <PillTabs
        className="mt-4"
        value={tab}
        onChange={setTab}
        options={[
          { id: "users", label: "Users" },
          { id: "pending", label: "Pending requests" },
        ]}
      />

      {}
      <div className="mt-4 overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0f0f0] px-4 py-3">
          <span className="text-[14px] font-semibold text-[#0e0f11]">
            {tab === "users" ? "Users" : "Pending requests"}
          </span>
          {tab === "users" && canReadUsers && rowsPhase === "ready" && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8c8c8c]" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  disabled={!searchable}
                  placeholder={
                    nameCol || emailCol ? "Search by Email or Name" : "Search users"
                  }
                  aria-label="Search users"
                  className="h-9 w-[240px] max-w-full rounded-lg border border-[#f0f0f0] bg-white pl-9 pr-3 text-[13px] text-[#0e0f11] outline-none transition-colors focus:border-[#d4d4d4] placeholder:text-[#8c8c8c] disabled:bg-[#fafafa] disabled:text-[#8c8c8c]"
                />
              </div>
              {roleCol && roleFilterOptions.length > 0 && (
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  aria-label="Filter by role"
                  className="h-9 shrink-0 rounded-lg border border-[#f0f0f0] bg-white px-2.5 text-[13px] font-medium text-[#0e0f11] outline-none transition-colors hover:bg-[#f9f9f9]"
                >
                  <option value="">all roles</option>
                  {roleFilterOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {tab === "pending" ? (
          <div className="px-4 py-12 text-center">
            <p className="text-[13px] font-medium text-[#454545]">
              Access requests aren&rsquo;t available yet
            </p>
            <p className="mx-auto mt-1 max-w-[400px] text-[13px] leading-5 text-[#8c8c8c]">
              When your app supports requesting access, pending requests will show up here for
              you to approve.
            </p>
          </div>
        ) : !canReadUsers ? (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[#f0f0f0] text-[#8c8c8c]">
              <Lock className="h-5 w-5" />
            </div>
            <p className="text-[13px] font-medium text-[#454545]">
              Your app&rsquo;s user records are visible to owners and admins
            </p>
            <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-5 text-[#8c8c8c]">
              These are the people who signed up for your app, so access is limited. Ask an
              owner or admin if you need it.
            </p>
          </div>
        ) : !usersTable ? (
          <div className="px-4 py-12 text-center text-[13px] leading-5 text-[#8c8c8c]">
            This site doesn&rsquo;t have user accounts.
          </div>
        ) : (rowsPhase === "loading" || rowsPhase === "idle") && !rows ? (
          <div role="status" aria-busy="true" aria-label="Loading users" className="space-y-2 px-4 py-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" rounded="rounded-lg" delayMs={i * 80} />
            ))}
          </div>
        ) : rowsPhase === "error" ? (
          <div className="px-4 py-12 text-center text-[13px] leading-5 text-[#8c8c8c]">
            We couldn&rsquo;t read your users right now. This is usually temporary. Refresh to
            try again.
          </div>
        ) : (
          <>
            {!rolesConfigured && (
              <div
                role="note"
                className="border-b border-[#f0f0f0] bg-[#fafafa] px-4 py-2.5 text-[12px] leading-5 text-[#454545]"
              >
                Roles aren&rsquo;t set up on this site yet.
              </div>
            )}
            {noAdminYet && (
              <div
                role="note"
                data-testid="users-no-admin-note"
                className="flex flex-col gap-2 border-b border-[#f0f0f0] bg-[#fafafa] px-4 py-3 text-[12px] leading-5 text-[#454545] sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  <b>No one is an admin yet</b>, so your site&rsquo;s admin pages stay locked.{" "}
                  {canEditRole
                    ? "Change your role to admin below, or get an admin link."
                    : "Get an admin link and open it to get in."}
                </span>
                <button
                  type="button"
                  onClick={() => setInviteDialogRole("admin")}
                  className="inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-cta bg-[#0e0f11] px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 sm:self-auto"
                >
                  <UserPlus className="h-4 w-4" /> Get admin link
                </button>
              </div>
            )}
            <div
              className={`overflow-x-auto transition-opacity ${reloading ? "pointer-events-none opacity-60" : ""}`}
            >
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[#f0f0f0] bg-[#f9f9f9] text-[13px] text-[#595959]">
                    <th className="px-6 py-2.5 font-medium">Name</th>
                    {roleCol && <th className="px-6 py-2.5 font-medium">Role</th>}
                    {emailCol && <th className="px-6 py-2.5 font-medium">Email</th>}
                    {extraCols.map((c) => (
                      <th key={c} className="whitespace-nowrap px-6 py-2.5 font-medium">
                        {c}
                      </th>
                    ))}
                    {canDeleteUser && <th className="w-[64px] px-4 py-2.5 font-medium" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td
                        colSpan={
                          1 +
                          (roleCol ? 1 : 0) +
                          (emailCol ? 1 : 0) +
                          extraCols.length +
                          (canDeleteUser ? 1 : 0)
                        }
                        className="px-6 py-10 text-center text-[13px] leading-5 text-[#8c8c8c]"
                      >
                        {rows && rows.rows.length === 0 && canInvite ? (
                          <div className="flex flex-col items-center gap-3">
                            <span>
                              No users yet. Invite yourself as an admin to manage your site
                              from inside it.
                            </span>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => setInviteDialogRole("admin")}
                                className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#0e0f11] px-3 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                              >
                                <UserPlus className="h-4 w-4" /> Invite yourself as admin
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setReloadNonce((n) => n + 1);
                                  setInvitesNonce((n) => n + 1);
                                }}
                                className="inline-flex h-10 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#454545] transition-colors hover:bg-[#f9f9f9]"
                              >
                                <RefreshCw className="h-4 w-4" /> Refresh
                              </button>
                            </div>
                          </div>
                        ) : rows && rows.rows.length === 0 && invitesState === "no_signup" ? (
                          NO_SIGNUP_COPY
                        ) : rows && rows.rows.length === 0 ? (
                          "No users yet. They'll appear here as people sign up for your app."
                        ) : (
                          "No users match your search."
                        )}
                      </td>
                    </tr>
                  ) : (
                    filtered.map(({ row: r, origIndex }) => {
                      const rowKey = rows?.row_keys?.[origIndex];
                      const rowId = rowKey ? JSON.stringify(rowKey) : `idx:${origIndex}`;
                      const busy = pending?.id === rowId || reloading;
                      const currentRole = roleCol ? String(r[roleCol] ?? "") : "";
                      const options = roleOptions.includes(currentRole) || !currentRole
                        ? roleOptions
                        : [...roleOptions, currentRole].sort((a, b) => a.localeCompare(b));
                      const editableHere =
                        canEditRole && !!rowKey && !!rows?.row_versions?.[origIndex] && options.length > 1;
                      return (
                        <tr
                          key={rowId}
                          className="border-b border-[#f4f4f4] last:border-b-0 hover:bg-[#fafafa]"
                        >
                          <td className="max-w-[220px] truncate px-6 py-3 text-[13px] text-[#0e0f11]">
                            {nameCol ? (String(r[nameCol] ?? "") || "-") : "-"}
                          </td>
                          {roleCol &&
                            (editableHere ? (
                              <td className="px-4 py-2.5 text-[13px] text-[#0e0f11]">
                                <select
                                  value={busy && pending?.role ? pending.role : currentRole}
                                  disabled={busy}
                                  onChange={(e) => void changeRole(origIndex, e.target.value)}
                                  aria-label={`Role for ${nameCol ? String(r[nameCol] ?? "this user") : "this user"}`}
                                  className="h-8 max-w-[160px] rounded-lg border border-[#f0f0f0] bg-white px-2 text-[13px] text-[#0e0f11] outline-none transition-colors hover:bg-[#f9f9f9] focus:border-[#d4d4d4] disabled:bg-[#fafafa] disabled:text-[#8c8c8c]"
                                >
                                  {options.map((o) => (
                                    <option key={o} value={o}>
                                      {o}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : (
                              <RowCellTd value={r[roleCol] ?? null} />
                            ))}
                          {emailCol && <RowCellTd value={r[emailCol] ?? null} />}
                          {extraCols.map((c) => (
                            <RowCellTd key={c} value={r[c] ?? null} />
                          ))}
                          {canDeleteUser && (
                            <td className="px-4 py-2.5 text-right">
                              {rowKey && rows?.row_versions?.[origIndex] && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void removeUser(origIndex)}
                                  aria-label={`Remove ${nameCol ? String(r[nameCol] ?? "this user") : "this user"}`}
                                  className="grid h-8 w-8 place-items-center rounded-cta text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                                >
                                  {busy ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {notice && (
              <div
                role="status"
                className="border-t border-[#f0f0f0] bg-[#fafafa] px-4 py-2.5 text-[12px] leading-5 text-[#454545]"
              >
                {notice}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#f0f0f0] px-4 py-2.5 text-[12px] text-[#8c8c8c]">
              <span>
                {rows?.has_more
                  ? `Showing the first ${USERS_PAGE} users. Search covers these`
                  : `${filtered.length} of ${rows?.rows.length ?? 0}`}
              </span>
            </div>
          </>
        )}
      </div>

      {tab === "users" && canReadUsers && rolesConfigured && invites.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
          <div className="border-b border-[#f0f0f0] px-4 py-3">
            <span className="text-[14px] font-semibold text-[#0e0f11]">Pending invites</span>
            <p className="mt-0.5 text-[12px] leading-5 text-[#8c8c8c]">
              Links that haven&rsquo;t been used yet. Revoke one to stop it working.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#f0f0f0] bg-[#f9f9f9] text-[13px] text-[#595959]">
                  <th className="px-6 py-2.5 font-medium">Role</th>
                  <th className="px-6 py-2.5 font-medium">Created</th>
                  <th className="px-6 py-2.5 font-medium">Expires</th>
                  <th className="w-[120px] px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr
                    key={invite.id}
                    data-testid="pending-invite"
                    className="border-b border-[#f4f4f4] last:border-b-0 hover:bg-[#fafafa]"
                  >
                    <td className="px-6 py-3 text-[13px] text-[#0e0f11]">
                      {INVITE_ROLE_LABEL[invite.role] ?? invite.role}
                    </td>
                    <td className="px-6 py-3 text-[13px] text-[#454545]">
                      {fmtInviteDate(invite.created_at)}
                    </td>
                    <td className="px-6 py-3 text-[13px] text-[#454545]">
                      {fmtInviteDate(invite.expires_at)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={revokingId !== null}
                        onClick={() => revokeInvite(invite)}
                        aria-label={`Revoke ${INVITE_ROLE_LABEL[invite.role] ?? invite.role} invite`}
                        className="inline-flex h-8 items-center gap-2 rounded-cta px-2.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                      >
                        {revokingId === invite.id && <Loader2 className="h-4 w-4 animate-spin" />}
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {schemaOpen && usersTable && (
        <UserSchemaPanel
          table={usersTable}
          roleColumn={roleCol}
          roleOptions={roleOptions}
          onClose={() => setSchemaOpen(false)}
        />
      )}
      {inviteDialogRole && (
        <InviteLinkModal
          initialRole={inviteDialogRole}
          deployed={!!deployedUrl}
          onCreated={() => setInvitesNonce((n) => n + 1)}
          onClose={() => setInviteDialogRole(null)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          {...confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const action = confirming.run;
            setConfirming(null);
            void action();
          }}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-2xl bg-white p-4 shadow-[0_16px_48px_-12px_rgba(16,24,40,0.28)]"
      >
        <h3 className="text-[16px] font-semibold text-[#0e0f11]">{title}</h3>
        <p className="mt-2 text-[13px] leading-5 text-[#595959]">{body}</p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#454545] transition-colors hover:bg-[#f9f9f9]"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`inline-flex h-10 items-center rounded-cta px-3 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 ${
              destructive ? "bg-[#b42318]" : "bg-[#0e0f11]"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserSchemaPanel({
  table,
  roleColumn,
  roleOptions,
  onClose,
}: {
  table: CatalogTable;
  roleColumn: string | null;
  roleOptions: string[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div
        role="dialog"
        aria-label="User schema"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-[420px] max-w-[92vw] overflow-y-auto bg-white p-6 shadow-[-8px_0_24px_-8px_rgba(16,24,40,0.18)]"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[16px] font-semibold text-[#0e0f11]">User schema</h3>
            <p className="mt-0.5 text-[12px] text-[#8c8c8c]">
              Read-only: the fields on <code className="text-[#454545]">{table.name}</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close user schema"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-cta border border-[#f0f0f0] text-[#595959] transition-colors hover:bg-[#f9f9f9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {table.columns.filter((column) =>
            !isProtectedConsoleColumnName(column.name) && !isHiddenConsoleDisplayColumnName(column.name)
          ).map((c) => {
            return (
              <div key={c.name} className="border-l-2 border-[#f0f0f0] pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-[#0e0f11]">{c.name}</span>
                  <span className="text-[12px] text-[#8c8c8c]">({c.type}</span>
                  {}
                  {c.nullable === false && (
                    <span className="text-[12px] text-[#8c8c8c]">, required</span>
                  )}
                  <span className="text-[12px] text-[#8c8c8c]">)</span>
                </div>
                {c.name === roleColumn && roleOptions.length > 0 && (
                  <p className="mt-0.5 text-[12px] text-[#8c8c8c]">
                    Values seen: {roleOptions.join(", ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type InviteRole = "user" | "admin";
type AppInvite = { id: string; role: InviteRole; created_at: string; expires_at: string };

const INVITE_ROLE_LABEL: Record<string, string> = { user: "User", admin: "Admin" };
const NO_SIGNUP_COPY = "Your site has no sign-up page yet, so an invite link would open a 404. Ask Zavi to add sign-in to your site first.";

const INVITE_ERROR_COPY: Record<string, string> = {
  invalid_body: "Pick User or Admin, then try again.",
  forbidden: "Only workspace owners and admins can create invite links.",
  roles_not_configured: "Roles aren't set up on this site yet.",
  invalid_email: "Enter a valid email address.",
  invite_email_failed: "We couldn't send the invite email. Try again, or create a link instead.",
  invite_email_unavailable: "We couldn't verify the email limit right now. Try again shortly, or create a link instead.",
  invite_activation_failed: "The invite email was sent, but its link could not be activated, so it will not work. Create a link instead and share it directly.",
  site_not_deployed: "Publish the site before creating invite links.",
  site_has_no_signup: NO_SIGNUP_COPY,
  app_db_not_ready: "Your site's database is still being set up. Try again in a few minutes.",
  unavailable: "We couldn't create an invite link right now. Try again shortly.",
};
const INVITE_ERROR_FALLBACK = INVITE_ERROR_COPY.unavailable;

function fmtInviteDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function InviteLinkModal({
  initialRole,
  deployed,
  onCreated,
  onClose,
}: {
  initialRole: InviteRole;
  deployed: boolean;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<InviteRole>(initialRole);
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState<"email" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    url: string;
    expiresAt: string;
    role: InviteRole;
    emailedTo: string | null;
  } | null>(null);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async (mode: "email" | "link") => {
    if (creating) return;
    if (mode === "email" && !emailValid) {
      setError(INVITE_ERROR_COPY.invalid_email);
      return;
    }
    setCreating(mode);
    setError(null);
    setCreated(null);
    setCopied(false);
    try {
      const res = await apiFetch("/api/website/app-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "email" ? { role, email: email.trim() } : { role }),
        idempotent: true,
      });
      const payload = (await res.json().catch(() => null)) as
        | {
            invite_url?: string;
            expires_at?: string;
            role?: InviteRole;
            emailed_to?: string;
            error?: { code?: string; message?: string };
          }
        | null;
      if (res.ok && payload?.invite_url && payload.expires_at) {
        setCreated({
          url: payload.invite_url,
          expiresAt: payload.expires_at,
          role: payload.role === "admin" || payload.role === "user" ? payload.role : role,
          emailedTo: mode === "email" ? (payload.emailed_to ?? email.trim()) : null,
        });
        if (mode === "email") setEmail("");
        onCreated();
        return;
      }
      const code = payload?.error?.code ?? (res.status === 403 ? "forbidden" : undefined);
      const mapped = code ? INVITE_ERROR_COPY[code] : undefined;
      const limiter = res.status === 429 ? payload?.error?.message : undefined;
      setError(mapped ?? limiter ?? INVITE_ERROR_FALLBACK);
    } catch {
      setError(
        mode === "email"
          ? "We couldn't send the invite. Check your connection and try again."
          : "We couldn't create an invite link. Check your connection and try again.",
      );
    } finally {
      setCreating(null);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Invite to your site"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] rounded-2xl bg-white p-4 shadow-[0_16px_48px_-12px_rgba(16,24,40,0.28)]"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[16px] font-semibold text-[#0e0f11]">Invite to your site</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close invite dialog"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-cta border border-[#f0f0f0] text-[#595959] transition-colors hover:bg-[#f9f9f9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 border-t border-[#f0f0f0] pt-4">
          <p className="text-[12px] leading-5 text-[#8c8c8c]">Role</p>
          <div role="radiogroup" aria-label="Invite role" className="mt-1 grid grid-cols-2 gap-2">
            {(["user", "admin"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={role === r}
                onClick={() => {
                  if (r === role) return;
                  setRole(r);
                  setCreated(null);
                  setError(null);
                }}
                className={`h-10 rounded-cta border px-3 text-[13px] font-medium transition-colors ${
                  role === r
                    ? "border-[#0e0f11] bg-white text-[#0e0f11]"
                    : "border-[#f0f0f0] bg-white text-[#8c8c8c] hover:bg-[#f9f9f9]"
                }`}
              >
                {INVITE_ROLE_LABEL[r]}
              </button>
            ))}
          </div>

          {!deployed ? (
            <p className="mt-3 text-[13px] leading-5 text-[#8c8c8c]">
              Publish the site before creating invite links.
            </p>
          ) : (
            <>
              <form
                className="mt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create("email");
                }}
              >
                <label htmlFor="invite-email" className="text-[14px] font-medium leading-5 text-[#8c8c8c]">
                  Email
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="invite-email"
                    type="email"
                    autoComplete="off"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                    placeholder="name@example.com"
                    disabled={creating !== null}
                    className="h-10 min-w-0 flex-1 rounded-lg border border-[#f0f0f0] bg-white px-3 text-[13px] text-[#0e0f11] outline-none transition-colors placeholder:text-[#8c8c8c] focus:border-[#d4d4d4] disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={creating !== null || !emailValid}
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {creating === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send invite
                  </button>
                </div>
              </form>
              <button
                type="button"
                onClick={() => void create("link")}
                disabled={creating !== null}
                className="mt-2 inline-flex h-10 w-full items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
              >
                {creating === "link" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Or create a link to share
              </button>
            </>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[13px] leading-5 text-[#b42318]">
              {error}
            </p>
          )}

          {created && (
            <div className="mt-4">
              {created.emailedTo && (
                <p role="status" className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[#0e9f6e]">
                  <Check className="h-4 w-4" /> Invite sent to {created.emailedTo}
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  data-replay-mask=""
                  value={created.url}
                  aria-label="Invite link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[#f0f0f0] bg-[#fafafa] px-3 text-[13px] text-[#454545] outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  aria-label={copied ? "Copied" : "Copy"}
                  title={copied ? "Copied" : "Copy"}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
                >
                  {copied ? <Check className="h-4 w-4 text-[#0e9f6e]" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                </button>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-[#8c8c8c]">
                Expires {fmtInviteDate(created.expiresAt)}. This link is shown once; closing this
                dialog hides it.
              </p>
              <p
                className={`mt-2 text-[13px] leading-5 ${
                  created.role === "admin" ? "font-medium text-[#b42318]" : "text-[#454545]"
                }`}
              >
                {created.role === "admin"
                  ? "Anyone with this link can become an admin of your site. Treat it like a password."
                  : "Anyone with this link can create an account."}
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

export function DataView({
  tableSignal,
  onOpenTableChange,
}: {
  tableSignal?: { name: string; nonce: number } | null;
  onOpenTableChange?: (name: string | null) => void;
} = {}) {
  const { role } = useWorkspace();
  const canReadData = role === "owner" || role === "admin";

  const { phase, catalog } = useAppCatalog();
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [az, setAz] = useState(false);

  useEffect(() => {
    if (tableSignal?.name) setSelected(tableSignal.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableSignal?.nonce]);

  useEffect(() => {
    onOpenTableChange?.(selected);
  }, [selected, onOpenTableChange]);
  useEffect(() => () => onOpenTableChange?.(null), [onOpenTableChange]);

  if (!canReadData) {
    return (
      <div className="mx-auto max-w-[900px] p-6">
        <div className="mb-5">
          <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">Data</h2>
          <p className="mt-0.5 text-[13px] text-[#8c8c8c]">
            View and manage the data stored in your app.
          </p>
        </div>
        <div className="rounded-2xl border border-[#f0f0f0] bg-white px-4 py-12 text-center">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[#f0f0f0] text-[#8c8c8c]">
            <Lock className="h-5 w-5" />
          </div>
          <p className="text-[13px] font-medium text-[#454545]">
            Your app&rsquo;s data is visible to owners and admins
          </p>
          <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-5 text-[#8c8c8c]">
            These tables hold the records people created in your app, so access is limited.
            Ask an owner or admin if you need it.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "loading") return <ViewSkeleton />;
  if (phase === "error" || !catalog?.connected)
    return (
      <ConnectDbState icon={Database} reason={catalog?.reason} error={catalog?.discovery_error} />
    );

  const catalogTables = catalog.tables ?? [];
  const usersTableName = findUsersTable(catalogTables)?.name;
  const tables = catalogTables.filter((table) => table.name !== usersTableName);
  const active = selected ? tables.find((t) => t.name === selected) ?? null : null;
  let list = q ? tables.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())) : [...tables];
  if (az) list = [...list].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-[900px] p-6">
      <div className="mb-5">
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">Data</h2>
        <p className="mt-0.5 text-[13px] text-[#8c8c8c]">
          View and manage the data stored in your app.
        </p>
      </div>

      {active ? (
        <TableDetail
          table={active}
          dialect={catalog.dialect ?? null}
          canWrite={catalog.can_write === true}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="relative w-[256px] max-w-full">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8c8c8c]" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tables..."
                aria-label="Search tables"
                className="h-9 w-full rounded-full border border-[#f0f0f0] bg-white pl-9 pr-3 text-[13px] text-[#0e0f11] outline-none transition-colors focus:border-[#d4d4d4] placeholder:text-[#8c8c8c]"
              />
            </div>
            <Tooltip label={az ? "Sorted A–Z" : "Sort A–Z"}>
              <button
                type="button"
                onClick={() => setAz((v) => !v)}
                aria-pressed={az}
                aria-label="Sort tables A to Z"
                className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-cta border px-3 text-[13px] font-medium transition-colors ${
                  az
                    ? "border-[#0e0f11] bg-[#0e0f11] text-white"
                    : "border-[#f0f0f0] bg-white text-[#0e0f11] hover:bg-[#f9f9f9]"
                }`}
              >
                <ArrowDownAZ className="h-4 w-4" /> A-Z
              </button>
            </Tooltip>
          </div>

          {list.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#e6e6e6] bg-[#fafafa] px-6 py-12 text-center text-[13px] text-[#8c8c8c]">
              {tables.length === 0
                ? "No tables in your app database yet."
                : "No tables match your search."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {list.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSelected(t.name)}
                  className="flex items-center gap-3.5 rounded-cta border border-[#f0f0f0] bg-white p-4 text-left transition-colors hover:border-[#e4e4e4] hover:bg-[#fafafa]"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#f4f4f4] text-[#595959]">
                    <Table2 className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-[#0e0f11]">
                      {t.name}
                    </span>
                    {}
                    <span className="block text-[12px] text-[#8c8c8c]">
                      {t.columns.length} column{t.columns.length === 1 ? "" : "s"}
                      {t.row_estimate != null ? ` · ~${fmtCount(t.row_estimate)} rows` : ""}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#c4c4c4]" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ViewSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="mx-auto max-w-[720px] p-6">
      <Skeleton className="h-6 w-40" />
      <div aria-hidden className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" rounded="rounded-lg" delayMs={i * 80} />
        ))}
      </div>
    </div>
  );
}

export function DomainsView({
  deployedUrl,
  onDeployedUrlChanged,
}: {
  deployedUrl: string | null;
  onDeployedUrlChanged?: () => void;
}) {
  const [customDomainCount, setCustomDomainCount] = useState<number | null>(null);
  return (
    <div className="mx-auto max-w-[720px] p-6">
      <div className="mb-5">
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">Domains</h2>
        <p className="mt-0.5 text-[13px] text-[#8c8c8c]">
          Manage the addresses your app is reachable at.
        </p>
      </div>

      <BuiltinUrlCard
        deployedUrl={deployedUrl}
        onDeployedUrlChanged={onDeployedUrlChanged}
        customDomainCount={customDomainCount}
      />

      {}
      <h3 className="mb-3 mt-6 text-[14px] font-semibold text-[#0e0f11]">Custom domains</h3>
      <CustomDomainsCard onCountChange={setCustomDomainCount} />
    </div>
  );
}

type BuiltinUrl = { label: string; hostname: string; url: string; status: string; setup_blocked?: "dns_not_configured" | null };

function BuiltinUrlCard({
  deployedUrl,
  onDeployedUrlChanged,
  customDomainCount = null,
}: {
  customDomainCount?: number | null;
  deployedUrl: string | null;
  onDeployedUrlChanged?: () => void;
}) {
  const [builtin, setBuiltin] = useState<BuiltinUrl | null>(null);
  const [baseDomain, setBaseDomain] = useState("zaviagent.com");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lockedFromServer, setLocked] = useState(false);
  const locked = customDomainCount !== null ? customDomainCount > 0 : lockedFromServer;
  const pollCount = useRef(0);
  const firedLive = useRef(false);
  const [pollExhausted, setPollExhausted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/website/builtin-url");
      if (!res.ok) return;
      const j = (await res.json()) as { builtin?: BuiltinUrl | null; base_domain?: string; custom_domain_attached?: boolean };
      setBuiltin(j.builtin ?? null);
      setLocked(j.custom_domain_attached === true);
      if (j.base_domain) setBaseDomain(j.base_domain);
    } catch {
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setupBlocked = builtin?.status === "verifying" && builtin?.setup_blocked === "dns_not_configured";
  useEffect(() => {
    setPollExhausted(false);
    if (builtin?.status !== "verifying" || setupBlocked) return;
    pollCount.current = 0;
    const t = window.setInterval(() => {
      pollCount.current += 1;
      void load();
      if (pollCount.current >= 15) {
        window.clearInterval(t);
        setPollExhausted(true);
      }
    }, 4000);
    return () => window.clearInterval(t);
  }, [builtin?.status, setupBlocked, load]);
  const setupStuck = builtin?.status === "verifying" && !setupBlocked && pollExhausted;

  useEffect(() => {
    if (builtin?.status === "live" && !firedLive.current) {
      firedLive.current = true;
      onDeployedUrlChanged?.();
    }
    if (builtin?.status !== "live") firedLive.current = false;
  }, [builtin?.status, onDeployedUrlChanged]);

  const currentUrl = builtin?.url ?? publicAppUrl(deployedUrl) ?? null;
  const currentHost = (() => {
    if (!currentUrl) return null;
    try {
      return new URL(currentUrl).host;
    } catch {
      return currentUrl;
    }
  })();

  const copy = async () => {
    if (!currentUrl) return;
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  };

  const openEditor = () => {
    setDraft(builtin?.label ?? "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const label = draft.trim().toLowerCase();
    if (!label) {
      setError("Enter a URL.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/website/builtin-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (res.status === 403) {
        setError("Only workspace owners and admins can change this URL.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(j?.error?.message ?? "We couldn't update that URL.");
        return;
      }
      const j = (await res.json()) as { builtin?: BuiltinUrl | null };
      setBuiltin(j.builtin ?? null);
      setEditing(false);
      firedLive.current = false;
      onDeployedUrlChanged?.();
    } catch {
      setError("We couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/website/builtin-url", { method: "DELETE" });
      if (res.status === 403) {
        setError("Only workspace owners and admins can change this URL.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(j?.error?.message ?? "We couldn't reset that URL.");
        return;
      }
      setBuiltin(null);
      setEditing(false);
      firedLive.current = false;
      onDeployedUrlChanged?.();
    } catch {
      setError("We couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[#f0f0f0] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
          Built-in URL
          <Tooltip label="Your app's address on our domain. Change the name and we handle the routing.">
            <span
              tabIndex={0}
              role="img"
              aria-label="About the built-in URL"
              className="inline-flex cursor-help text-[#b0b0b0] outline-none focus-visible:text-[#595959]"
            >
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </span>
        {editing ? (
          <span className="flex items-center gap-2">
            {builtin && (
              <button
                type="button"
                onClick={() => void resetDefault()}
                disabled={saving}
                className="inline-flex h-8 items-center rounded-cta px-2.5 text-[13px] font-medium text-[#595959] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
              >
                Reset to default
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
              className="inline-flex h-8 items-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#454545] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-8 items-center gap-2 rounded-cta bg-[#0e0f11] px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={openEditor}
            disabled={locked && !!builtin}
            className="inline-flex h-8 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
          >
            <Pencil className="h-3.5 w-3.5 text-[#595959]" />
            Edit URL
          </button>
        )}
      </div>

      <div className="mt-3 border-t border-[#f0f0f0] pt-3">
        {editing ? (
          <div>
            <div className="flex items-center rounded-lg border border-[#d4d4d4] focus-within:border-[#0e0f11]">
              <input
                value={draft}
                autoFocus
                disabled={saving}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                  if (e.key === "Escape") setEditing(false);
                }}
                placeholder="your-app"
                className="h-9 min-w-0 flex-1 rounded-l-lg bg-transparent px-3 text-[13px] text-[#0e0f11] outline-none disabled:opacity-60"
              />
              <span className="shrink-0 select-none pr-3 text-[13px] text-[#8c8c8c]">.{baseDomain}</span>
            </div>
            <p className="mt-2 text-[12px] text-[#8c8c8c]">Use lowercase letters, numbers, and hyphens only.</p>
          </div>
        ) : currentHost ? (
          <>
            <div className="flex items-center gap-2">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#f0f0f0] bg-[#fafafa] px-3 text-[13px] text-[#454545]">
                <span className="truncate">{currentHost}</span>
                {builtin?.status === "verifying" && (
                  <span className="shrink-0 rounded-md bg-[#fff4e5] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">
                    {setupBlocked ? BUILTIN_BLOCKED_TITLE : setupStuck ? BUILTIN_STUCK_TITLE : "Setting up…"}
                  </span>
                )}
                {builtin?.status === "live" && (
                  <span className="shrink-0 rounded-md bg-[#e6f6ee] px-2 py-0.5 text-[11px] font-semibold text-[#0e7c4a]">
                    Live
                  </span>
                )}
                {builtin?.status === "not_live" && (
                  <span className="shrink-0 rounded-md bg-[#fff4e5] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">
                    {BUILTIN_BLOCKED_TITLE}
                  </span>
                )}
                {builtin?.status === "offline" && (
                  <span className="shrink-0 rounded-md bg-[#fdecea] px-2 py-0.5 text-[11px] font-semibold text-[#b42318]">
                    Offline
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={copy}
                aria-label="Copy URL"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-cta text-[#595959] transition-colors hover:bg-[#f0f0f0] hover:text-[#0e0f11]"
              >
                {copied ? <Check className="h-4 w-4 text-[#0e9f6e]" /> : <Copy className="h-4 w-4" />}
              </button>
              <Tooltip label="Open in a new tab">
                <a
                  href={currentUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Open app URL in a new tab"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#f0f0f0] bg-white text-[#595959] transition-colors hover:bg-[#f9f9f9]"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Tooltip>
            </div>
            {builtin?.status === "verifying" && (
              <p className="mt-2 text-[12px] text-[#8c8c8c]">
                {setupBlocked
                  ? DNS_NOT_CONFIGURED_COPY
                  : setupStuck
                    ? builtinStuckCopy(builtin.hostname)
                    : "Setting up your URL. It’ll be live in a moment."}
              </p>
            )}
            {builtin?.status === "not_live" && (
              <p className="mt-2 text-[12px] text-[#8c8c8c]">{BUILTIN_NOT_LIVE_COPY}</p>
            )}
            {builtin?.status === "offline" && (
              <p className="mt-2 text-[12px] text-[#b42318]">
                Your site is offline. Its hosting is suspended, so visitors see an error page.
              </p>
            )}
          </>
        ) : (
          <p className="text-[13px] text-[#8c8c8c]">
            No URL yet. Your app&rsquo;s address appears here once it goes live.
          </p>
        )}
        {locked && builtin && !editing && (
          <p className="mt-2 text-[12px] text-[#8c8c8c]">Remove your custom domain first to change your Zavi address.</p>
        )}
        {error && <p className="mt-2 text-[12px] text-[#c0392b]">{error}</p>}
      </div>
    </div>
  );
}

type CustomDomain = {
  id: string;
  hostname: string;
  domain_type: string;
  status: "pending" | "dns_required" | "verifying" | "verified" | "failed";
  dns_records: Array<{ type: string; host: string; value: string; note?: string }>;
  last_error: string | null;
  last_checked_at: string | null;
};

const DOMAIN_STATUS: Record<
  CustomDomain["status"],
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-[#f0f0f0] text-[#595959]" },
  dns_required: { label: "DNS required", className: "bg-[#fff4e5] text-[#b45309]" },
  verifying: { label: "Verifying", className: "bg-[#fff4e5] text-[#b45309]" },
  verified: { label: "Verified", className: "bg-[#e6f6ee] text-[#0e7c4a]" },
  failed: { label: "Failed", className: "bg-[#fdecea] text-[#c0392b]" },
};

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        } catch {
        }
      }}
      aria-label={`Copy ${value}`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-cta border border-[#f0f0f0] bg-white text-[#595959] transition-colors hover:bg-[#f9f9f9]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#0e9f6e]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

type DnsProvider = { id: string; name: string; dashboardUrl?: string; guideUrl?: string };

function DnsGuidance({ hostname }: { hostname: string }) {
  const [provider, setProvider] = useState<DnsProvider | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/website/custom-domains/dns-provider?hostname=${encodeURIComponent(hostname)}`,
        );
        const j = res.ok ? ((await res.json()) as { provider?: DnsProvider | null }) : null;
        if (alive) setProvider(j?.provider ?? null);
      } catch {
        if (alive) setProvider(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hostname]);

  if (provider === undefined) return null;

  const link = "underline decoration-[#d4d4d4] underline-offset-2 hover:text-[#0e0f11]";
  return (
    <p className="mt-2 text-[12px] text-[#8c8c8c]">
      {provider ? (
        <>
          Your domain&rsquo;s DNS looks like it&rsquo;s managed by{" "}
          <span className="font-medium text-[#0e0f11]">{provider.name}</span>.{" "}
          {provider.dashboardUrl && (
            <a href={provider.dashboardUrl} target="_blank" rel="noreferrer" className={link}>
              Open {provider.name} DNS
            </a>
          )}
          {provider.dashboardUrl && provider.guideUrl && <span> · </span>}
          {provider.guideUrl && (
            <a href={provider.guideUrl} target="_blank" rel="noreferrer" className={link}>
              How to add this record
            </a>
          )}
        </>
      ) : (
        <>Add the record wherever your domain&rsquo;s DNS is managed, usually where you bought the domain.</>
      )}
    </p>
  );
}

function CustomDomainsCard({ onCountChange }: { onCountChange?: (n: number) => void } = {}) {
  const [domains, setDomains] = useState<CustomDomain[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/website/custom-domains");
      if (!res.ok) {
        setLoadError("We couldn't load your custom domains.");
        return;
      }
      const j = (await res.json()) as { domains?: CustomDomain[] };
      setDomains(j.domains ?? []);
      onCountChange?.((j.domains ?? []).length);
      setLoadError(null);
    } catch {
      setLoadError("We couldn't load your custom domains.");
    }
  }, [onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const hostname = draft.trim();
    if (!hostname || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await apiFetch("/api/website/custom-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      if (res.status === 403) {
        setAddError("Only workspace owners and admins can add a custom domain.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setAddError(j?.error?.message ?? "We couldn't add that domain.");
        return;
      }
      setDraft("");
      await load();
    } catch {
      setAddError("We couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  };

  const check = async (id: string) => {
    setBusyId(id);
    try {
      await apiFetch(`/api/website/custom-domains/${id}/verify`, { method: "POST" });
      await load();
    } catch {
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await apiFetch(`/api/website/custom-domains/${id}`, { method: "DELETE" });
      await load();
    } catch {
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-[#f0f0f0] bg-white p-4">
      <div className="flex items-center gap-2">
        <input
          value={draft}
          disabled={adding}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="yourcompany.com or app.yourcompany.com"
          className="h-10 min-w-0 flex-1 rounded-lg border border-[#f0f0f0] px-3 text-[13px] text-[#0e0f11] outline-none transition-colors focus:border-[#d4d4d4] disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={adding || draft.trim().length === 0}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-cta bg-[#0e0f11] px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add domain
        </button>
      </div>
      {addError && <p className="mt-2 text-[12px] text-[#c0392b]">{addError}</p>}

      {loadError && <p className="mt-3 text-[13px] text-[#c0392b]">{loadError}</p>}

      {domains !== null && domains.length === 0 && !loadError && (
        <p className="mt-3 text-[13px] text-[#8c8c8c]">
          Point a domain you own at this app: a root domain (yourcompany.com) or a subdomain
          both work. Add it above, then set the DNS record we show at your domain registrar.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {(domains ?? []).map((d) => {
          const pill = DOMAIN_STATUS[d.status];
          const busy = busyId === d.id;
          return (
            <div key={d.id} className="rounded-xl border border-[#f0f0f0] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Globe className="h-4 w-4 shrink-0 text-[#8c8c8c]" />
                  <span className="truncate text-[13px] font-medium text-[#0e0f11]">{d.hostname}</span>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${pill.className}`}>
                    {pill.label}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {d.status !== "verified" && (
                    <button
                      type="button"
                      onClick={() => void check(d.id)}
                      disabled={busy}
                      className="inline-flex h-8 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-2.5 text-[12px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Check now
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(d.id)}
                    disabled={busy}
                    aria-label={`Remove ${d.hostname}`}
                    className="grid h-8 w-8 place-items-center rounded-cta border border-[#f0f0f0] bg-white text-[#595959] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>

              {d.status !== "verified" && d.dns_records.length > 0 && (
                <div className="mt-3 border-t border-[#f0f0f0] pt-3">
                  <p className="mb-2 text-[12px] text-[#8c8c8c]">
                    {d.dns_records.length > 1
                      ? "Add one of these records where your domain's DNS is managed:"
                      : "Add this record where your domain's DNS is managed:"}
                  </p>
                  {d.dns_records.map((rec, i) => (
                    <div key={i} className={i > 0 ? "mt-2.5" : undefined}>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                        <span className="text-[#595959]">
                          Type <code className="text-[#0e0f11]">{rec.type}</code>
                        </span>
                        <span className="flex items-center gap-2 text-[#595959]">
                          Host <code className="text-[#0e0f11]">{rec.host}</code>
                          <CopyValue value={rec.host} />
                        </span>
                        <span className="flex items-center gap-2 text-[#595959]">
                          Value <code className="text-[#0e0f11]">{rec.value}</code>
                          <CopyValue value={rec.value} />
                        </span>
                      </div>
                      {rec.note && <p className="mt-0.5 text-[11px] text-[#8c8c8c]">{rec.note}</p>}
                    </div>
                  ))}
                  <DnsGuidance hostname={d.hostname} />
                  <p className="mt-2 text-[11px] text-[#8c8c8c]">
                    We check automatically. Most domains go live within a few minutes, sometimes up to a
                    few hours. You can also use &ldquo;Check now&rdquo; above.
                  </p>
                </div>
              )}

              {d.status === "failed" && d.last_error && (
                <p className="mt-2 text-[12px] text-[#c0392b]">{d.last_error}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading overview" data-section-skeleton="overview" className="mx-auto max-w-[840px] p-6">
      <div aria-hidden>
        <div data-skeleton-row className="flex items-start gap-4">
          <Skeleton className="h-16 w-16 shrink-0" rounded="rounded-2xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="mt-1.5 h-4 w-full max-w-[420px]" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        </div>
        <div data-skeleton-row className="mt-4 flex items-center gap-2">
          <Skeleton className="h-10 w-[120px]" rounded="rounded-cta" delayMs={120} />
          <Skeleton className="h-10 w-10" rounded="rounded-cta" delayMs={120} />
        </div>
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton-row className="rounded-2xl border border-[#f0f0f0] p-4">
              <Skeleton className="h-5 w-32" delayMs={240} />
              <Skeleton className="mt-2 h-3 w-3/4" delayMs={240} />
              <Skeleton className="mt-4 h-10 w-full" rounded="rounded-cta" delayMs={240} />
            </div>
          ))}
        </div>
        <div data-skeleton-row className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-[#f0f0f0] p-4">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-5 w-36" delayMs={360} />
            <Skeleton className="mt-2 h-3 w-56 max-w-full" delayMs={360} />
          </div>
          <Skeleton className="h-10 w-[112px] shrink-0" rounded="rounded-cta" delayMs={360} />
        </div>
      </div>
    </div>
  );
}

function ConsoleSkeleton({ section }: { section: NavKey }) {
  if (section === "secrets" || section === "functions" || section === "schedules") return <SiteSectionSkeleton section={section} />;
  if (section === "domains") return <SiteDomainsSkeleton />;
  if (section === "users" || section === "data") return <ViewSkeleton />;
  return <OverviewSkeleton />;
}
