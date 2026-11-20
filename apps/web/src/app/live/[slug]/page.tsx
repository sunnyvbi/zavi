import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Building2, CalendarRange, Gauge, OctagonX, Radio, Wallet, type LucideIcon } from "lucide-react";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ZaviMascot } from "@/components/ZaviMascot";
import { getLiveUpcar, type LiveUpcar, runEnded } from "@/lib/marketing/liveUpcar";
import { getLivePricing, liveTier } from "@/lib/marketing/pricing";
import { LiveSiteBar, LiveSiteBox } from "./_components/LiveSiteBox";
import { Countdown } from "./_components/Countdown";
import { ChannelBoard } from "./_components/ChannelBoard";
import { CHANNEL_COUNT } from "./_components/channels";
import { DayLog } from "./_components/DayLog";
import { FuelGauge, GoalBar } from "./_components/Gauges";
import { fmtDay, fmtInstant, relative, usd } from "./_components/format";
import { asOfDay, parseDayParam } from "./_components/asOfDay";
import { daysWithFigures, publishedDayNumbers } from "./_components/publishedDay";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: { params: Promise<{ slug: string }>; searchParams?: Promise<{ day?: string }> }
): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const data = await getLiveUpcar(params.slug);
  const run = data && data !== "not_found" ? data : null;
  const days = run ? runDays(run.clock) : 30;
  const ended = run ? runEnded(run.clock, Date.now()) : false;
  const gave = run ? `We gave Zavi ${usd(run.budget_usd)}, ${days} days and a real car-rental company to grow.` : "We gave Zavi a real car-rental company to grow.";
  const base = marketingPageMetadata(
    `/live/${params.slug}`,
    ended ? `Zavi ran Upcar's growth for ${days} days · Zavi` : "Zavi runs Upcar's growth, live · Zavi",
    ended ? `${gave} Zavi made the calls. See what it did.` : `${gave} Zavi makes the calls. Watch it happen.`,
  );
  return run?.run.listed && !searchParams?.day ? base : { ...base, robots: { index: false, follow: false } };
}

const runDays = (c: { start_at: string; end_at: string }) => Math.max(1, Math.round((Date.parse(c.end_at) - Date.parse(c.start_at)) / 86400000));

const RULE_ICONS: Record<string, LucideIcon> = {
  Budget: Wallet,
  "Hands off": OctagonX,
  Window: CalendarRange,
  Channels: Radio,
  "Normal pace": Gauge,
  Company: Building2,
};

