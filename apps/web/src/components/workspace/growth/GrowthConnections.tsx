"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Plug, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useWorkspaceOptional } from "../WorkspaceShell";
import {
  useConnectorRecommendationRows,
  type Recommendation,
} from "../settings/useConnectorRecommendations";
import { startReconnectFlow } from "../settings/reconnectFlows";
import { CONNECTOR_ICON } from "../settings/connectorLogos";
import { needsReconnect, resolveRowHealth } from "../settings/connectorHealth";
import { useSlackScopeState } from "../settings/useSlackScopeStatus";
import { bareSlug, syncLine, useConnectorSyncStatus } from "../settings/useConnectorSyncStatus";
import { SettledSection } from "@/components/ui/SettledSection";
import { DataBars } from "./GrowthMemoSkeleton";
import { FactRow, SectionAction, SubLabel } from "./GrowthSection";
import { isZaviManagedGithubLogin } from "../build/existingProduct";
import { useSetupOptional } from "../setup/SetupProvider";

const GA = "google_analytics";
const SUGGESTED_SHOWN = 6;

const CHAT_SURFACES = new Set(["whatsapp", "imessage", "telegram", "discord", "teams", "msteams", "microsoft_teams"]);

type ConnectedRow = {
  slug: string;
  account_login?: string | null;
  connected_at?: string | null;
  token_expires_at?: string | null;
  read_failed?: boolean;
};

const AGENT_ROLE: Record<string, string> = {
  "performance-marketer": "Zavi's performance marketer",
  "seo-geo": "Zavi's SEO agent",
  "chief-of-staff": "Zavi's chief of staff",
  "dispute-response": "Zavi's disputes agent",
  "growth-lead": "Zavi's growth lead",
  "support-lead": "Zavi's support lead",
  "product-builder": "Zavi's builder",
};
const AGENT_SLUG_RE = new RegExp(`\\b(${Object.keys(AGENT_ROLE).join("|")})\\b`, "g");
export function humanizeAgentSlugs(text: string): string {
  return text.replace(AGENT_SLUG_RE, (slug) => AGENT_ROLE[slug] ?? slug);
}

