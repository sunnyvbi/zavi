import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Briefcase,
  Code2,
  Crown,
  Info,
  LayoutGrid,
  Search,
  Shapes,
  ShoppingBag,
  Store,
  Users,
} from "lucide-react";
import {
  GROWTH_LEADERBOARD_CATEGORIES,
  START_CARD_LOCALES,
  type GrowthLeaderboardCategory,
  type GrowthLeaderboardRow,
  type StartCardLocale,
} from "@zavi/shared";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { getLeaderboard, resultPath } from "@/lib/start-card/api";
import { CountrySelect } from "./CountrySelect";
import { EmptyRow, NewPill, Placeholder, ScoreBar } from "./LeaderboardBits";
import { RemoveMySite, YourRank } from "./MyCard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Growth Leaderboard · Zavi",
  description: "Every site scored by Zavi's free growth check, ranked. Where does yours land?",
  robots: { index: false, follow: false },
};

const HEADER_CTA = { href: "/start", label: "Get started" };
const PAGE = 50;
const MAX_SHOWN = 500;
const API_CHUNK = 100;

type Params = { category?: string; country?: string; q?: string; limit?: string };

type Filters = {
  category?: GrowthLeaderboardCategory;
  country?: StartCardLocale;
  q?: string;
  limit: number;
};

