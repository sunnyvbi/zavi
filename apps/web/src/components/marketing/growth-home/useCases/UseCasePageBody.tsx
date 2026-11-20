
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, MessageSquare } from "lucide-react";
import { ChannelMark, readChannelLine } from "@/components/marketing/pricingChannels";
import {
  USE_CASES,
  USE_CASES_PATH,
  pathForUseCase,
  type UseCase,
  type UseCaseChannel,
  type UseCasePlan,
} from "@/lib/marketing/useCases";
import { jakartaHeavy } from "../fonts";
import { EYEBROW, FOCUS, H2 } from "../growthUi";

function Ctas({ startHref, tone = "light" }: { startHref: string; tone?: "light" | "dark" }) {
  const dark = tone === "dark";
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Link
        href={startHref}
        prefetch={false}
        className={`inline-flex min-h-12 items-center gap-2 rounded-full px-6 text-[16px] font-semibold transition-opacity duration-200 hover:opacity-90 ${FOCUS} ${
          dark ? "bg-white text-[#0e0f11]" : "bg-[#0e0f11] text-white"
        }`}
      >
        Start free
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </Link>
      <Link
        href="/pricing"
        className={`inline-flex min-h-12 items-center rounded-full border px-6 text-[16px] font-semibold transition-colors duration-200 ${FOCUS} ${
          dark
            ? "border-white/20 text-white hover:bg-white/10"
            : "border-black/[0.1] bg-white text-[#0e0f11] hover:bg-[#f6f6f7]"
        }`}
      >
        See pricing
      </Link>
    </div>
  );
}

function ChannelChip({ c }: { c: UseCaseChannel }) {
  const { mark } = readChannelLine(c.name);
  return (
    <li
      className={`inline-flex min-h-9 items-center gap-2 rounded-full border border-black/[0.08] bg-white py-1 pl-1.5 pr-3 text-[14px] font-medium ${
        c.soon ? "text-[#6b6b6b]" : "text-[#0e0f11]"
      }`}
    >
      {mark && <ChannelMark mark={mark} />}
      {c.name}
      {c.soon && (
        <span className="rounded-full bg-[#f4f4f5] px-1.5 text-[12px] font-semibold leading-5 text-[#595959]">Soon</span>
      )}
      {c.pro && (
        <span className="rounded-full bg-[#e6f2ff] px-1.5 text-[12px] font-semibold leading-5 text-[#0258b8]">Pro</span>
      )}
    </li>
  );
}

function PlanBadge({ plan }: { plan?: UseCasePlan }) {
  const label = plan ? `${plan} plan` : "Free plan";
  const tone =
    plan === "Pro"
      ? "bg-[#e6f2ff] text-[#0258b8]"
      : plan === "Growth"
        ? "bg-[#fef3c7] text-[#92400e]"
        : plan === "Starter"
          ? "bg-[#f3e8ff] text-[#6b21a8]"
          : "bg-[#dcfce7] text-[#166534]";
  return <span className={`rounded-full px-2.5 py-1 text-[13px] font-semibold ${tone}`}>{label}</span>;
}

function Hero({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col px-4 pt-24 pb-8 sm:px-6 sm:pt-28 lg:px-12">
      <section className="relative isolate flex flex-col overflow-hidden rounded-block lg:rounded-[39px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/marketing/growth-home/hero-bg.webp')" }}
        ></div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 bg-white/25"></div>
        <div className="relative z-10 mx-auto flex w-full max-w-[860px] flex-1 flex-col items-center justify-center px-6 py-16 text-center sm:py-24">
          {children}
        </div>
      </section>
    </div>
  );
}

function ClosingBand({ startHref, title, body }: { startHref: string; title: string; body: string }) {
  return (
    <section className="bg-white px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-[1280px] overflow-hidden rounded-blockLg bg-[#0e0f11] px-6 py-20 text-center text-white lg:py-24">
        <h2
          className={`${jakartaHeavy.className} mx-auto max-w-[20ch] text-[clamp(2rem,4.2vw,3.2rem)] leading-[1.05] font-extrabold tracking-[-0.03em]`}
        >
          {title}
        </h2>
        <p className="mx-auto mt-5 max-w-[52ch] text-[20px] leading-relaxed text-white/70">{body}</p>
        <Ctas startHref={startHref} tone="dark" />
        <p className="mx-auto mt-6 max-w-[60ch] text-[14px] text-white/50">
          Free plan, no card. Build runs on Free within your credits; the organic channels need Starter or above; paid ads need Pro.
        </p>
      </div>
    </section>
  );
}