export function GrowthConnections({
  anyMeasured,
  onConnected,
  refreshKey = 0,
  onHealth,
}: {
  anyMeasured: boolean;
  onHealth?: (h: { connected: number; notSyncing: number }) => void;
  onConnected?: (slugs: string[] | null) => void;
  refreshKey?: number;
}) {
  const workspace = useWorkspaceOptional();
  const setupState = useSetupOptional()?.state;
  const oneState = setupState?.enabled === true && setupState.one_state === true;
  const [ownKey, setReloadKey] = useState(0);
  const reloadKey = ownKey + refreshKey;
  const allRows = useConnectorRecommendationRows(reloadKey);
  const [connectedRows, setConnectedRows] = useState<ConnectedRow[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasSlack = connectedRows?.some((r) => r.slug === "slack") ?? false;
  const { missing: slackMissingScopes, settled: slackSettled } = useSlackScopeState(hasSlack, reloadKey);
  const [connectedSettled, setConnectedSettled] = useState(false);
  const sync = useConnectorSyncStatus(reloadKey);
  const [showConnected, setShowConnected] = useState(false);

  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const loadConnected = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { connectors?: ConnectedRow[] };
      const seen = new Map<string, ConnectedRow>();
      for (const c of body.connectors ?? []) if (!seen.has(c.slug)) seen.set(c.slug, c);
      const rows = Array.from(seen.values());
      setConnectedRows(rows);
      onConnectedRef.current?.(rows.map((r) => r.slug));
    } catch {
      setConnectedRows(null);
      onConnectedRef.current?.(null);
    } finally {
      setConnectedSettled(true);
    }
  }, []);

  const connected = connectedRows?.map((r) => r.slug) ?? null;
  const sources = (connectedRows ?? []).filter(
    (r) =>
      !CHAT_SURFACES.has(r.slug.replace(/^(?:pipedream|composio)\./, "")) &&
      !(oneState && r.slug === "github" && isZaviManagedGithubLogin(r.account_login)),
  );
  const broken = sources.filter(
    (r) =>
      r.read_failed === true ||
      needsReconnect(
        resolveRowHealth(
          {
            slug: r.slug,
            connected: true,
            connected_at: r.connected_at ?? undefined,
            token_expires_at: r.token_expires_at ?? undefined,
          },
          slackMissingScopes,
        ),
      ),
  );
  const brokenSlugs = new Set(broken.map((r) => r.slug));
  const syncOf = (slug: string) => syncLine(sync.sources?.[bareSlug(slug)]);
  const stale = sources.filter((r) => !brokenSlugs.has(r.slug) && syncOf(r.slug)?.stale);
  const working = sources.length - broken.length;
  const connectedSet = new Set(
    (connected ?? []).flatMap((s) => [s, s.replace(/^(?:pipedream|composio)\./, "")]),
  );
  const rows = allRows === null ? null : allRows.filter((r) => !connectedSet.has(r.slug));

  useEffect(() => {
    void loadConnected();
  }, [loadConnected, reloadKey]);

  const connect = async (slug: string) => {
    setConnecting(slug);
    setError(null);
    try {
      await startReconnectFlow(slug);
    } catch (e) {
      setError((e as Error).message || "Could not start the connection.");
    } finally {
      setConnecting(null);
      setReloadKey((k) => k + 1);
    }
  };

  const openToolkit = () =>
    workspace?.openTab({
      kind: "brain",
      title: "Connectors",
      payload: { kind: "brain" },
      dirty: false,
      pinned: false,
    });

  const gaConnected =
    connected?.includes(GA) ?? rows?.every((r) => r.slug !== GA) ?? true;
  const suggested = (rows ?? [])
    .slice()
    .sort((a, b) => Number(b.slug === GA) - Number(a.slug === GA))
    .slice(0, SUGGESTED_SHOWN);
  const brokenSet = new Set(broken.map((r) => r.slug));
  const staleSet = new Set(stale.map((r) => r.slug));

  const settled = connectedSettled && allRows !== null && (!hasSlack || slackSettled) && sync.settled;
  const onHealthRef = useRef(onHealth);
  onHealthRef.current = onHealth;
  const notSyncing = broken.length + stale.length;
  useEffect(() => {
    if (settled && connectedRows !== null) onHealthRef.current?.({ connected: working, notSyncing });
  }, [settled, connectedRows, working, notSyncing]);

  return (
    <SettledSection
      ready={settled}
      holdOnRefresh={false}
      skeleton={<DataBars ariaLabel="Loading your data" />}
    >
    <FactRow
      label="Your data"
      action={
        workspace ? (
          <SectionAction label="Add a connector" onClick={openToolkit}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add
          </SectionAction>
        ) : undefined
      }
    >
      {connectedRows !== null && (
        <p className="mb-2 text-[13px] tabular-nums text-inkMuted">
          {`${working} ${working === 1 ? "source" : "sources"} connected${broken.length > 0 ? ` · ${broken.length} need reconnecting` : ""}${stale.length > 0 ? ` · ${stale.length} not syncing` : ""}`}
        </p>
      )}
      {rows === null ? (
        <div role="status" aria-label="Loading connectors" className="h-6" />
      ) : (
        <>
          {}
          {suggested.length > 0 && (
            <>
              <SubLabel>
                {!gaConnected && !anyMeasured
                  ? "Nothing is measured yet. Connect a source to start"
                  : "Worth connecting"}
              </SubLabel>
              {}
              <div className="[container-type:inline-size]">
              <ul className="grid grid-cols-1 gap-2 [@container(min-width:440px)]:grid-cols-2 [@container(min-width:660px)]:grid-cols-3">
                {suggested.map((rec) => (
                  <ConnectorTile
                    key={rec.slug}
                    rec={rec}
                    highlight={rec.slug === GA}
                    busy={connecting === rec.slug}
                    disabled={connecting !== null}
                    onConnect={() => void connect(rec.slug)}
                  />
                ))}
              </ul>
              </div>
            </>
          )}

          {sources.length > 0 && (
            <div className={suggested.length > 0 ? "mt-4" : undefined}>
              {}
              <button
                type="button"
                aria-expanded={showConnected}
                onClick={() => setShowConnected((v) => !v)}
                className="text-sm font-semibold text-inkSoft underline-offset-2 hover:text-ink hover:underline"
              >
                {showConnected ? "Show less" : "Show more"}
              </button>
              <ul className={`${showConnected || broken.length > 0 || stale.length > 0 ? "mt-2" : ""} flex flex-wrap gap-2`}>
                {sources.filter((r) => showConnected || brokenSet.has(r.slug) || staleSet.has(r.slug)).map((r) => {
                  const name = connectorLabel(r.slug);
                  const isBroken = brokenSet.has(r.slug);
                  const synced = isBroken ? null : syncOf(r.slug);
                  const icon = CONNECTOR_ICON[r.slug.replace(/^(?:pipedream|composio)\./, "")];
                  return (
                    <li
                      key={r.slug}
                      className="inline-flex items-center gap-2 rounded-full border border-rule py-1 pl-1.5 pr-2.5 text-xs text-ink"
                    >
                      {icon ? (
                        <Image src={icon} alt="" width={16} height={16} className="h-4 w-4 object-contain" />
                      ) : (
                        <Plug className="h-3.5 w-3.5 text-inkMuted" aria-hidden="true" />
                      )}
                      {name}
                      {synced && (
                        <span
                          data-testid="connector-synced"
                          className={synced.stale ? "font-medium text-warn dark:text-marigold" : "text-inkMuted"}
                        >
                          {synced.stale ? `· not syncing, ${synced.text.toLowerCase()}` : `· ${synced.text.replace(/^Last synced /, "synced ")}`}
                        </span>
                      )}
                      {isBroken ? (
                        <button
                          type="button"
                          onClick={() => void connect(r.slug)}
                          disabled={connecting !== null}
                          aria-label={`Reconnect ${name}`}
                          className="ml-0.5 font-medium text-warn underline-offset-2 hover:underline disabled:opacity-40 dark:text-marigold"
                        >
                          {connecting === r.slug ? "Connecting…" : "Reconnect"}
                        </button>
                      ) : (
                        <span
                          aria-label={synced?.stale ? "not syncing" : "working"}
                          className={`h-1.5 w-1.5 rounded-full ${synced?.stale ? "bg-marigoldDeep" : "bg-mintDeep"}`}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {gaConnected && suggested.length === 0 && (
            <p className="mt-3 text-sm text-inkMuted">
              Everything Zavi suggests for a company like yours is connected.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
    </FactRow>
    </SettledSection>
  );
}

const LABEL: Record<string, string> = {
  google_analytics: "Google Analytics",
  google_search_console: "Search Console",
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  github: "GitHub",
  posthog: "PostHog",
  operator_db: "Your database",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  tiktok_ads: "TikTok Ads",
  reddit_ads: "Reddit Ads",
  x_ads: "X Ads",
  linkedin_ads: "LinkedIn Ads",
  email: "SendGrid",
};

export function connectorLabel(slug: string): string {
  const bare = slug.replace(/^(?:pipedream|composio)\./, "");
  if (LABEL[bare]) return LABEL[bare];
  const words = bare.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ConnectorTile({
  rec,
  highlight,
  busy,
  disabled,
  onConnect,
}: {
  rec: Recommendation;
  highlight: boolean;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  const name = rec.name ?? rec.slug;
  const icon = CONNECTOR_ICON[rec.slug];
  const why = rec.rationale ? humanizeAgentSlugs(rec.rationale) : undefined;
  return (
    <li
      title={why}
      className={
        "flex items-center gap-2.5 rounded-xl border p-2.5 " +
        (highlight ? "border-inkMuted bg-creamDeep" : "border-rule")
      }
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-creamDeep"
      >
        {icon ? (
          <Image src={icon} alt="" width={20} height={20} className="h-5 w-5 object-contain" />
        ) : highlight ? (
          <BarChart3 className="h-4 w-4 text-inkMuted" />
        ) : (
          <Plug className="h-4 w-4 text-inkMuted" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
      </div>
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        aria-label={`Connect ${name}`}
        className="shrink-0 rounded-cta border border-rule px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50 compact:px-3 compact:py-2"
      >
        {busy ? "…" : "Connect"}
      </button>
    </li>
  );
}
