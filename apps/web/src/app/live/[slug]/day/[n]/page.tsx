import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { jakarta } from "@/fonts";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { getLiveUpcar, budgetOn, runEnded } from "@/lib/marketing/liveUpcar";
import { getLivePricing, liveTier } from "@/lib/marketing/pricing";
import { ArticleStructuredData, BreadcrumbStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ZaviMascot } from "@/components/ZaviMascot";
import { LiveSiteBox } from "../../_components/LiveSiteBox";
import { fmtDay, usd } from "../../_components/format";
import { budgetLine, dayPath, KIND_LABEL } from "../../_components/dayCopy";
import { dayDates, publishedDay, publishedDayNumbers, runDayCount, type PublishedDayPage } from "../../_components/publishedDay";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string; n: string }> };

function describe(page: PublishedDayPage): string {
  const e = page.entry;
  const f = page.figures;
  const facts: string[] = [];
  if (f.spent_usd !== null) facts.push(`spent ${usd(f.spent_usd)}`);
  if (f.hosts !== null && f.bookings !== null) facts.push(`${f.hosts} new hosts and ${f.bookings} bookings`);
  const lead = e.why ?? e.headline;
  const tail = facts.length ? ` That day: ${facts.join(", ")}.` : "";
  return `Day ${page.n} of Zavi running Upcar's growth in public. ${lead}${tail}`.slice(0, 300);
}

export async function generateMetadata(props: Params): Promise<Metadata> {
  const params = await props.params;
  const data = await getLiveUpcar(params.slug);
  if (data === null) return { title: "Zavi runs Upcar's growth, live · Zavi", robots: { index: false, follow: false } };
  if (data === "not_found") return {};
  const page = publishedDay(data, params.n);
  if (!page) return {};
  const days = runDayCount(data.clock);
  const path = dayPath(params.slug, page.n);
  const base = marketingPageMetadata(
    path,
    `Day ${page.n} of ${days}: ${page.entry.headline} · Zavi runs Upcar's growth`,
    describe(page),
    { url: `${path}/opengraph-image`, alt: `Day ${page.n} of ${days}: ${page.entry.headline}` },
  );
  return data.run.listed ? base : { ...base, robots: { index: false, follow: false } };
}