export function UseCasePageBody({ u, startHref }: { u: UseCase; startHref: string }) {
  const others = USE_CASES.filter((o) => o.slug !== u.slug);
  return (
    <>
      <Hero>
        <nav aria-label="Breadcrumb">
          <ol className="inline-flex min-h-10 items-center gap-2 rounded-full border border-black/[0.08] bg-white px-4 text-[16px] text-[#595959] shadow-[0_1px_2px_rgba(16,18,20,0.04)]">
            <li>
              <Link href={USE_CASES_PATH} className={`rounded-md transition-colors duration-200 hover:text-[#0e0f11] ${FOCUS}`}>
                Use cases
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li aria-current="page" className="inline-flex items-center gap-2 font-semibold text-[#0e0f11]">
              <u.icon aria-hidden="true" className={`h-4 w-4 ${u.color}`} />
              {u.name}
            </li>
          </ol>
        </nav>
        <h1
          className={`${jakartaHeavy.className} mt-6 text-[clamp(2.2rem,5.4vw,3.8rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-[#0e0f11]`}
        >
          {u.headline}
        </h1>
        <p className="mt-5 max-w-[62ch] text-[18px] leading-relaxed text-[#595959] sm:text-[20px]">{u.subline}</p>
        <Ctas startHref={startHref} />
        <div className="mt-10">
          <p className={EYEBROW}>Channels that matter most</p>
          <ul className="mt-3 flex flex-wrap justify-center gap-2">
            {u.channels.map((c) => (
              <ChannelChip key={c.name} c={c} />
            ))}
          </ul>
        </div>
      </Hero>

      <section className="bg-white py-16 lg:py-24">
        <div className="mx-auto grid w-full max-w-[1120px] gap-8 px-6 lg:grid-cols-[360px_1fr] lg:gap-16">
          <div>
            <p className={EYEBROW}>{u.name}</p>
            <h2 className={`mt-3 ${H2}`}>How customers find you</h2>
          </div>
          <p className="text-[20px] leading-relaxed text-[#2b2b2b] lg:pt-9">{u.findYou}</p>
        </div>
      </section>

      <section className="bg-[#f9f9f9] py-16 lg:py-24">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="max-w-[720px]">
            <h2 className={H2}>What Zavi does for you</h2>
            <p className="mt-4 text-[16px] leading-relaxed text-[#595959]">
              Zavi proposes and does the work. You approve anything that spends money or gets published.
            </p>
          </div>
          <ul className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {u.plays.map((p) => (
              <li
                key={p.title}
                data-testid="use-case-play"
                className="flex flex-col rounded-block border border-black/[0.08] bg-white p-7 shadow-[0_1px_2px_rgba(16,18,20,0.04)]"
              >
                <h3 className="text-[20px] font-bold leading-snug text-[#0e0f11]">{p.title}</h3>
                <p className="mt-2 flex-1 text-[16px] leading-relaxed text-[#595959]">{p.body}</p>
                <div className="mt-5">
                  <PlanBadge plan={p.plan} />
                </div>
              </li>
            ))}
          </ul>
          {u.reviewNote && (
            <p
              data-testid="use-case-review-note"
              className="mt-6 rounded-[16px] border border-black/[0.08] bg-white px-4 py-4 text-[14px] leading-relaxed text-[#2b2b2b]"
            >
              {u.reviewNote}
            </p>
          )}
        </div>
      </section>

      <section className="bg-white py-16 lg:py-24">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <h2 className={H2}>The number it moves</h2>
          <ul className="mt-10 grid gap-4 md:grid-cols-3">
            {u.metrics.map((m) => (
              <li key={m.label} className="rounded-block border border-[#cddbe8] bg-white p-7 shadow-[0_28px_70px_-40px_rgba(16,18,20,0.30)]">
                <p className={`${jakartaHeavy.className} text-[24px] leading-tight font-extrabold tracking-[-0.02em] text-[#0e0f11]`}>
                  {m.label}
                </p>
                <p className="mt-3 text-[16px] leading-relaxed text-[#595959]">{m.why}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bg-[#f9f9f9] py-16 lg:py-24">
        <div className="mx-auto grid w-full max-w-[1120px] gap-12 px-6 lg:grid-cols-2">
          <div>
            <h2 className={H2}>Try asking Zavi</h2>
            <p className="mt-4 text-[16px] leading-relaxed text-[#595959]">
              Type it the way you would say it. Zavi asks for what it needs.
            </p>
            <ul className="mt-8 space-y-3">
              {u.asks.map((a) => (
                <li
                  key={a}
                  className="flex items-start gap-3 rounded-[20px] border border-black/[0.08] bg-white px-4 py-4 text-[16px] leading-snug text-[#0e0f11]"
                >
                  <MessageSquare aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[#027bff]" />
                  <span>&ldquo;{a}&rdquo;</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className={H2}>What a first week looks like</h2>
            <ol className="mt-8 space-y-3">
              {u.firstWeek.map((step, i) => (
                <li
                  key={step}
                  className="flex items-start gap-4 rounded-[20px] border border-black/[0.08] bg-white px-4 py-4 text-[16px] leading-snug text-[#0e0f11]"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-[14px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {u.proof && (
        <section className="bg-white py-16 lg:py-20" data-testid="upcar-proof">
          <div className="mx-auto w-full max-w-[1120px] px-6">
            <div className="flex flex-col gap-6 rounded-[28px] border border-black/[0.08] bg-[#f0f0f0] p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-[640px]">
                <p className={EYEBROW}>Proof</p>
                <p className="mt-3 text-[26px] font-bold leading-snug text-[#0e0f11]">{u.proof.title}</p>
                <p className="mt-3 text-[16px] leading-relaxed text-[#595959]">{u.proof.body}</p>
              </div>
              <Link
                href={u.proof.href}
                className={`inline-flex min-h-11 w-fit shrink-0 items-center gap-2 rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 ${FOCUS}`}
              >
                {u.proof.cta}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      )}

      <ClosingBand
        startHref={startHref}
        title="See what Zavi would do for your business"
        body="Give Zavi your website. It audits it, writes a 30-day growth plan, and shows you the first things it would do."
      />

      <section className="bg-white px-6 pb-16">
        <div className="mx-auto max-w-[1120px]">
          <p className={EYEBROW}>Other use cases</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {others.map((o) => (
              <li key={o.slug}>
                <Link
                  href={pathForUseCase(o.slug)}
                  className={`inline-flex min-h-10 items-center gap-2 rounded-full border border-black/[0.08] px-3.5 text-[14px] font-medium text-[#0e0f11] transition-colors duration-200 hover:bg-[#f6f6f7] ${FOCUS}`}
                >
                  <o.icon aria-hidden="true" className={`h-4 w-4 ${o.color}`} />
                  {o.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

export function UseCaseIndexBody({ startHref }: { startHref: string }) {
  return (
    <>
      <Hero>
        <p className={EYEBROW}>Use cases</p>
        <h1
          className={`${jakartaHeavy.className} mt-4 text-[clamp(2.2rem,5.4vw,3.8rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-[#0e0f11]`}
        >
          Growth work for every kind of business
        </h1>
        <p className="mt-5 max-w-[60ch] text-[18px] leading-relaxed text-[#595959] sm:text-[20px]">
          Pick the one closest to yours. Each page shows how customers find that kind of business, and what Zavi does about it.
        </p>
        <Ctas startHref={startHref} />
      </Hero>

      <section className="bg-white py-12 lg:py-20">
        <ul className="mx-auto grid w-full max-w-[1200px] gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u) => (
            <li key={u.slug}>
              <Link
                href={pathForUseCase(u.slug)}
                className={`group flex h-full flex-col rounded-block border border-black/[0.08] bg-white p-7 shadow-[0_1px_2px_rgba(16,18,20,0.04)] transition-shadow duration-200 hover:shadow-[0_24px_60px_-30px_rgba(16,18,20,0.35)] ${FOCUS}`}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.06)]">
                  <u.icon aria-hidden="true" className={`h-5 w-5 ${u.color}`} />
                </span>
                <span className="mt-5 text-[20px] font-bold text-[#0e0f11]">{u.name}</span>
                <span className="mt-1 text-[14px] font-medium text-[#595959]">{u.outcome}</span>
                <span className="mt-4 flex-1 text-[16px] leading-relaxed text-[#2b2b2b]">{u.headline}</span>
                <span className="mt-5 inline-flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
                  See the plays
                  <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <ClosingBand
        startHref={startHref}
        title="Not sure which one you are?"
        body="Give Zavi your website. It works out what kind of business you run, audits the site, and writes a 30-day growth plan."
      />
    </>
  );
}
