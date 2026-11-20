"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CREATOR_MARKETPLACE_ENABLED, isCreatorVideoChannel, type CreatorVideoChannel } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { HumanBriefsResponse, HumanBrief } from "@/components/humans/humanTypes";
import type { CreatorJobDetail, CreatorJobsResponse, CreatorJobSummary } from "@/components/humans/creatorJobTypes";
import type { BriefWorkbenchResponse } from "@/components/humans/humanPostedBriefs";
import type { CreatorSearchResponse, CreatorSearchResult } from "@/lib/creator-storefront";
import type { LibraryAsset } from "@/components/humans/CreatorLibraryIsland";
import { UGC_BRIEFS_CHANGED_EVENT, useUgcDrawer } from "./hub";
import { activeDismissals, dismissalId, readCreatorDismissals, restoreCreatorDismissal, storeCreatorDismissal, type CreatorDismissal } from "./creatorCardDismissals";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { createBrowserSupabase } from "@/lib/supabase";
import { CreatorActionCard } from "./CreatorActionCard";
import {
  cheapestFittingPackage,
  onePerKind,
  assetIsReady,
  orderFacts,
  perVideoCents,
  ugcHubCards,
  ugcHubNumbers,
  videoChannelCards,
  staticCreatorCards,
  type BriefFacts,
  type BudgetHint,
  type CreatorCard,
  type OrderFacts,
} from "./creatorCards";

export { channelHref } from "./channelHref";
export { BookPane, cheapestVideoPackage } from "./creatorPanes";

