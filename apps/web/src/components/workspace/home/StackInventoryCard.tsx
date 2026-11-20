"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { useBuildProduct } from "@/lib/workspace/useBuildProduct";
import { stackCopy } from "@/lib/workspace/segmentCopy";
import { NextChevron } from "@/components/ui/NextChevron";

type Connector = {
  tenant_id: string;
  slug: string;
  team_name: string | null;
};

type Recommendation = {
  slug: string;
  name: string;
  connected: boolean;
  rationale: string;
  agents_unlocked: string[];
  new_agents_unlocked?: string[];
  recommended: boolean;
};

export function StackInventoryCard() {
  const { buildAppIntent, companyScaleSegment } = useBuildProduct();
  const copy = stackCopy(buildAppIntent, companyScaleSegment);
  const pushConnectors = copy.showConnectorPush;

  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setLoading(false);
          return;
        }
        const { data, error } = await sb
          .from("connector_metadata")
          .select("tenant_id, slug, team_name")
          .eq("tenant_id", tenantId)
          .order("slug", { ascending: true });
        if (cancelled) return;
        if (error) {
          setLoading(false);
          return;
        }
        setConnectors((data ?? []) as Connector[]);
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!pushConnectors) return;
    const anyConnected = connectors.length > 0;
    if (anyConnected) return;
    let cancelled = false;
    setRecsLoading(true);
    (async () => {
      try {
        const res = await apiFetch("/api/connectors/recommendations");
        if (cancelled) return;
        if (!res.ok) {
          setRecsLoading(false);
          return;
        }
        const json = (await res.json()) as { recommendations?: Recommendation[] };
        if (!cancelled && Array.isArray(json.recommendations)) {
          setRecommendations(json.recommendations.slice(0, 3));
        }
        setRecsLoading(false);
      } catch {
        if (!cancelled) setRecsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, connectors, pushConnectors]);

  const anyConnected = connectors.length > 0;

  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          {copy.heading}
        </h2>
        {}
        {pushConnectors && (
          <Link
            href="/connectors"
            className="text-[12px] text-inkMuted hover:text-ink"
          >
            manage <NextChevron />
          </Link>
        )}
      </header>

      {loading ? (
        <div className="h-8 animate-pulse rounded bg-bone" />
      ) : !pushConnectors ? (
        <p className="text-[16px] leading-[1.55] text-inkMuted">{copy.emptyValueLine}</p>
      ) : anyConnected ? (
        <ul className="grid grid-cols-2 gap-2 text-[16px]">
          {connectors.map((c) => {
            return (
              <li
                key={`${c.tenant_id}:${c.slug}`}
                className="flex items-center gap-2 truncate"
                title={c.team_name ?? c.slug}
              >
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                />
                <span className="font-mono text-[13px] text-ink">{c.slug}</span>
                {c.team_name && (
                  <span className="truncate text-[13px] text-inkMuted">· {c.team_name}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : recsLoading ? (
        <div className="h-8 animate-pulse rounded bg-bone" />
      ) : recommendations.length > 0 ? (
        <ul className="space-y-3">
          {recommendations.map((r, i) => (
            <li key={`${r.slug}-${i}`} className="rounded-lg border border-ink/10 bg-[#F9F9F9] p-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <Link
                    href="/connectors"
                    className="font-mono text-[16px] font-semibold text-ink hover:underline"
                  >
                    {r.name}
                  </Link>
                  {r.recommended && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-800">
                      brain recommends
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[13px] leading-[1.55] text-ink">
                {r.rationale}
              </p>
              {r.agents_unlocked.length > 0 && (
                <p className="mt-1.5 text-[12px] text-inkMuted">
                  unlocks: {r.agents_unlocked.join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[16px] leading-[1.55] text-inkMuted">
          No connectors yet.{" "}
          <Link
            href="/connectors"
            className="text-ink underline-offset-2 hover:underline"
          >
            {copy.emptyValueLine}
          </Link>
        </p>
      )}
    </section>
  );
}
