"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import {
  ConnectorTile,
  TileButton,
  TileMenu,
} from "@/components/workspace/settings/ConnectorTile";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { SkeletonConnectorTile } from "@/components/workspace/Skeleton";
import {
  CategorySection,
  INTEGRATION_GRID,
} from "@/components/workspace/settings/CategorySection";

type CatalogApp = {
  slug: string;
  name: string;
  needs_setup: boolean;
  img_src?: string | null;
  description?: string | null;
  categories?: string[] | null;
};

const CATEGORY_ORDER = [
  "Productivity",
  "Marketing",
  "Communication",
  "CRM",
  "Commerce",
  "Data Analytics",
  "Business Management",
  "Artificial Intelligence (AI)",
  "Developer Tools",
];
function categoryRank(c: string): number {
  const i = CATEGORY_ORDER.indexOf(c);
  if (i >= 0) return i;
  return c === "Other" ? 1000 : CATEGORY_ORDER.length;
}
type AppsResp = { apps?: CatalogApp[]; next_cursor?: string | null; error?: { message?: string } };
type ConnectStartResp = { connect_link_url?: string | null; error?: { code?: string; message?: string } };

export const PAGE_SIZE = 50;
const FETCH_LIMIT = 100;
const MAX_FETCH_ROUNDS = 6;

const PIPEDREAM_ENABLED = process.env.NEXT_PUBLIC_PIPEDREAM_CONNECT_ENABLED !== "false";

