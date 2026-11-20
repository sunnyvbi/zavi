
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { WorkspaceBackendDown } from "./WorkspaceBackendDown";
import {
  resolveWorkspaceAgentSlug,
  WORKSPACE_UUID_RE,
} from "@/components/workspace/deepLinkSeed";
import { apiUrl } from "@/lib/api";
import { isTransientAuthError } from "@/lib/authTransient";
import { fetchMyRole } from "@/lib/members";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import type {
  WorkspaceBootstrapPayload,
  WorkspaceNextTilesPayload,
} from "@/lib/workspace/types";
import { urlTabKindFromParam } from "@/lib/workspace/tabUrl";
import { CompanyDeepLink } from "@/components/workspace/CompanyDeepLink";
import { AnomalyMuteLink } from "@/components/workspace/AnomalyMuteLink";
import { OnboardingEmailVisit } from "@/components/workspace/OnboardingEmailVisit";
import { onboardingSrcOf } from "@/lib/onboarding-email-src";

const EMPTY_BOOTSTRAP: WorkspaceBootstrapPayload = {
  tree: { agents: [] },
  tabs_session: { tabs: [], active_tab_id: null },
  status_counters: {
    drift_pct: 0,
    cost_today_usd: 0,
    active_runs: 0,
    approvals_pending: 0,
    credits_remaining: null,
    credits_enforced: false,
    included_allowance: null,
  },
  prefs: {},
};

type BootstrapResult =
  | { ok: true; payload: WorkspaceBootstrapPayload }
  | { ok: false; reason: "unreachable" };