const CATEGORY_KEYS = new Set<string>(GROWTH_LEADERBOARD_CATEGORIES.map((c) => c.key));
const CATEGORY_LABEL = Object.fromEntries(GROWTH_LEADERBOARD_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  GrowthLeaderboardCategory,
  string
>;

function readFilters(sp: Params | undefined): Filters {
  const category = sp?.category && CATEGORY_KEYS.has(sp.category) ? (sp.category as GrowthLeaderboardCategory) : undefined;
  const country =
    sp?.country && (START_CARD_LOCALES as readonly string[]).includes(sp.country) ? (sp.country as StartCardLocale) : undefined;
  const q = sp?.q?.trim().slice(0, 100) || undefined;
  const n = Number.parseInt(sp?.limit ?? "", 10);
  const limit = Number.isFinite(n) ? Math.min(MAX_SHOWN, Math.max(PAGE, Math.ceil(n / PAGE) * PAGE)) : PAGE;
  return { category, country, q, limit };
}

function href(f: Filters, patch: Partial<Filters>): string {
  const next = { ...f, ...patch };
  const qs = new URLSearchParams();
  if (next.category) qs.set("category", next.category);
  if (next.country) qs.set("country", next.country);
  if (next.q) qs.set("q", next.q);
  if (next.limit > PAGE) qs.set("limit", String(next.limit));
  const s = qs.toString();
  return s ? `/growth?${s}` : "/growth";
}

type Loaded =
  | { kind: "ok"; rows: GrowthLeaderboardRow[]; total: number; ranked: number }
  | { kind: "off" }
  | { kind: "error" };

async function load(f: Filters): Promise<Loaded> {
  try {
    const base = { category: f.category, country: f.country, q: f.q };
    const rows: GrowthLeaderboardRow[] = [];
    let total = 0;
    for (let offset = 0; offset < f.limit; offset += API_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      const page = await getLeaderboard({ ...base, offset, limit: Math.min(API_CHUNK, f.limit - offset) }, { cache: "no-store" });
      if (!page) return { kind: "off" };
      rows.push(...page.rows);
      total = page.total;
      if (rows.length >= total) break;
    }
    const filtered = !!(f.category || f.country || f.q);
    const all = filtered ? await getLeaderboard({ limit: 1 }, { cache: "no-store" }) : null;
    if (filtered && !all) return { kind: "off" };
    return { kind: "ok", rows, total, ranked: filtered ? all!.total : total };
  } catch {
    return { kind: "error" };
  }
}

const n = (x: number) => x.toLocaleString("en-US");

const CATEGORY_ICON: Record<GrowthLeaderboardCategory | "all", typeof LayoutGrid> = {
  all: LayoutGrid,
  ecommerce: ShoppingBag,
  saas: Code2,
  marketplace: Users,
  local: Store,
  agency: Briefcase,
  other: Shapes,
};

const MEDAL = [
  "bg-[linear-gradient(135deg,#ffe7a3,#f5c542)] text-[#6b4a00] shadow-[0_0_0_4px_rgba(245,197,66,0.18)]",
  "bg-[linear-gradient(135deg,#f3f4f6,#c9ced6)] text-[#3f454d]",
  "bg-[linear-gradient(135deg,#fde3cf,#e3a578)] text-[#6e3a14]",
];
const NO_MEDAL = "bg-[#f3f4f6] text-[#3f454d] ring-1 ring-black/[0.06]";
const medalFor = (rank: number) => MEDAL[rank - 1] ?? NO_MEDAL;

const CARD = "rounded-block border border-black/[0.08] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.04)]";

function Chip({ to, active, icon: Icon, children }: { to: string; active: boolean; icon: typeof LayoutGrid; children: React.ReactNode }) {
  const look = active
    ? "bg-[#0e0f11] text-white shadow-[0_6px_16px_-8px_rgba(14,15,17,0.6)]"
    : "border border-black/[0.08] bg-white text-[#595959] hover:-translate-y-px hover:border-black/20 hover:text-[#0e0f11]";
  return (
    <Link
      href={to}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200 ${look}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </Link>
  );
}

export default async function GrowthLeaderboardPage(props: { searchParams?: Promise<Params> }) {
  const searchParams = await props.searchParams;
  const f = readFilters(searchParams);
  const res = await load(f);
  if (res.kind === "off") notFound();

  const rows = res.kind === "ok" ? res.rows : [];
  const total = res.kind === "ok" ? res.total : 0;
  const ranked = res.kind === "ok" ? res.ranked : 0;
  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  const filtered = !!(f.category || f.country || f.q);
  const noMatch = res.kind === "ok" && filtered && rows.length === 0;

  return (
    <>
      <GrowthHeader cta={HEADER_CTA} email={null} />
      <main className="lb-anim min-h-screen bg-white text-[#0e0f11]">
        {}
        <section className="relative overflow-hidden px-4 pb-10 pt-[136px] sm:px-6">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[620px] bg-[radial-gradient(55%_55%_at_50%_0%,rgba(2,123,255,0.13),rgba(2,123,255,0.035)_55%,transparent_80%)]"
          />
          <div className="relative mx-auto max-w-[1180px]">
            <div className="mx-auto max-w-[760px] text-center [animation:lbRise_600ms_ease-out_both]">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3.5 py-1.5 text-[13px] font-semibold text-[#595959] ring-1 ring-black/[0.08] backdrop-blur">
                {res.kind === "ok" && (
                  <span aria-hidden className="relative flex h-2 w-2">
                    <span className="absolute inset-0 rounded-full bg-[#1f9d63] [animation:lbPing_1.8s_ease-out_infinite]" />
                    <span className="relative h-2 w-2 rounded-full bg-[#1f9d63]" />
                  </span>
                )}
                {res.kind === "ok" ? "Growth leaderboard · Live" : "Growth leaderboard"}
              </span>
              <h1 className="mt-5 text-balance text-[clamp(2rem,4.8vw,3.5rem)] font-bold leading-[1.08] tracking-[-0.025em]">
                Who&apos;s winning at growth{" "}
                <span className="bg-[linear-gradient(90deg,#0e0f11_0%,#027bff_45%,#0e0f11_90%)] bg-[length:200%_100%] bg-clip-text text-transparent [animation:lbSheen_6s_linear_infinite]">
                  this week
                </span>
              </h1>
              <p className="mx-auto mt-5 max-w-[60ch] text-[16px] leading-relaxed text-[#595959]">
                Every site scored by the free Zavi growth check: Google, AI answers, SEO, design and competitors.
              </p>
              <div className="mt-8 flex flex-col items-center gap-3">
                <Link
                  href="/start"
                  className="group inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[16px] font-semibold text-white shadow-[0_10px_30px_-12px_rgba(14,15,17,0.55)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-14px_rgba(14,15,17,0.6)]"
                >
                  Get your rank
                  <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
                </Link>
                <p data-testid="ranked-count" className="text-[14px] text-[#595959]">
                  {res.kind === "error" ? (
                    "We couldn't load the leaderboard right now. Try again in a moment."
                  ) : (
                    <>
                      Free. Sign in with Google to see it ·{" "}
                      {ranked === 0 ? (
                        "0 sites ranked yet"
                      ) : (
                        <>
                          <b className="font-semibold text-[#0e0f11] tabular-nums">{n(ranked)}</b> {ranked === 1 ? "site" : "sites"} ranked
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
            </div>

            <YourRank />
          </div>
        </section>

        {}
        <section className="w-full bg-[#f9f9f9] px-4 py-10 sm:px-6 lg:py-12">
          <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
            {}
            <div className="flex flex-col gap-3">
              <form action="/growth" method="get" role="search" className="flex flex-col gap-2 sm:flex-row">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-black/[0.08] bg-white py-1 pl-4 pr-1 shadow-[0_1px_2px_rgba(16,18,20,0.04)] transition-shadow focus-within:border-black/20 focus-within:shadow-[0_12px_32px_-18px_rgba(2,123,255,0.5)]">
                  <Search aria-hidden className="h-[18px] w-[18px] shrink-0 text-[#9a9a9a]" />
                  <label htmlFor="growth-find" className="sr-only">
                    Find a site
                  </label>
                  <input
                    id="growth-find"
                    name="q"
                    type="search"
                    defaultValue={f.q ?? ""}
                    maxLength={100}
                    placeholder="Find a site, e.g. yourcompany.com"
                    className="min-h-9 min-w-0 flex-1 bg-transparent px-1 text-[14px] outline-none placeholder:text-[#9a9a9a]"
                  />
                  <button
                    type="submit"
                    className="inline-flex min-h-9 shrink-0 items-center rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-opacity hover:opacity-85"
                  >
                    Search
                  </button>
                </div>
                {f.category && <input type="hidden" name="category" value={f.category} />}
                <CountrySelect value={f.country} />
              </form>
              <nav aria-label="Category" className="flex flex-wrap gap-2">
                <Chip to={href(f, { category: undefined, limit: PAGE })} active={!f.category} icon={CATEGORY_ICON.all}>
                  All
                </Chip>
                {GROWTH_LEADERBOARD_CATEGORIES.map((c) => (
                  <Chip key={c.key} to={href(f, { category: c.key, limit: PAGE })} active={f.category === c.key} icon={CATEGORY_ICON[c.key]}>
                    {c.label}
                  </Chip>
                ))}
              </nav>
              {f.q && (
                <p className="text-[13px] text-[#595959]">
                  Sites matching &ldquo;{f.q}&rdquo; ·{" "}
                  <Link href={href(f, { q: undefined, limit: PAGE })} className="font-semibold text-[#0e0f11] underline underline-offset-4">
                    Clear search
                  </Link>
                </p>
              )}
            </div>

            {noMatch ? (
              <div data-testid="no-match" className={`${CARD} flex flex-col items-center gap-3 px-6 py-12 text-center`}>
                <p className="text-[16px] font-semibold text-[#0e0f11]">
                  {f.q && !f.category && !f.country ? "No sites match this search yet." : "No sites match this filter yet."}
                </p>
                <p className="max-w-[48ch] text-[14px] text-[#595959]">Try a different filter, or scan your site to put it on the board.</p>
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  <Link
                    href="/growth"
                    className="inline-flex min-h-10 items-center rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-opacity hover:opacity-85"
                  >
                    Clear filters
                  </Link>
                  <Link
                    href="/start"
                    className="inline-flex min-h-10 items-center rounded-full border border-black/[0.08] bg-white px-4 text-[14px] font-semibold text-[#0e0f11] transition-all hover:-translate-y-px hover:border-black/20"
                  >
                    Scan your site
                  </Link>
                </div>
              </div>
            ) : (
              <>
            {}
            <div className="grid gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((i) => {
                const r = top[i];
                const gold = r?.rank === 1;
                return (
                  <div
                    key={i}
                    data-testid="podium-slot"
                    style={{ animationDelay: `${200 + i * 120}ms` }}
                    className={`group relative flex min-h-[196px] min-w-0 flex-col gap-3 overflow-hidden rounded-block bg-white p-6 [animation:lbRise_600ms_ease-out_both] ${
                      r ? "transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_24px_50px_-28px_rgba(16,18,20,0.45)]" : ""
                    } ${
                      gold
                        ? "shadow-[0_22px_50px_-30px_rgba(245,197,66,0.9)] ring-1 ring-[#f5c542]/50"
                        : "shadow-[0_1px_2px_rgba(16,18,20,0.04)] ring-1 ring-black/[0.08]"
                    }`}
                  >
                    {gold && (
                      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,231,163,0.35),transparent)]" />
                    )}
                    <span className="relative flex items-center justify-between">
                      <span
                        data-testid="podium-rank"
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-[14px] font-bold tabular-nums ${r ? medalFor(r.rank) : filtered ? NO_MEDAL : MEDAL[i]}`}
                      >
                        {gold ? (
                          <>
                            <Crown aria-hidden className="h-[18px] w-[18px]" />
                            <span className="sr-only">#{r!.rank}</span>
                          </>
                        ) : (
                          r ? `${r.rank}` : filtered ? "" : `${i + 1}`
                        )}
                      </span>
                      {r && (
                        <ArrowUpRight
                          aria-hidden
                          className="h-5 w-5 text-[#b3b3b3] transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[#0e0f11]"
                        />
                      )}
                    </span>
                    {r ? (
                      <>
                        <Link href={resultPath(r.public_id)} data-analytics="Leaderboard result" className="relative truncate text-[20px] font-bold tracking-[-0.01em] after:absolute after:inset-0">
                          {r.domain}
                        </Link>
                        <ScoreBar total={r.score.total} outOf={r.score.out_of} delay={350 + i * 120} />
                        <span className="flex flex-wrap items-center gap-2 text-[13px] text-[#595959]">
                          {CATEGORY_LABEL[r.category]}
                          {r.country ? ` · ${r.country}` : ""} <NewPill />
                        </span>
                        {r.constraint && (
                          <p className="mt-auto border-t border-black/[0.06] pt-3 text-[13px] leading-snug text-[#595959]">
                            <span className="font-semibold text-[#0e0f11]">#1 problem</span> · {r.constraint}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <Placeholder className="h-4 w-40 max-w-full" />
                        <span className="h-1.5 w-20 rounded-full bg-black/[0.05]" />
                        <span className="mt-auto text-[13px] text-[#595959]">
                          {filtered && ranked > 0 ? "Open spot." : "Open spot. Scan your site to claim it."}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {}
            <div className={`${CARD} overflow-hidden [animation:lbRise_600ms_ease-out_550ms_both]`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[14px]">
                  <thead className="border-b border-black/[0.06] text-[12px] font-semibold uppercase tracking-[0.08em] text-[#595959]">
                    <tr>
                      <th className="py-4 pl-6 pr-3">Rank</th>
                      <th className="py-4 pr-3">Site</th>
                      <th className="py-4 pr-3">Growth score</th>
                      <th className="py-4 pr-3">This week</th>
                      <th className="py-4 pr-3">Category</th>
                      <th className="py-4 pr-6">#1 problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rest.length === 0 && filtered && res.kind === "ok" ? (
                      <tr data-testid="no-more-matches">
                        <td colSpan={6} className="px-6 py-4 text-[14px] text-[#595959]">
                          No more sites match. Every match is shown above.
                        </td>
                      </tr>
                    ) : rest.length === 0
                      ? [4, 5, 6, 7, 8].map((i) => <EmptyRow key={i} rank={i} />)
                      : rest.map((r, idx) => (
                          <tr
                            key={r.public_id}
                            data-testid="leaderboard-row"
                            style={{ animationDelay: `${Math.min(650 + idx * 60, 1500)}ms` }}
                            className="group border-t border-black/[0.05] transition-colors [animation:lbRise_500ms_ease-out_both] first:border-t-0 hover:bg-[#e6f2ff]/40"
                          >
                            <td className="py-4 pl-6 pr-3 font-semibold tabular-nums">{r.rank}</td>
                            <td className="py-4 pr-3">
                              <Link href={resultPath(r.public_id)} data-analytics="Leaderboard result" className="inline-flex items-center gap-1 font-medium">
                                {r.domain}
                                <ArrowUpRight
                                  aria-hidden
                                  className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                                />
                              </Link>
                              {r.country && <span className="ml-1 text-[12px] text-[#595959]">{r.country}</span>}
                            </td>
                            <td className="py-4 pr-3">
                              <ScoreBar total={r.score.total} outOf={r.score.out_of} delay={Math.min(750 + idx * 60, 1600)} />
                            </td>
                            <td className="py-4 pr-3">
                              <NewPill />
                            </td>
                            <td className="py-4 pr-3 text-[#595959]">{CATEGORY_LABEL[r.category]}</td>
                            <td className="py-4 pr-6 text-[13px] text-[#595959]">{r.constraint ?? <span className="text-[#9a9a9a]">Not measured</span>}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] px-6 py-4 text-[14px] text-[#595959]">
                <span data-testid="showing">
                  {rows.length === 0 ? "Showing 0 of 0" : `Showing 1-${n(rows.length)} of ${n(total)}`}
                </span>
                {rows.length < total && f.limit < MAX_SHOWN ? (
                  <Link
                    href={href(f, { limit: f.limit + PAGE })}
                    scroll={false}
                    className="inline-flex min-h-10 items-center rounded-full border border-black/[0.08] bg-white px-4 font-semibold text-[#0e0f11] transition-all hover:-translate-y-px hover:border-black/20"
                  >
                    Show next 50
                  </Link>
                ) : (
                  <span className="inline-flex min-h-10 items-center rounded-full border border-black/[0.08] px-4 font-semibold opacity-40" aria-disabled="true">
                    Show next 50
                  </span>
                )}
              </div>
            </div>
              </>
            )}

            <div className="mx-auto mt-4 flex max-w-[860px] gap-3 text-[14px] leading-relaxed text-[#595959]">
              <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                <b className="text-[#0e0f11]">How this works.</b> Zavi scored each site from public data only (5 checks, 20 points each, out of 100; a
                check we couldn&apos;t measure scores 0). A site is listed once at least 3 of its 5 checks were measured,
                and shows its most recent check. Being listed does not mean the company uses Zavi. <RemoveMySite />
              </p>
            </div>
          </div>
        </section>
      </main>
      <GrowthFooter startHref="/start" />
    </>
  );
}
