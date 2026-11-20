"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useHumanResource } from "@/components/humans/useHumanResource";
import { apiFetch } from "@/lib/api";
import type {
  CreatorFilterLabels,
  CreatorFilterOptions,
  CreatorResultsNotes,
  CreatorSearchResponse,
  CreatorSearchResult,
  FilterOption,
} from "@/lib/creator-storefront";
import {
  FindFilterBar,
  NO_FILTERS,
  activeCount,
  filtersFromParams,
  filtersToParams,
  matchesLocally,
  rememberFindParams,
  searchPath,
  type FindFilters,
} from "./FindFilters";
import { openIntroVideo } from "@/lib/creator/introVideo";
import { useUgcDrawer } from "./hub";
import { BTN_SECONDARY, CreatorCard, CreatorCardSkeleton, DrawerNote, SideDrawer } from "./ui";
import { primeCreatorCards, useCreatorCards } from "./useCards";
import type { CreatorCardData } from "./types";
import { useCreatorUnread } from "./unread";

const NO_OPTIONS: CreatorFilterOptions = {
  platforms: [],
  niches: [],
  lanes: [],
  max_price_cents: [],
  max_delivery_days: [],
  min_followers: [],
  countries: [],
};

const noop = () => {};

const FULL_ROWS = 12;

const PAGE = 100;

const MAX_OFFSET = 10_000;

type Cursor = {
  memberNext: number;
  membersMore: boolean;
  inviteNext: number;
  invitesMore: boolean;
  invitesFailed: boolean;
};

type MorePages = Cursor & { path: string; pages: { creators: CreatorSearchResult[]; invited: CreatorSearchResult[] }[]; invited: CreatorSearchResult[] };

export function firstCursor(first: CreatorSearchResponse): Cursor {
  const failed = !!first.invited_page?.failed;
  return {
    memberNext: PAGE,
    membersMore: !!first.page?.has_more,
    inviteNext: failed ? 0 : PAGE,
    invitesMore: failed || !!first.invited_page?.has_more,
    invitesFailed: failed,
  };
}

export function nextCursor(cur: Cursor, page: CreatorSearchResponse): { cursor: Cursor; creators: CreatorSearchResult[]; invited: CreatorSearchResult[] } {
  const cursor = { ...cur };
  let creators: CreatorSearchResult[] = [];
  let invited: CreatorSearchResult[] = [];
  if (cur.membersMore) {
    creators = page.creators ?? [];
    cursor.memberNext = cur.memberNext + PAGE;
    cursor.membersMore = !!page.page?.has_more && cursor.memberNext <= MAX_OFFSET;
  }
  if (cur.invitesMore) {
    if (page.invited_page?.failed) {
      cursor.invitesFailed = true;
    } else {
      invited = page.invited ?? [];
      cursor.inviteNext = cur.inviteNext + PAGE;
      cursor.invitesMore = !!page.invited_page?.has_more && cursor.inviteNext <= MAX_OFFSET;
      cursor.invitesFailed = false;
    }
  }
  return { cursor, creators, invited };
}

function uniqueById(list: CreatorSearchResult[]): CreatorSearchResult[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.human_member_id) && (seen.add(c.human_member_id), true));
}

const FULL_ROW = "col-span-full";

function inviteCard(c: CreatorSearchResult): CreatorCardData {
  return {
    human_member_id: c.human_member_id,
    slug: null,
    display_name: c.display_name,
    city: null,
    country_code: null,
    bio: null,
    lanes: [],
    niches: [],
    has_intro_video: false,
    photo_url: null,
    illustration_url: null,
    bookable: false,
    socials: c.handles.map((h) => ({ platform: h.platform, handle: h.handle, url: h.url ?? null, followers: h.followers ?? null, label: h.label })),
    packages: [],
    rating: { average: null, count: 0 },
    invited: true,
    status_label: c.status_label,
  };
}

