"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { railFor } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { ConnectorTile, TileMenu } from "./ConnectorTile";
import { showConnectorError } from "./connectorErrorDialog";
import { CONNECTOR_PURPOSE } from "./connectorCopy";
import { CONNECTOR_ICON } from "./connectorLogos";

export type ConnectedApp = {
  rail: "composio" | "pipedream";
  app: string;
  slug: string;
  name: string;
  logo: string | null;
};

const NAME_OVERRIDES: Record<string, string> = {
  posthog: "PostHog",
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  clickup: "ClickUp",
  typeform: "Typeform",
  mailchimp: "Mailchimp",
  sendgrid: "SendGrid",
  quickbooks: "QuickBooks",
  woocommerce: "WooCommerce",
  bigquery: "BigQuery",
  openai: "OpenAI",
  aws: "AWS",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  paypal: "PayPal",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  googledocs: "Google Docs",
  linkedin_ads: "LinkedIn Ads",
};

export function prettyAppName(app: string): string {
  const key = String(app ?? "").trim().toLowerCase();
  if (!key) return "";
  if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
  return key
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function connectFailureNotice(params: Pick<URLSearchParams, "get">, dismissed = false): string | null {
  if (dismissed || !params.get("connect_error")) return null;
  const name = prettyAppName(params.get("provider") ?? "") || "This connector";
  return `${name} didn’t finish connecting, so nothing was saved. If you cancelled, use Connect to try again.`;
}

export const GOOGLE_SCOPE_BOX: Record<string, string> = {
  google_analytics: "Google Analytics",
  google_search_console: "Search Console",
};

export function composioErrorNotice(slug: string, name: string, code: string | null): string {
  const box = GOOGLE_SCOPE_BOX[slug];
  if (code === "google_scope_missing" && box) {
    return `Google didn’t give Zavi access to ${box}. Click Connect and tick the ${box} box on Google’s screen.`;
  }
  return `Couldn’t connect ${name}. Try again.`;
}

export function parseAggregatorSlug(
  slug: string,
): { rail: "composio" | "pipedream"; app: string } | null {
  if (slug.startsWith("composio.")) {
    const app = slug.slice("composio.".length);
    return app ? { rail: "composio", app } : null;
  }
  if (slug.startsWith("pipedream.")) {
    const app = slug.slice("pipedream.".length);
    return app ? { rail: "pipedream", app } : null;
  }
  return null;
}

const NATIVE_FOLDED_SLUGS = new Set<string>(["pipedream.stripe", "composio.reddit", "composio.instagram"]);

export const NATIVE_TILE_OWNED = new Set<string>([
  "composio.google_analytics",
  "composio.google_search_console",
  "composio.tiktok_ads",
  "composio.reddit_ads",
]);

export function visibleConnectedRows<T extends { slug: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => {
    if (r.slug.startsWith("pipedream.")) return false;
    if (NATIVE_TILE_OWNED.has(r.slug)) return false;
    if (r.slug.startsWith("composio.")) return railFor(r.slug.slice("composio.".length)) === "composio";
    return true;
  });
}

export function isNativeFoldedSlug(slug: string): boolean {
  return NATIVE_FOLDED_SLUGS.has(slug);
}

export function matchesAppQuery(app: ConnectedApp, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return app.name.toLowerCase().includes(q) || app.app.toLowerCase().includes(q);
}

const PIPEDREAM_LOOKUP_CAP = 12;