type Rows = {
  briefs: HumanBrief[];
  jobs: CreatorJobSummary[];
  library: LibraryAsset[];
  creators: CreatorSearchResult[];
  briefFacts: Record<string, BriefFacts>;
  orders: Record<string, OrderFacts>;
  budget: BudgetHint;
  jobsOk: boolean;
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function loadBudgetHint(creators?: CreatorSearchResult[]): Promise<BudgetHint> {
  const list =
    creators ?? (await readJson<CreatorSearchResponse>("/api/humans/creators/search?order=newest&lane=ugc_video"))?.creators ?? [];
  const bookable = list
    .filter((c) => c.bookable && c.human_member_id && (c.from_price_cents ?? 0) > 0)
    .sort((a, b) => (a.from_price_cents ?? 0) - (b.from_price_cents ?? 0))
    .slice(0, BUDGET_CREATORS_READ);
  let best: NonNullable<BudgetHint> | null = null;
  for (const [i, creator] of bookable.entries()) {
    const pkg = cheapestFittingPackage(
      (creator.packages ?? []).map((p) => ({ ...p, price_cents: p.pricing.price_cents })),
    );
    if (!pkg) continue;
    const hint = {
      creator: bookable[i].display_name,
      human_member_id: bookable[i].human_member_id,
      price_cents: pkg.price_cents,
      package_title: pkg.title,
      video_count: pkg.video_count ?? 1,
    };
    if (!best || perVideoCents(hint) < perVideoCents(best)) best = hint;
  }
  return best;
}

const BUDGET_CREATORS_READ = 10;

async function loadRows(slug: string, isUgc: boolean): Promise<Rows | null> {
  const [b, j, l, s] = await Promise.all([
    readJson<HumanBriefsResponse>("/api/humans/briefs"),
    isUgc ? readJson<CreatorJobsResponse>("/api/humans/orders") : Promise.resolve(null),
    readJson<{ assets: LibraryAsset[] }>("/api/creators/library"),
    readJson<CreatorSearchResponse>("/api/humans/creators/search?order=newest&lane=ugc_video"),
  ]);
  if (!Array.isArray(b?.briefs) || !Array.isArray(l?.assets)) return null;
  const briefs = b.briefs;
  const jobs = j?.jobs ?? [];
  const library = l.assets;
  const creators = s?.creators ?? [];

  const drafts = isUgc ? briefs.filter((x) => !x.posted_at && !x.closed_at) : [];
  const orderIds = [
    ...new Set<string>([
      ...(isUgc ? jobs.filter((x) => x.status === "submitted").map((x) => x.id) : []),
      ...library.filter((a) => isUgc || (a.source_channel === slug && assetIsReady(a, new Date()))).map((a) => a.order_id).filter(Boolean),
    ]),
  ];
  const [benches, details, budget] = await Promise.all([
    Promise.all(drafts.map((d) => readJson<BriefWorkbenchResponse>(`/api/humans/briefs/${encodeURIComponent(d.id)}/workbench`))),
    Promise.all(orderIds.map((id) => readJson<CreatorJobDetail>(`/api/humans/orders/${encodeURIComponent(id)}`))),
    isUgc ? Promise.resolve(null) : loadBudgetHint(creators),
  ]);
  const briefFacts: Record<string, BriefFacts> = {};
  benches.forEach((w, i) => {
    if (!w) return;
    const brief = w.brief as typeof w.brief & { evidence?: unknown };
    briefFacts[drafts[i].id] = {
      business_name: w.creator_preview.business_name,
      evidence: Array.isArray(brief.evidence) ? (brief.evidence as BriefFacts["evidence"]) : [],
      rationale: brief.rationale,
    };
  });
  const orders: Record<string, OrderFacts> = {};
  orderIds.forEach((id, i) => {
    const d = details[i];
    if (d) orders[id] = orderFacts({ package_snapshot: d.package_snapshot, submissions: d.submissions });
  });
  return {
    briefs,
    jobs,
    library,
    creators,
    briefFacts,
    orders,
    budget,
    jobsOk: Array.isArray(j?.jobs),
  };
}

export type CreatorHiringCards = {
  cards: ReactNode[];
  more: ReactNode[];
  metrics: ChannelMetric[];
  settled: boolean;
  notice: string | null;
  kinds: string[];
  reload: () => void;
};

export function useCreatorHiringCards(slug: string, enabled: boolean = CREATOR_MARKETPLACE_ENABLED): CreatorHiringCards {
  const isUgc = slug === "ugc";
  const video: CreatorVideoChannel | null = isCreatorVideoChannel(slug) ? slug : null;
  const needsRows = enabled && (isUgc || video !== null);
  const statics = enabled ? staticCreatorCards(slug) : [];
  const active = needsRows;
  const drawer = useUgcDrawer();
  const [rows, setRows] = useState<Rows | null>(null);
  const [settled, setSettled] = useState(!needsRows);
  const [hidden, setHidden] = useState<CreatorDismissal[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const back = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", back);
    };
  }, [enabled, reload]);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(UGC_BRIEFS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(UGC_BRIEFS_CHANGED_EVENT, reload);
  }, [enabled, reload]);
  const drawerKey = drawer.name;

  const [tenant, setTenant] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      setTenant(null);
      setHidden([]);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const waits = [300, 1_000, 3_000];
    const resolve = (attempt: number) => {
      void Promise.resolve()
        .then(() => getActiveTenantId(createBrowserSupabase()))
        .catch(() => null)
        .then((id) => {
          if (!alive) return;
          if (id !== null || attempt === 0) {
            setTenant(id);
            setHidden(readCreatorDismissals(id));
          }
          if (id === null && attempt < waits.length) {
            timer = window.setTimeout(() => resolve(attempt + 1), waits[attempt]);
          }
        });
    };
    resolve(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  useEffect(() => {
    const deadlines = hidden.flatMap(entry => typeof entry === "string" ? [] : [entry.until]);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setHidden(entries => activeDismissals(entries)), Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now())));
    return () => window.clearTimeout(timer);
  }, [hidden]);
  useEffect(() => {
    setRows(null);
    setSettled(!needsRows);
  }, [slug, needsRows]);
  useEffect(() => {
    if (!needsRows) return;
    let alive = true;
    void loadRows(slug, isUgc).then((r) => {
      if (!alive) return;
      setRows(r);
      setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, [needsRows, isUgc, slug, drawerKey, tick]);

  const [recent, setRecent] = useState<Record<string, string>>({});
  const hide = useCallback((card: CreatorCard, label: string) => {
    setHidden((h) => storeCreatorDismissal(tenant ?? null, h, card.id, card.dismissForDays));
    setRecent((r) => ({ ...r, [card.id]: label }));
  }, [tenant]);
  const unhide = useCallback((card: CreatorCard) => {
    setHidden((h) => restoreCreatorDismissal(tenant ?? null, h, card.id));
    setRecent((r) => Object.fromEntries(Object.entries(r).filter(([id]) => id !== card.id)));
  }, [tenant]);

  if (!active || !settled || tenant === undefined || (needsRows && !rows))
    return { reload, cards: [], more: [], metrics: [], settled: (settled && tenant !== undefined) || !active,
      notice: active && settled && tenant !== undefined && needsRows && !rows ? "Could not load your creator briefs or videos. Reload the page to try again." : null, kinds: [] };

  const fromRows = !rows
    ? []
    : isUgc
      ? ugcHubCards({
          briefs: rows.briefs,
          jobs: rows.jobs,
          library: rows.library,
          bookable: rows.creators.filter((c) => c.bookable).length,
          briefFacts: rows.briefFacts,
          orders: rows.orders,
        })
      : videoChannelCards(video as CreatorVideoChannel, {
          briefs: rows.briefs,
          library: rows.library,
          budget: rows.budget,
          orders: rows.orders,
        });
  const hiddenIds = new Set(activeDismissals(hidden).map(dismissalId));
  const all = [...fromRows, ...statics].filter((c) => !hiddenIds.has(c.id) || recent[c.id]);
  const { shown, rest } = onePerKind(all);

  const render = (c: CreatorCard) => (
    <CreatorActionCard
      key={c.id}
      slug={slug}
      card={c}
      asset={rows?.library.find((a) => c.primary.target.kind === "push" && a.id === c.primary.target.assetId) ?? null}
      bookable={c.bookPane && rows ? rows.creators.filter((x) => x.bookable).slice(0, 2) : []}
      settled={hiddenIds.has(c.id) ? recent[c.id] ?? null : null}
      onHide={(label) => hide(c, label)}
      onUndo={() => unhide(c)}
      onChanged={reload}
    />
  );

  const day = new Date().toISOString().slice(0, 10);
  const metrics: ChannelMetric[] =
    isUgc && rows?.jobsOk
      ? ugcHubNumbers({ briefs: rows.briefs, jobs: rows.jobs, library: rows.library, orders: rows.orders }).map((m) => ({
          ...m,
          value: m.value ?? 0,
          grounded: true,
          window_kind: null,
          day,
          prev_value: null,
          prev_day: null,
        }))
      : [];

  const jobsNotice =
    isUgc && rows && !rows.jobsOk
      ? "Could not load your creator jobs just now, so a video to review or a job in progress may be missing here. Reload the page to try again."
      : null;
  return {
    reload,
    notice: jobsNotice,
    settled: true,
    metrics,
    cards: shown.map(render),
    more: rest.map(render),
    kinds: shown.map((c) => c.kind),
  };
}