export function FindDrawer({ under = false }: { under?: boolean } = {}) {
  const drawer = useUgcDrawer();
  const urlKey = JSON.stringify(filtersToParams(filtersFromParams(drawer.params)));
  const [filters, setFiltersState] = useState<FindFilters>(() => filtersFromParams(drawer.params));
  const written = useRef(urlKey);
  useEffect(() => {
    rememberFindParams(filtersToParams(filtersFromParams(drawer.params)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);
  useEffect(() => {
    if (urlKey === written.current) return;
    written.current = urlKey;
    setFiltersState(filtersFromParams(drawer.params));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);
  const { replace } = drawer;
  const setFilters = useCallback(
    (next: FindFilters) => {
      setFiltersState(next);
      const params = filtersToParams(next);
      written.current = JSON.stringify(params);
      rememberFindParams(params);
      replace("find", params);
    },
    [replace],
  );
  const path = searchPath(filters);
  const search = useHumanResource<CreatorSearchResponse>(path);
  const [more, setMore] = useState<MorePages | null>(null);
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const currentPath = useRef(path);
  currentPath.current = path;
  const latestMore = useRef(0);
  const extra = more?.path === path ? more : null;
  const cursor: Cursor | null = extra ?? (search.data ? firstCursor(search.data) : null);
  const hasMore = !!cursor && (cursor.membersMore || cursor.invitesMore);
  const loadingMore = loadingFor === path;
  const moreFailed = failedFor === path;
  async function loadMore() {
    if (!cursor || loadingMore) return;
    const cur = cursor;
    const mine = ++latestMore.current;
    const fresh = () => mine === latestMore.current && currentPath.current === path;
    setLoadingFor(path);
    setFailedFor(null);
    try {
      const res = await apiFetch(`${path}&offset=${cur.memberNext}&invited_offset=${cur.inviteNext}`);
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as CreatorSearchResponse;
      if (!fresh()) return;
      const next = nextCursor(cur, page);
      setMore((prev) => {
        const base = prev?.path === path ? prev : null;
        return {
          path,
          ...next.cursor,
          pages: [...(base?.pages ?? []), { creators: next.creators, invited: next.invited }],
          invited: [...(base?.invited ?? []), ...next.invited],
        };
      });
    } catch {
      if (fresh()) setFailedFor(path);
    } finally {
      if (mine === latestMore.current) setLoadingFor(null);
    }
  }
  const invited = uniqueById([...(search.data?.invited ?? []), ...(extra?.invited ?? [])]);
  primeCreatorCards(invited.map(inviteCard));
  const orderPage = (members: CreatorSearchResult[], invites: CreatorSearchResult[]) => [
    ...(filters.order === "newest" && !filters.lane
      ? [...members.filter((c) => c.lanes.includes("ugc_video")), ...members.filter((c) => !c.lanes.includes("ugc_video"))]
      : members),
    ...invites,
  ];
  const ordered = uniqueById([
    ...orderPage(search.data?.creators ?? [], search.data?.invited ?? []),
    ...(extra?.pages ?? []).flatMap((p) => orderPage(p.creators, p.invited)),
  ]);
  const cards = useCreatorCards(ordered.map((c) => c.human_member_id).filter(Boolean));
  const shown = ordered.filter((c) => c.human_member_id && matchesLocally(c, filters, cards[c.human_member_id]?.bio ?? null));
  const drawn = shown.filter((c) => cards[c.human_member_id] !== null);
  const rows = hasMore && drawn.length >= FULL_ROWS ? drawn.slice(0, drawn.length - (drawn.length % FULL_ROWS)) : drawn;
  const ids = rows.map((c) => c.human_member_id);
  const first = search.data;
  const total =
    !(filters.keyword.trim() || filters.minFollowers) && first && !first.page?.has_more && typeof first.invited_total === "number"
      ? first.creators.length + first.invited_total
      : null;
  const unread = useCreatorUnread();
  const localOnly = !!filters.keyword.trim() || !!filters.minFollowers;
  const partial = localOnly && hasMore;

  const searching = search.loading;
  const filtered = activeCount(filters) > 0;

  const lastOptions = useRef<{
    options: CreatorFilterOptions | null;
    orders: FilterOption[];
    labels: CreatorFilterLabels | null;
    notes: CreatorResultsNotes | null;
  }>({ options: null, orders: [], labels: null, notes: null });
  if (search.data) {
    lastOptions.current = {
      labels: search.data.filter_labels ?? lastOptions.current.labels,
      notes: search.data.results_notes ?? lastOptions.current.notes,
      options: search.data.filter_options ?? lastOptions.current.options ?? NO_OPTIONS,
      orders: search.data.order_options ?? lastOptions.current.orders,
    };
  }

  return (
    <SideDrawer title="Find creators" onClose={under ? noop : drawer.close} fullPage>
      <div className="mx-auto w-full max-w-[1400px]">
      {}

      <FindFilterBar
        value={filters}
        onChange={setFilters}
        options={lastOptions.current.options}
        orders={lastOptions.current.orders}
        labels={lastOptions.current.labels}
        notes={lastOptions.current.notes}
        ready={!!search.data || !!search.error || search.notBuilt || search.sessionExpired}
        shown={total ?? ids.length}
        scanned={partial ? ordered.length : null}
        loading={search.loading}
        orderLabel={search.data?.order_label ?? ""}
        neutralityNote={search.data?.neutrality_note ?? null}
        selfReportedNote={search.data?.self_reported_note ?? null}
        aside={
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            Book and pay on Zavi to keep your payment protected.
          </span>
        }
      />

      <div
        aria-busy={search.loading}
        className="mt-4 grid gap-4 [@container(min-width:608px)]:grid-cols-2 [@container(min-width:992px)]:grid-cols-3 [@container(min-width:1504px)]:grid-cols-4"
      >
        {searching ? (
          Array.from({ length: FULL_ROWS }, (_, i) => <CreatorCardSkeleton key={i} />)
        ) : search.error || search.notBuilt || search.sessionExpired ? (
          <div className={FULL_ROW}>
            <DrawerNote>Couldn&apos;t load creators just now.</DrawerNote>
          </div>
        ) : ids.length === 0 && partial ? (
          <div className={`${FULL_ROW} rounded-xl border border-dashed border-rule px-4 py-8 text-center`}>
            <p className="text-[14px] text-inkMuted">
              No match in the first {ordered.length} creators. Load more creators to keep looking.
            </p>
          </div>
        ) : ids.length === 0 && filtered ? (
          <div className={`${FULL_ROW} rounded-xl border border-dashed border-rule px-4 py-8 text-center`}>
            <p className="text-[14px] text-inkMuted">No creators match these filters.</p>
            <button type="button" onClick={() => setFilters({ ...NO_FILTERS, order: filters.order })} className={`${BTN_SECONDARY} mt-3`}>
              Clear filters
            </button>
          </div>
        ) : ids.length === 0 ? (
          <div className={FULL_ROW}>
            <DrawerNote>No creators on Zavi match yet. Write your own brief and creators who fit can apply to you.</DrawerNote>
          </div>
        ) : (
          ids.map((id) => {
            const card = cards[id];
            if (card === undefined) return <CreatorCardSkeleton key={id} />;
            if (card === null) return null;
            return (
              <CreatorCard
                key={id}
                creator={card}
                onBook={(pid) => drawer.open("hire", { package: pid })}
                onMessage={() => drawer.open("thread", { creator: id, over: "find" })}
                onPlayIntro={() => openIntroVideo(`/api/humans/creators/${encodeURIComponent(id)}/intro-video`, card.display_name)}
                unread={unread[id] ?? 0}
              />
            );
          })
        )}
      </div>
      {!searching && !search.error && !search.notBuilt && !search.sessionExpired && hasMore && (
        <div className="mt-5 flex flex-col items-center gap-2">
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={BTN_SECONDARY}>
            {loadingMore ? "Loading…" : "Load more creators"}
          </button>
          {moreFailed ? (
            <p className="text-[13px] text-inkMuted">Couldn&apos;t load more creators. Try again.</p>
          ) : cursor?.invitesFailed ? (
            <p className="text-[13px] text-inkMuted">Some invited creators couldn&apos;t load. Load more to try again.</p>
          ) : null}
        </div>
      )}
      </div>
    </SideDrawer>
  );
}
