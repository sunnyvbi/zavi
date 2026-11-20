"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import {
  ConnectorTile,
  TileButton,
  TileMenu,
} from "@/components/workspace/settings/ConnectorTile";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { purposeFor } from "@/components/workspace/settings/connectorCopy";
import { visibleConnectedRows } from "@/components/workspace/settings/ConnectedApps";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { startComposioConnect } from "./composioConnect";

export type ComposioToolkit = {
  slug: string;
  name: string;
  logo: string;
  category?: string | null;
  connectable?: boolean;
};
type ToolkitsResp = { toolkits?: ComposioToolkit[]; requested?: string[] };

export { COMPOSIO_CONNECT_LINE } from "./composioConnect";
export const REQUESTED_NOTE = "Thanks, we'll let you know when it's ready";
export const PAGE_SIZE = 50;

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]!.toUpperCase()).join("") || "?";
}

export function useComposioApps(reloadKey: number = 0) {
  const [toolkits, setToolkits] = useState<ComposioToolkit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/connectors/composio/toolkits");
        if (res.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json().catch(() => ({}))) as ToolkitsResp;
        if (!cancelled) {
          setFailed(false);
          setToolkits(body.toolkits ?? []);
          setRequested(new Set(body.requested ?? []));
        }
      } catch {
        if (!cancelled) { setFailed(true); setToolkits([]); }
      }
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const { data } = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId)
          .like("slug", "composio.%");
        if (cancelled) return;
        setConnected(
          new Set(
            visibleConnectedRows((data ?? []) as Array<{ slug: string }>).map((r) => r.slug.replace(/^composio\./, "")),
          ),
        );
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const available = useMemo(() => catalogVisible(toolkits ?? [], connected, ""), [toolkits, connected]);

  async function connect(slug: string) {
    setBusy(slug);
    try {
      await startComposioConnect(slug);
    } catch (e) {
      showConnectorError({ title: `Couldn’t connect ${slug}`, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(slug: string) {
    if (!confirm(`Disconnect ${slug}?`)) return;
    setBusy(slug);
    try {
      const res = await apiFetch(`/api/connectors/composio/${encodeURIComponent(slug)}/disconnect`, { method: "POST" });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      forgetEmailTestLists();
      setConnected((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    } catch (e) {
      showConnectorError({ title: `Couldn’t disconnect ${slug}`, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function request(slug: string) {
    setBusy(slug);
    try {
      const res = await apiFetch(`/api/connectors/composio/${encodeURIComponent(slug)}/request`, { method: "POST" });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setRequested((prev) => new Set(prev).add(slug));
    } catch (e) {
      showConnectorError({ title: "Couldn’t send your request", message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return {
    toolkits,
    failed,
    loaded: toolkits !== null,
    available,
    connected,
    requested,
    busy,
    connect,
    disconnect,
    request,
  };
}

export type ComposioAppsState = ReturnType<typeof useComposioApps>;

export function matchesToolkitQuery(t: ComposioToolkit, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || t.name.toLowerCase().includes(q) || t.slug.includes(q);
}

export function catalogVisible(
  list: readonly ComposioToolkit[],
  connected: ReadonlySet<string>,
  query: string,
): ComposioToolkit[] {
  return list.filter((t) => !connected.has(t.slug) && matchesToolkitQuery(t, query));
}

export function ComposioAppTile({
  toolkit,
  connected,
  requested = false,
  busy,
  readOnly,
  onConnect,
  onDisconnect,
  onRequest,
}: {
  toolkit: ComposioToolkit;
  connected: boolean;
  requested?: boolean;
  busy: boolean;
  readOnly: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRequest?: () => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const comingSoon = !connected && toolkit.connectable === false;
  return (
    <ConnectorTile
      id={`connector-composio-${toolkit.slug}`}
      logo={<CatalogLogo t={toolkit} failed={logoFailed} onError={() => setLogoFailed(true)} />}
      name={toolkit.name}
      description={comingSoon && requested ? REQUESTED_NOTE : purposeFor(toolkit.slug, toolkit.name)}
      status={{
        tone: connected ? "connected" : "idle",
        text: connected ? "Connected" : comingSoon ? "Coming soon" : "Not connected",
      }}
      action={
        readOnly ? null : comingSoon ? (
          requested ? (
            <TileButton disabled>Requested</TileButton>
          ) : (
            <TileButton onClick={onRequest} disabled={busy}>
              <span aria-hidden>I need it</span>
              <span className="sr-only">I need {toolkit.name}</span>
            </TileButton>
          )
        ) : connected ? (
          <TileMenu
            label="Manage"
            disabled={busy}
            items={[
              { label: busy ? "Opening…" : "Reconnect", onClick: onConnect },
              { label: "Disconnect", onClick: onDisconnect, danger: true },
            ]}
          />
        ) : (
          <TileButton onClick={onConnect} disabled={busy}>
            <span aria-hidden>{busy ? "Opening…" : "Connect"}</span>
            <span className="sr-only">Connect {toolkit.name}</span>
          </TileButton>
        )
      }
    />
  );
}

export function ComposioApps({
  apps,
  readOnly,
  query,
}: {
  apps: ComposioAppsState;
  readOnly: boolean;
  query: string;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const filtered = useMemo(
    () => catalogVisible(apps.toolkits ?? [], apps.connected, query),
    [apps.toolkits, apps.connected, query],
  );
  useEffect(() => setVisible(PAGE_SIZE), [query]);

  if (filtered.length === 0) return null;
  return (
    <>
      {filtered.slice(0, visible).map((t) => (
        <ComposioAppTile
          key={t.slug}
          toolkit={t}
          connected={false}
          requested={apps.requested.has(t.slug)}
          busy={apps.busy === t.slug}
          readOnly={readOnly}
          onConnect={() => void apps.connect(t.slug)}
          onDisconnect={() => void apps.disconnect(t.slug)}
          onRequest={() => void apps.request(t.slug)}
        />
      ))}
      {filtered.length > visible && (
        <div className="col-span-full flex justify-center">
          <TileButton onClick={() => setVisible((v) => v + PAGE_SIZE)}>Load more</TileButton>
        </div>
      )}
    </>
  );
}

function CatalogLogo({
  t,
  failed,
  onError,
}: {
  t: ComposioToolkit;
  failed: boolean;
  onError: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {failed ? (
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[11px] font-bold text-[#595959]">
          {initials(t.name)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={t.logo}
          alt=""
          className="h-6 w-6 shrink-0 rounded-[6px] bg-white object-contain"
          onError={onError}
        />
      )}
      <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
        {t.name}
      </span>
    </div>
  );
}