export default async function LiveDayPage(props: Params) {
  const params = await props.params;
  const [{ cta, email }, data, pricing] = await Promise.all([
    resolveMarketingSession(),
    getLiveUpcar(params.slug),
    getLivePricing(),
  ]);
  if (data === "not_found") notFound();
  if (data === null) throw new Error("live_backend_unavailable");
  const page = publishedDay(data, params.n);
  if (!page) notFound();

  const e = page.entry;
  const f = page.figures;
  const days = runDayCount(data.clock);
  const path = dayPath(params.slug, page.n);
  const all = publishedDayNumbers(data);
  const dates = dayDates(e);
  const ended = runEnded(data.clock, Date.now());
  const startHref = email !== null ? "/workspace" : "/start";
  const starterUsd = liveTier(pricing, "starter").usd;

  return (
    <main className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-[#0e0f11]`}>
      <BreadcrumbStructuredData
        trail={[
          { name: "Zavi runs Upcar's growth, live", path: `/live/${params.slug}` },
          { name: `Day ${page.n}`, path },
        ]}
      />
      <ArticleStructuredData
        path={path}
        headline={`Day ${page.n}: ${e.headline}`}
        description={describe(page)}
        datePublished={dates.published}
        dateModified={dates.modified}
      />
      <GrowthHeader cta={cta} email={email} alwaysGlass />

      <section className="bg-[#07090d] px-4 pt-28 pb-10 text-white sm:px-6 sm:pt-32">
        <div className="mx-auto max-w-[860px]">
          <nav aria-label="Breadcrumb" className="font-mono text-[12px] text-white/60">
            <a href={`/live/${params.slug}`} className="underline underline-offset-4 hover:text-white">
              {ended ? "Zavi ran Upcar's growth" : <>Zavi runs Upcar&apos;s growth, live</>}
            </a>
            <span aria-hidden> / </span>
            <span>Day {page.n}</span>
          </nav>
          <p className="mt-5 flex flex-wrap items-center gap-3 font-mono text-[12px] font-semibold tracking-[0.12em] uppercase">
            <span className="text-[#5aa9ff]">
              Day {page.n} of {days}
            </span>
            <span className="text-white/60">{fmtDay(e.day)}</span>
            <span className="border border-white/30 px-1.5 py-[1px] text-white/80">{KIND_LABEL[e.kind]}</span>
          </p>
          <h1 className="mt-3 text-[28px] leading-tight font-bold tracking-tight sm:text-[38px]">{e.headline}</h1>
          <p className="mt-4 max-w-[680px] text-[15px] text-white/70 sm:text-[16px]">
            Zavi was given {usd(budgetOn(data, e.day))} and {days} days to grow Upcar, a real car-rental marketplace, and it makes the calls itself. This is its log for day {page.n}, in its own words.
          </p>
          <dl className="mt-7 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10">
            <Stat label="Ad spend that day" value={f.spent_usd === null ? null : usd(f.spent_usd)} />
            <Stat label="New hosts" value={f.hosts === null ? null : `+${f.hosts}`} />
            <Stat label="Bookings" value={f.bookings === null ? null : `+${f.bookings}`} />
          </dl>
          <p className="mt-3 font-mono text-[11px] text-white/50">
            Upcar&apos;s totals for {fmtDay(e.day)}. Bookings = trips booked, not profit.
            {data.bookings_estimate_factor > 2 ? ` Bookings include a ×${data.bookings_estimate_factor} estimate for bookings Upcar's data feed misses.` : ""}
          </p>
        </div>
      </section>

      <section className="px-4 py-10 sm:px-6 sm:py-14">
        <div className="mx-auto grid max-w-[860px] gap-10 sm:grid-cols-[1.2fr_1fr]">
          <div>
            <h2 className="font-mono text-[12px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">What Zavi did</h2>
            {e.work.length ? (
              <ol className="mt-3 flex flex-col gap-3 text-[15px] text-[#3a3d42]">
                {e.work.map((w, i) => (
                  <li key={`${i}-${w}`} className="flex gap-3">
                    <span className="w-4 shrink-0 font-mono text-[12px] leading-[24px] text-[#6b7076]">{i + 1}</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-[15px] text-[#6b7076]">Watched the numbers.</p>
            )}
            <h2 className="mt-8 font-mono text-[12px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Why</h2>
            {e.why ? (
              <div className="mt-3 flex gap-3">
                <span className="shrink-0 pt-0.5">
                  <ZaviMascot size={28} />
                </span>
                <p className="text-[15px] leading-relaxed">{e.why}</p>
              </div>
            ) : (
              <p className="mt-3 text-[15px] text-[#6b7076]">No reason recorded.</p>
            )}
          </div>
          <div>
            <h2 className="font-mono text-[12px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Budget changes</h2>
            {e.budget.length === 0 ? (
              <p className="mt-3 text-[15px] text-[#6b7076]">None. No money moved.</p>
            ) : (
              <ul className="mt-3 border-b border-[#0e0f11]/12">
                {e.budget.map((b, i) => (
                  <li key={`${b.channel}-${i}`} className="flex items-baseline justify-between gap-3 border-t border-[#0e0f11]/12 py-2.5 text-[15px]">
                    <span>{b.channel}</span>
                    <span className="text-right font-mono text-[12px] whitespace-nowrap">{budgetLine(b)}</span>
                  </li>
                ))}
              </ul>
            )}
            {e.channels.length > 0 && (
              <p className="mt-5 font-mono text-[12px] text-[#6b7076]">Channels: {e.channels.join(" · ")}</p>
            )}
          </div>
        </div>

        <nav aria-label="Days" className="mx-auto mt-12 flex max-w-[860px] flex-wrap items-center justify-between gap-3 border-t border-[#0e0f11]/12 pt-6 text-[14px] font-semibold">
          {page.prev !== null ? (
            <a href={dayPath(params.slug, page.prev)} className="underline underline-offset-4">
              ← Day {page.prev}
            </a>
          ) : (
            <span />
          )}
          <a href={`/live/${params.slug}`} className="underline underline-offset-4">
            {ended ? "The scoreboard" : "The live scoreboard"}
          </a>
          {page.next !== null ? (
            <a href={dayPath(params.slug, page.next)} className="underline underline-offset-4">
              Day {page.next} →
            </a>
          ) : (
            <span />
          )}
        </nav>

        {all.length > 1 && (
          <div className="mx-auto mt-8 max-w-[860px]">
            <h2 className="font-mono text-[12px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Every day so far</h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {all.map(({ n }) => (
                <li key={n}>
                  {n === page.n ? (
                    <span aria-current="page" className="inline-block rounded-md border border-[#0e0f11] px-2.5 py-1 font-mono text-[12px] font-bold">
                      Day {n}
                    </span>
                  ) : (
                    <a href={dayPath(params.slug, n)} className="inline-block rounded-md border border-[#0e0f11]/20 px-2.5 py-1 font-mono text-[12px] hover:border-[#0e0f11]">
                      Day {n}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="bg-[#07090d] px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-[860px]">
          <LiveSiteBox slug={params.slug} starterUsd={starterUsd} />
        </div>
      </section>
      <GrowthFooter startHref={startHref} />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-[#07090d] px-3 py-3 sm:px-4">
      <dt className="font-mono text-[10px] font-semibold tracking-[0.1em] text-white/50 uppercase sm:text-[11px]">{label}</dt>
      <dd className="mt-1 text-[20px] font-bold sm:text-[24px]">{value ?? "n/a"}</dd>
    </div>
  );
}