async function fetchBootstrap(
  accessToken: string | undefined,
): Promise<BootstrapResult> {
  if (!accessToken) return { ok: true, payload: EMPTY_BOOTSTRAP };
  try {
    const res = await fetch(apiUrl("/api/workspace/bootstrap"), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status >= 500) return { ok: false, reason: "unreachable" };
    if (!res.ok) return { ok: true, payload: EMPTY_BOOTSTRAP };
    return {
      ok: true,
      payload: (await res.json()) as WorkspaceBootstrapPayload,
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

async function fetchInitialNextTiles(
  accessToken: string | undefined,
): Promise<WorkspaceNextTilesPayload | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(apiUrl("/api/workspace/next-tiles"), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WorkspaceNextTilesPayload> & {
      degraded?: boolean;
    };
    if (body.degraded || !Array.isArray(body.tiles) || body.tiles.length === 0) return null;
    return {
      tiles: body.tiles.slice(0, 3),
      first_run_done: body.first_run_done === true,
    };
  } catch {
    return null;
  }
}

export type WorkspaceSearchParams = {
  agent?: string;
  tab?: string;
  thread?: string;
  dispute?: string;
  build?: string;
  company?: string;
  mute_alert?: string;
  model?: string;
  src?: string;
} & Partial<Record<(typeof CHANNEL_DRAWER_KEYS)[number], string>>;

const CHANNEL_DRAWER_KEYS = [
  "channel",
  "drawer",
  "job",
  "paid",
  "cancelled",
  "brief",
  "application",
  "offer",
  "package",
  "creator",
  "hire_cancelled",
  "action",
] as const;

export async function WorkspacePage({
  searchParams,
  threadId: pathThreadId,
  layout = "zavi",
}: {
  searchParams?: WorkspaceSearchParams;
  threadId?: string;
  layout?: "zavi" | "legacy";
}) {
  const supabase = createServerSupabase(await cookies());
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (!userData?.user) {
    if (isTransientAuthError(userError)) return <WorkspaceBackendDown />;
    if (pathThreadId) {
      redirect(
        `/login?next=${encodeURIComponent(`/workspace/${pathThreadId}`)}`,
      );
    }
    const qs = new URLSearchParams();
    if (searchParams?.agent) qs.set("agent", searchParams.agent);
    if (searchParams?.tab) qs.set("tab", searchParams.tab);
    if (searchParams?.thread) qs.set("thread", searchParams.thread);
    if (searchParams?.dispute) qs.set("dispute", searchParams.dispute);
    if (searchParams?.build) qs.set("build", searchParams.build);
    if (searchParams?.company) qs.set("company", searchParams.company);
    if (searchParams?.mute_alert) qs.set("mute_alert", searchParams.mute_alert);
    if (searchParams?.model) qs.set("model", searchParams.model);
    const src = onboardingSrcOf(searchParams?.src);
    if (src) qs.set("src", src);
    for (const key of CHANNEL_DRAWER_KEYS) {
      const value = searchParams?.[key];
      if (typeof value === "string" && value) qs.set(key, value);
    }
    const queryTail = qs.toString();
    const fullNext = queryTail ? `/workspace?${queryTail}` : "/workspace";
    redirect(`/login?next=${encodeURIComponent(fullNext)}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }
  if (searchParams?.tab === "members") redirect("/workspace?tab=settings#team");
  if (searchParams?.company && searchParams.company !== tenant.id) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream text-[14px] text-inkSoft">
        <CompanyDeepLink holder />
      </main>
    );
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  const [result, initialNextTiles] = await Promise.all([
    fetchBootstrap(accessToken),
    fetchInitialNextTiles(accessToken),
  ]);

  if (!result.ok) {
    return <WorkspaceBackendDown />;
  }

  const role = await fetchMyRole(supabase, tenant.id);
  const bootstrap = result.payload;

  const initialThreadId = (() => {
    if (pathThreadId) return pathThreadId;
    const raw = searchParams?.thread;
    if (!raw || typeof raw !== "string") return null;
    if (raw === "new") return "new";
    return WORKSPACE_UUID_RE.test(raw) ? raw : null;
  })();

  const initialAgentSlug = await (async () => {
    const availableSlugs = bootstrap.tree.agents.map((a) => a.slug);
    const fromParam = pathThreadId || searchParams?.tab === "agent-builder"
      ? undefined
      : resolveWorkspaceAgentSlug(searchParams?.agent, availableSlugs, {
          allowSyntaxFallback: availableSlugs.length === 0,
        });
    if (fromParam) return fromParam;
    if (initialThreadId && initialThreadId !== "new") {
      const { data } = await supabase
        .from("agent_threads")
        .select("agent_slug")
        .eq("id", initialThreadId)
        .maybeSingle();
      const slug = (data as { agent_slug?: string } | null)?.agent_slug;
      if (typeof slug === "string" && slug.length > 0) {
        if (availableSlugs.length === 0 || availableSlugs.includes(slug)) {
          return slug;
        }
      }
    }
    return undefined;
  })();

  const initialTab = (() => {
    if (initialAgentSlug) return undefined;
    const raw = searchParams?.tab;
    const kind = urlTabKindFromParam(raw);
    if (kind) return kind;
    if (raw === "dispute-detail" || raw === "build") return raw;
    return undefined;
  })();

  const initialBuildSessionId =
    initialTab === "build" &&
    typeof searchParams?.build === "string" &&
    WORKSPACE_UUID_RE.test(searchParams.build)
      ? searchParams.build
      : null;

  const initialDisputeId =
    typeof searchParams?.dispute === "string" && searchParams.dispute
      ? searchParams.dispute
      : undefined;

  const onboardingEmailSrc = onboardingSrcOf(searchParams?.src);

  return (
    <>
    <CompanyDeepLink />
    {typeof searchParams?.mute_alert === "string" &&
    searchParams.mute_alert &&
    searchParams.company === tenant.id ? (
      <AnomalyMuteLink muteKey={searchParams.mute_alert} company={tenant.id} />
    ) : null}
    {onboardingEmailSrc ? <OnboardingEmailVisit src={onboardingEmailSrc} /> : null}
    <WorkspaceShell
      bootstrap={bootstrap}
      userEmail={userData.user.email ?? undefined}
      tenantName={tenant.displayName}
      initialNextTiles={initialNextTiles}
      currentUserId={userData.user.id}
      tenantId={tenant.id}
      role={role}
      initialAgentSlug={initialAgentSlug}
      initialTab={initialTab}
      initialThreadId={initialThreadId}
      initialDisputeId={initialDisputeId}
      initialBuildSessionId={initialBuildSessionId}
      layout={layout}
    />
    </>
  );
}