export function useConnectedApps(reloadKey: number = 0): {
  apps: ConnectedApp[];
  loading: boolean;
  removeApp: (slug: string) => void;
} {
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let rows: Array<{ rail: "composio" | "pipedream"; app: string; slug: string }> = [];
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setLoading(false);
          return;
        }
        const { data } = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId);
        if (cancelled) return;
        rows = visibleConnectedRows((data ?? []) as Array<{ slug: string }>)
          .map((r) => {
            const parsed = parseAggregatorSlug(r.slug);
            return parsed ? { ...parsed, slug: r.slug } : null;
          })
          .filter((r): r is { rail: "composio" | "pipedream"; app: string; slug: string } => !!r);
      } catch {
        if (!cancelled) setLoading(false);
        return;
      }

      if (rows.length === 0) {
        if (!cancelled) {
          setApps([]);
          setLoading(false);
        }
        return;
      }

      const base: ConnectedApp[] = rows.map((r) => ({
        ...r,
        name: prettyAppName(r.app),
        logo: CONNECTOR_ICON[r.app] ?? null,
      }));
      if (!cancelled) {
        setApps(base);
        setLoading(false);
      }

      const resolved = new Map<string, { name?: string; logo?: string | null }>();

      if (rows.some((r) => r.rail === "composio")) {
        try {
          const res = await apiFetch("/api/connectors/composio/toolkits");
          const body = (await res.json().catch(() => ({}))) as {
            toolkits?: Array<{ slug: string; name: string; logo: string }>;
          };
          for (const t of body.toolkits ?? []) {
            resolved.set(`composio.${t.slug}`, { name: t.name, logo: t.logo });
          }
        } catch {
        }
      }

      const pdRows = rows.filter((r) => r.rail === "pipedream").slice(0, PIPEDREAM_LOOKUP_CAP);
      await Promise.all(
        pdRows.map(async (r) => {
          try {
            const res = await apiFetch(
              `/api/connectors/pipedream/apps?q=${encodeURIComponent(r.app)}`,
            );
            const body = (await res.json().catch(() => ({}))) as {
              apps?: Array<{ slug: string; name: string; img_src?: string | null }>;
            };
            const hit = (body.apps ?? []).find((a) => a.slug === r.app);
            if (hit) resolved.set(r.slug, { name: hit.name, logo: hit.img_src ?? null });
          } catch {
          }
        }),
      );

      if (cancelled || resolved.size === 0) return;
      setApps((prev) =>
        prev.map((a) => {
          const hit = resolved.get(a.slug);
          return hit ? { ...a, name: hit.name ?? a.name, logo: CONNECTOR_ICON[a.app] ?? hit.logo ?? a.logo } : a;
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const removeApp = useCallback((slug: string) => {
    setApps((prev) => prev.filter((a) => a.slug !== slug));
  }, []);

  return { apps, loading, removeApp };
}

export async function disconnectConnectedApp(
  app: ConnectedApp,
  onRemoved: (slug: string) => void,
  onConfirmed?: () => void,
): Promise<void> {
  if (!confirm(`Disconnect ${app.name}?`)) return;
  onConfirmed?.();
  try {
    const res = await apiFetch(
      `/api/connectors/${app.rail}/${encodeURIComponent(app.app)}/disconnect`,
      { method: "POST" },
    );
    if (res.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    onRemoved(app.slug);
  } catch (e) {
    showConnectorError({
      title: `Couldn’t disconnect ${app.name}`,
      message: (e as Error).message,
    });
  }
}

export function ConnectedAppTiles({
  apps,
  readOnly,
  onRemoved,
}: {
  apps: ConnectedApp[];
  readOnly: boolean;
  onRemoved: (slug: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState<Set<string>>(new Set());

  const act = async (
    kind: "connect" | "disconnect",
    app: ConnectedApp,
  ): Promise<void> => {
    if (kind === "disconnect") {
      await disconnectConnectedApp(app, onRemoved, () => setBusy(app.slug));
      setBusy(null);
      return;
    }
    setBusy(app.slug);
    try {
      const res = await apiFetch(
        `/api/connectors/${app.rail}/${encodeURIComponent(app.app)}/${kind}`,
        { method: "POST" },
      );
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        oauth_url?: string;
        connect_link_url?: string | null;
        error?: { message?: string };
      };
      const next = body.oauth_url ?? body.connect_link_url;
      if (!res.ok || body.error || !next) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      window.location.href = next;
    } catch (e) {
      showConnectorError({
        title: `Couldn’t ${kind} ${app.name}`,
        message: (e as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {apps.map((app) => (
        <ConnectorTile
          key={app.slug}
          logo={
            <div className="flex min-w-0 items-center gap-2">
              {app.logo && !logoFailed.has(app.slug) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={app.logo}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-[6px] bg-white object-contain"
                  onError={() => setLogoFailed((p) => new Set(p).add(app.slug))}
                />
              ) : (
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[11px] font-bold text-[#595959]">
                  {app.name
                    .replace(/[^A-Za-z0-9 ]/g, "")
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]!.toUpperCase())
                    .join("") || "?"}
                </span>
              )}
              <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
                {app.name}
              </span>
            </div>
          }
          name={app.name}
          description={CONNECTOR_PURPOSE[app.app] ?? `Connected. Agents can use ${app.name}.`}
          status={{ tone: "connected", text: "Connected" }}
          action={
            readOnly ? (
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#595959]">
                connected
              </span>
            ) : (
              <TileMenu
                label="Manage"
                disabled={busy === app.slug}
                items={[
                  {
                    label: busy === app.slug ? "Opening…" : "Reconnect",
                    onClick: () => void act("connect", app),
                  },
                  {
                    label: "Disconnect",
                    onClick: () => void act("disconnect", app),
                    danger: true,
                  },
                ]}
              />
            )
          }
        />
      ))}
    </>
  );
}