function V2Section({ n, title, sub, children }: { n: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="grid gap-5 border-t border-[#0e0f11]/12 py-10 sm:py-14 lg:grid-cols-[260px_1fr] lg:gap-10">
      <div>
        <p className="text-[11px] text-[#6b7076]">{n}</p>
        <h2 className="mt-2 text-[22px] font-bold tracking-tight">{title}</h2>
        <p className="mt-1.5 max-w-[320px] text-[14px] text-[#6b7076]">{sub}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function RuleRow({ k, v }: { k: string; v: string }) {
  const Icon = RULE_ICONS[k];
  return (
    <li className="grid gap-2 border-t border-[#0e0f11]/12 py-3.5 sm:grid-cols-[180px_1fr] sm:items-center sm:gap-5">
      <span className="flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.1em] text-[#6b7076] uppercase">
        {Icon && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#0e0f11]/10 bg-white text-[#027bff]">
            <Icon className="size-3.5" aria-hidden />
          </span>
        )}
        {k}
      </span>
      <span className="text-[14px]">{v}</span>
    </li>
  );
}

function nowLine(d: LiveUpcar, nowMs: number): string {
  const rel = relative(d.now_line.last_review_at, nowMs);
  if (!rel) return "Zavi's first review is on its way.";
  const n = d.now_line.changes_today;
  if (n === 0) return `Last review ${rel}`;
  const on = d.now_line.channels_today.length ? ` on ${d.now_line.channels_today.join(" and ")}` : "";
  return `Last review ${rel} · changed ${n} ${n === 1 ? "budget" : "budgets"}${on} today`;
}

export default async function LiveRunPage(
  props: { params: Promise<{ slug: string }>; searchParams?: Promise<{ locked?: string; day?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const [{ cta, email }, fetched, pricing] = await Promise.all([
    resolveMarketingSession(),
    getLiveUpcar(params.slug, searchParams?.locked === "1"),
    getLivePricing(),
  ]);
  const starterUsd = liveTier(pricing, "starter").usd;
  if (fetched === "not_found") notFound();
  const signedIn = email !== null;
  if (fetched === null) {
    return (
      <>
        <GrowthHeader cta={cta} email={email} alwaysGlass />
        <main className="flex min-h-[70vh] shrink-0 items-center bg-[#07090d] px-4 pt-24 text-white">
          <div className="mx-auto max-w-[640px] text-center">
            <p className="font-mono text-[12px] font-bold tracking-[0.2em] text-white/60 uppercase">Zavi · live</p>
            <h1 className="mt-3 text-[28px] font-bold tracking-tight sm:text-[36px]">This page is temporarily unavailable.</h1>
            <p className="mt-3 text-[16px] text-white/70">Try again in a minute.</p>
          </div>
        </main>
        <GrowthFooter startHref={signedIn ? "/workspace" : "/start"} />
      </>
    );
  }
  const realNow = fetched.demo_now ? Date.parse(fetched.demo_now) : Date.now();
  const replayDay = parseDayParam(searchParams?.day, fetched.clock, realNow);
  const replay = replayDay === null ? null : asOfDay(fetched, replayDay, realNow);
  const data: LiveUpcar = replay?.data ?? fetched;
  const nowMs = replay?.nowMs ?? realNow;
  const { clock, locked, goals } = data;
  const nums = data.numbers;
  const budget = data.budget_usd;
  const unlockLabel = `on ${fmtInstant(clock.unlock_at)}`;
  const started = nowMs >= Date.parse(clock.start_at);
  const days = runDays(clock);
  const startLabel = fmtInstant(clock.start_at);
  const endLabel = fmtInstant(clock.end_at);
  const dayNo = started ? Math.min(days, Math.floor((nowMs - Date.parse(clock.start_at)) / 86400000) + 1) : 0;
  const perWeekToDay = (w: number | null) => (w === null || dayNo === 0 ? null : Math.round((w / 7) * dayNo));
  const ended = runEnded(clock, nowMs);
  const atPace = (x: number | null) => (x === null || dayNo === 0 || ended ? null : Math.round((x / dayNo) * days));
  const hasLockPhase = Date.parse(clock.unlock_at) > Date.parse(clock.start_at);
  const unlockDay = hasLockPhase ? Math.floor((Date.parse(clock.unlock_at) - Date.parse(clock.start_at)) / 86400000) + 1 : 0;
  const running = started && !ended;
  const statusText = !started ? `Starts ${startLabel}` : ended ? "Finished" : locked ? "Running · numbers locked" : "Live";
  const statusTone = ended
    ? { box: "border-white/20 bg-white/[0.06]", dot: "bg-white/50", text: "text-white/80" }
    : locked
      ? { box: "border-[#ffb547]/25 bg-[#ffb547]/10", dot: "bg-[#ffb547]", text: "text-[#ffb547]" }
      : { box: "border-[#ff4d4f]/25 bg-[#ff4d4f]/10", dot: "bg-[#ff4d4f]", text: "text-[#ff6b6d]" };
  const raise = data.budget_raise;
  const pageDays = replay ? [] : publishedDayNumbers(data).map((x) => x.entry.day);
  const log = (compact: boolean) => (
    <DayLog days={daysWithFigures(data)} locked={locked} compact={compact} dark={compact} startAt={clock.start_at} unlockLabel={unlockLabel} slug={replay ? undefined : params.slug} pageDays={pageDays} />
  );

  return (
    <>
      <GrowthHeader cta={cta} email={email} alwaysGlass />
      <main className="min-h-screen shrink-0 bg-white text-[#0e0f11]">
        {}
        <section className="relative overflow-hidden bg-[#07090d] pt-20 text-white md:pt-[100px]">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:40px_40px]" />
          <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[900px] max-w-[200vw] -translate-x-1/2 rounded-full bg-[#027bff]/25 blur-[120px]" />
          <div className="relative mx-auto grid max-w-[1480px] gap-8 px-4 pt-6 pb-10 sm:px-6 sm:pt-8 sm:pb-12 lg:grid-cols-[minmax(0,1.25fr)_minmax(400px,1fr)] lg:px-8">
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-bold tracking-[0.2em] uppercase sm:text-[13px] ${statusTone.box}`}>
                    <span className="relative flex h-2.5 w-2.5">
                      {!ended && <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping ${statusTone.dot}`} />}
                      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusTone.dot}`} />
                    </span>
                    <span className={statusTone.text}>{statusText}</span>
                    {started && <span className="text-white/70">· Day {dayNo}/{days}</span>}
                  </div>
                  <h1 className="mt-3 text-[28px] leading-[1.05] font-bold tracking-tight sm:text-[40px] lg:text-[34px] xl:text-[40px]">
                    We handed Upcar&apos;s growth
                    <br />
                    to an AI.
                    <br />
                    <span className="bg-gradient-to-r from-[#5aa9ff] to-[#b18cff] bg-clip-text text-transparent">{usd(budget)}. {days} days. In public.</span>
                  </h1>
                  <p className="mt-3 max-w-[560px] text-[14px] leading-relaxed text-white/75 sm:text-[16px]">
                    {ended
                      ? "Zavi ran growth for Upcar, a real car-rental marketplace. It picked the channels, wrote the ads and moved the budget. The scoreboard below is the real one."
                      : <>Zavi is running growth for Upcar, a real car-rental marketplace. It picks the channels, writes the ads and moves the budget. We&apos;re not steering it, and the scoreboard below is the real one.</>}
                  </p>
                </div>
                <div className="shrink-0 drop-shadow-[0_0_40px_rgba(2,123,255,0.55)]">
                  <span className="sm:hidden"><ZaviMascot size={84} working={running} /></span>
                  <span className="hidden sm:inline"><ZaviMascot size={112} working={running} /></span>
                </div>
              </div>

              <div className="mt-5 sm:mt-4">
                <Countdown clock={clock} serverNow={nowMs} endLabel={endLabel} simulated={!!data.demo_now || replay !== null} compact />
              </div>

              <div className="mt-6">
                <div className="grid gap-[2px] sm:gap-1" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }} aria-label={started ? `Day ${dayNo} of ${days}` : `${days} days`}>
                  {Array.from({ length: days }, (_, i) => (
                    <span key={i} className={`h-2 rounded-[2px] ${i < dayNo - 1 || ended ? "bg-white/80" : i === dayNo - 1 ? "bg-[#027bff] shadow-[0_0_10px_#027bff] motion-safe:animate-pulse" : i === unlockDay - 1 ? "bg-[#ffb547]/70" : "bg-white/12"}`} />
                  ))}
                </div>
                <div className="relative mt-1.5 h-4 font-mono text-[11px] tracking-wider text-white/50 uppercase sm:text-[12px]">
                  <span className="absolute left-0">{startLabel}</span>
                  {hasLockPhase && (
                    <span className="absolute text-[#ffb547]/90" style={{ left: `${((unlockDay - 0.5) / days) * 100}%`, transform: "translateX(-50%)" }}>Numbers public</span>
                  )}
                  <span className="absolute right-0">{endLabel}</span>
                </div>
              </div>

              <div className="mt-6 grid gap-6 border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm sm:grid-cols-2 sm:gap-x-10 sm:gap-y-6 sm:p-6">
                <div className="sm:col-span-2">
                  <FuelGauge budget={budget} raisedOn={raise?.on ?? null} ended={ended} spent={nums?.spent_usd ?? null} perDay={nums?.spend_per_day_recent_usd ?? null} runsOutDay={nums?.runs_out_day ?? null} locked={locked || !nums} unlockLabel={unlockLabel} />
                </div>
                {goals.booking_value_usd !== null && (
                  <div className="sm:col-span-2">
                    <GoalBar label="Bookings ($)" ended={ended} fmt={usd} soFar={nums?.booking_value_usd ?? null} goal={goals.booking_value_usd} pace={perWeekToDay(nums?.pace.booking_value_per_week ?? null)} atPace={atPace(nums?.booking_value_usd ?? null)} locked={locked || !nums} unlockLabel={unlockLabel} />
                  </div>
                )}
                {}
                {goals.bookings !== null && (
                  <GoalBar label="Bookings" ended={ended} soFar={nums?.bookings ?? null} goal={goals.bookings} pace={perWeekToDay(nums?.pace.bookings_per_week ?? null)} atPace={atPace(nums?.bookings ?? null)} locked={locked || !nums} unlockLabel={unlockLabel} />
                )}
                {goals.hosts !== null && (
                  <GoalBar label="New hosts" ended={ended} soFar={nums?.hosts ?? null} goal={goals.hosts} pace={perWeekToDay(nums?.pace.hosts_per_week ?? null)} atPace={atPace(nums?.hosts ?? null)} locked={locked || !nums} unlockLabel={unlockLabel} />
                )}
                <p className="font-mono text-[11px] text-white/50 sm:col-span-2">
                  {days}-day {goals.booking_value_usd !== null && goals.bookings === null && goals.hosts === null ? "goal" : "goals"} set before day 1, before spending anything · {goals.booking_value_usd !== null ? "Bookings ($) = total price of every trip booked, not profit · " : ""}{data.bookings_estimate_factor > 2 ? `Bookings and their normal pace include a ×${data.bookings_estimate_factor} estimate for bookings Upcar's data feed misses · ` : ""}Normal pace = Upcar&apos;s average over the 4 weeks before {startLabel}
                </p>
              </div>

              <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between xl:gap-5">
                <LiveSiteBox slug={params.slug} starterUsd={starterUsd} />
                <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] font-semibold tracking-[0.14em] text-white/70 uppercase sm:text-[13px]">
                  <li>{usd(budget)} to spend</li>
                  <li>{days} days</li>
                  <li className="text-[#ff6b6d]">Zavi makes the calls</li>
                  <li>Daily log in public</li>
                </ul>
              </div>

              {!replay && !ended && (
                <p className="mt-6 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4 text-[13px] text-white/70 sm:text-[14px]">
                  <span className="font-bold tracking-[0.18em] text-[#5aa9ff] uppercase">Zavi now</span>
                  <span className="text-white">{nowLine(data, nowMs)}</span>
                </p>
              )}
            </div>

            <aside className="hidden min-w-0 self-start lg:block">
              <div className="flex max-h-[calc(100vh-160px)] min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-white backdrop-blur-sm">
                <div className="border-b border-white/10 px-4 pt-4 pb-3">
                  <p className="text-[11px] text-white/40">01</p>
                  <h2 className="mt-1 text-[20px] font-bold tracking-tight">Mission log</h2>
                  <p className="mt-0.5 text-[13px] text-white/55">One entry a day in Zavi&apos;s words: what it tried, why, and the budgets it moved.</p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4">{log(true)}</div>
              </div>
            </aside>
          </div>
        </section>

        <div className="bg-white pb-24 text-[#0e0f11] sm:pb-6">
          <div className="mx-auto max-w-[1120px] px-4 sm:px-6">
            <div className="lg:hidden">
              <V2Section n="01" title="Mission log" sub="One entry a day, in Zavi's words: what it tried, why, and the budgets it moved.">
                {log(false)}
              </V2Section>
            </div>
            <V2Section n="02" title="The rules of the bet" sub="What we agreed to before day 1.">
              <ul className="border-b border-[#0e0f11]/12">
                {[
                  ["Budget", raise ? `${usd(raise.start_usd)} of real ad money to start, ${usd(budget)} since ${fmtDay(raise.on)}. Zavi decides where it goes.` : `${usd(budget)} of real ad money for the whole run. Zavi decides where it goes.`],
                  ["Hands off", "We won't pause it or override it. If a person ever steps in, it goes in the mission log."],
                  ["Window", `${days} days, ${startLabel} to ${endLabel}.${Date.parse(clock.unlock_at) > Date.parse(clock.start_at) ? ` Numbers public ${unlockLabel}.` : ""}`],
                  ["Channels", `Zavi can work across all ${CHANNEL_COUNT} channels below. It places ads and moves budget only on the accounts Upcar has connected; on the rest it researches and drafts.`],
                  ["Normal pace", `Upcar's average over the 4 weeks before ${startLabel}.`],
                  ["Company", "Upcar, a car rental marketplace. Upcar is run by Zavi's founder, so the money and the results are real."],
                ].map(([k, v]) => (
                  <RuleRow key={k} k={k} v={v} />
                ))}
              </ul>
            </V2Section>
            <V2Section n="03" title={`${CHANNEL_COUNT} growth channels, one Zavi`} sub="Where your account is connected, Zavi acts: it places ads, moves budgets and posts. Everywhere else it researches and drafts the work for you. Point at a channel to see how it helps.">
              <ChannelBoard />
            </V2Section>
          </div>
        </div>

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#07090d]/95 p-3 backdrop-blur sm:hidden">
          <LiveSiteBar slug={params.slug} />
        </div>
      </main>
      <GrowthFooter startHref={signedIn ? "/workspace" : "/start"} />
    </>
  );
}