const VARIANT_SUFFIX_RE = /_(oauth|api_key|apikey|bot|app|v\d+|partner|developer|admin)$/;
function baseSlug(slug: string): string {
  let s = slug.toLowerCase();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(VARIANT_SUFFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

function norm(slug: string): string {
  return slug.toLowerCase().replace(/[_-]/g, "");
}

const NATIVE_SLUGS = new Set([
  "slack",
  "github",
  "stripe",
  "jira",
  "meta_ads",
  "google_ads",
  "linkedin_ads",
  "operator_db",
  "higgsfield",
]);

export function dedupe(
  results: CatalogApp[],
  covered: Set<string>,
  connected: Set<string> = new Set(),
): CatalogApp[] {
  const out: CatalogApp[] = [];
  const seenBase = new Set<string>();
  for (const a of results) {
    const base = baseSlug(a.slug);
    if (covered.has(norm(base)) || covered.has(norm(a.slug))) continue;
    if (connected.has(a.slug)) continue;
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    out.push(a);
  }
  return out;
}

function initials(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

export function PipedreamApps({
  readOnly,
  query,
  reloadKey = 0,
  grouped = false,
}: {
  readOnly: boolean;
  query: string;
  reloadKey?: number;
  grouped?: boolean;
}) {
  const [results, setResults] = useState<CatalogApp[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [covered, setCovered] = useState<Set<string>>(new Set([...NATIVE_SLUGS].map(norm)));
  const [busy, setBusy] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [searching, setSearching] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const reqSeq = useRef(0);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const resultsRef = useRef<CatalogApp[]>([]);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!PIPEDREAM_ENABLED) return;
    let cancelled = false;
    (async () => {
      const excluded = new Set<string>([...NATIVE_SLUGS].map(norm));
      try {
        const res = await apiFetch("/api/connectors/composio/toolkits");
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            toolkits?: Array<{ slug: string; keep?: boolean }>;
          };
          for (const t of body.toolkits ?? []) {
            if (t.keep) excluded.add(norm(t.slug));
          }
        }
      } catch {
      }
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (!cancelled && tenantId) {
          const { data } = await sb
            .from("connector_metadata")
            .select("slug")
            .eq("tenant_id", tenantId)
            .like("slug", "composio.%");
          for (const r of (data ?? []) as Array<{ slug: string }>) {
            excluded.add(norm(r.slug.replace(/^composio\./, "")));
          }
        }
      } catch {
      }
      if (!cancelled) setCovered(excluded);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!PIPEDREAM_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const { data } = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId)
          .like("slug", "pipedream.%");
        if (cancelled) return;
        setConnected(
          new Set(((data ?? []) as Array<{ slug: string }>).map((r) => r.slug.replace(/^pipedream\./, ""))),
        );
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const q = query.trim();

  async function fillTo(target: number, seq: number): Promise<void> {
    for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
      if (dedupe(resultsRef.current, coveredRef.current, connectedRef.current).length >= target) {
        return;
      }
      if (round > 0 && !cursorRef.current) return;
      if (round === 0 && resultsRef.current.length > 0 && !cursorRef.current) return;
      const params = new URLSearchParams({ limit: String(FETCH_LIMIT) });
      if (q) params.set("q", q);
      if (cursorRef.current) params.set("cursor", cursorRef.current);
      let body: AppsResp;
      try {
        const res = await apiFetch(`/api/connectors/pipedream/apps?${params.toString()}`);
        if (res.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        body = (await res.json().catch(() => ({}))) as AppsResp;
        if (seq !== reqSeq.current) return;
        if (!res.ok || body.error || !Array.isArray(body.apps)) {
          if (resultsRef.current.length === 0) {
            setLoaded(false);
            setFetchFailed(true);
          }
          cursorRef.current = null;
          setCursor(null);
          return;
        }
      } catch {
        if (seq !== reqSeq.current) return;
        if (resultsRef.current.length === 0) {
          setLoaded(false);
          setFetchFailed(true);
        }
        cursorRef.current = null;
        setCursor(null);
        return;
      }
      const page = body.apps ?? [];
      const next = body.next_cursor ?? null;
      const advanced = next !== cursorRef.current;
      resultsRef.current = [...resultsRef.current, ...page];
      cursorRef.current = advanced ? next : null;
      setResults(resultsRef.current);
      setCursor(cursorRef.current);
      setLoaded(true);
      if (!cursorRef.current || page.length === 0) return;
    }
  }

  useEffect(() => {
    if (!PIPEDREAM_ENABLED) return;
    const seq = ++reqSeq.current;
    resultsRef.current = [];
    cursorRef.current = null;
    setResults([]);
    setCursor(null);
    setVisible(PAGE_SIZE);
    setLoaded(false);
    setFetchFailed(false);
    setSearching(true);
    const t = setTimeout(() => {
      setPaging(true);
      void fillTo(PAGE_SIZE, seq).finally(() => {
        if (seq !== reqSeq.current) return;
        setPaging(false);
        setSearching(false);
      });
    }, q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, retryNonce]);

  async function connect(slug: string) {
    setBusy(slug);
    try {
      const res = await apiFetch(`/api/connectors/pipedream/${encodeURIComponent(slug)}/connect`, {
        method: "POST",
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ConnectStartResp;
      if (!res.ok || body.error || !body.connect_link_url) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      window.location.href = body.connect_link_url;
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
      const res = await apiFetch(`/api/connectors/pipedream/${encodeURIComponent(slug)}/disconnect`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
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

  const allTiles = useMemo(() => dedupe(results, covered, connected), [results, covered, connected]);
  const tiles = useMemo(() => allTiles.slice(0, visible), [allTiles, visible]);
  const hasMore = allTiles.length > visible || !!cursor;

  function loadMore() {
    if (paging || !hasMore) return;
    const target = visible + PAGE_SIZE;
    setVisible(target);
    if (allTiles.length >= target || !cursorRef.current) return;
    const seq = reqSeq.current;
    setPaging(true);
    void fillTo(target, seq).finally(() => {
      if (seq === reqSeq.current) setPaging(false);
    });
  }

  const renderTile = (t: CatalogApp) => {
    const isConnected = connected.has(t.slug);
    const isBusy = busy === t.slug;
    const logo = (
      <div className="flex min-w-0 items-center gap-2">
        {t.img_src && !logoFailed.has(t.slug) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.img_src}
            alt=""
            className="h-6 w-6 shrink-0 rounded-[6px] bg-white object-contain"
            onError={() => setLogoFailed((p) => new Set(p).add(t.slug))}
          />
        ) : (
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[11px] font-bold text-[#595959]">
            {initials(t.name)}
          </span>
        )}
        <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
          {t.name}
        </span>
      </div>
    );
    return (
      <ConnectorTile
        key={`pd-${t.slug}`}
        id={`connector-pipedream-${t.slug}`}
        logo={logo}
        name={t.name}
        description={t.description ?? `Connect ${t.name} so agents can use it.`}
        status={{
          tone: isConnected ? "connected" : "idle",
          text: isConnected ? "Connected" : "Not connected",
        }}
        action={
          readOnly ? null : isConnected ? (
            <TileMenu
              label="Manage"
              disabled={isBusy}
              items={[
                { label: isBusy ? "Opening…" : "Reconnect", onClick: () => connect(t.slug) },
                { label: "Disconnect", onClick: () => disconnect(t.slug), danger: true },
              ]}
            />
          ) : (
            <TileButton onClick={() => connect(t.slug)} disabled={isBusy}>
              <span aria-hidden>{isBusy ? "Opening…" : "Connect"}</span>
              <span className="sr-only">Connect {t.name}</span>
            </TileButton>
          )
        }
      />
    );
  };

  if (grouped) {
    const groups = new Map<string, CatalogApp[]>();
    for (const t of tiles) {
      const cat = t.categories?.[0] || "Other";
      const list = groups.get(cat) ?? [];
      list.push(t);
      groups.set(cat, list);
    }
    const ordered = [...groups.keys()].sort(
      (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
    );
    return (
      <PipedreamCatalog
        enabled={PIPEDREAM_ENABLED}
        searching={searching}
        loaded={loaded}
        fetchFailed={fetchFailed}
        onRetry={() => setRetryNonce((v) => v + 1)}
        tileCount={tiles.length}
        hasMore={hasMore}
        paging={paging}
        onLoadMore={loadMore}
        grouped
      >
        {ordered.map((cat) => (
          <CategorySection
            key={cat}
            title={cat}
            items={groups.get(cat)!.map((t) => ({ key: `pd-${t.slug}`, node: renderTile(t) }))}
          />
        ))}
      </PipedreamCatalog>
    );
  }

  return (
    <PipedreamCatalog
      enabled={PIPEDREAM_ENABLED}
      searching={searching}
      loaded={loaded}
      fetchFailed={fetchFailed}
      onRetry={() => setRetryNonce((v) => v + 1)}
      tileCount={tiles.length}
      hasMore={hasMore}
      paging={paging}
      onLoadMore={loadMore}
    >
      {tiles.map(renderTile)}
    </PipedreamCatalog>
  );
}

function PipedreamCatalog({
  enabled,
  searching,
  loaded,
  fetchFailed,
  onRetry,
  tileCount,
  hasMore,
  paging,
  onLoadMore,
  children,
  grouped = false,
}: {
  enabled: boolean;
  searching: boolean;
  loaded: boolean;
  fetchFailed: boolean;
  onRetry: () => void;
  tileCount: number;
  hasMore: boolean;
  paging: boolean;
  onLoadMore: () => void;
  children: ReactNode;
  grouped?: boolean;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const showTiles = enabled && !searching && loaded && tileCount > 0;
  const canLoad = showTiles && hasMore;

  useEffect(() => {
    if (!canLoad) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, paging]);

  if (!enabled) return null;

  if (searching) {
    const skeletons = (
      <>
        <SkeletonConnectorTile />
        <SkeletonConnectorTile />
        <SkeletonConnectorTile />
        <span className="sr-only col-span-full" role="status" aria-live="polite">
          Searching connectors…
        </span>
      </>
    );
    return grouped ? <div className={INTEGRATION_GRID}>{skeletons}</div> : skeletons;
  }

  if (fetchFailed && tileCount === 0) {
    return (
      <div
        className="col-span-full flex flex-col items-center gap-2 py-8 text-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-base font-medium text-ink">App directory unavailable</p>
        <p className="max-w-sm text-xs text-ink/60">
          We could not load the app catalog just now. This is on our side, not a sign that these
          apps are unsupported.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-cta border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/5"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!loaded || tileCount === 0) return null;

  return (
    <>
      {children}
      {hasMore && (
        <div ref={sentinelRef} className={`col-span-full flex items-center justify-center py-2 ${grouped ? "-mt-4" : ""}`}>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={paging}
            className="rounded-cta border border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#595959] transition hover:bg-[#fafafa] disabled:opacity-60"
          >
            {paging ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
