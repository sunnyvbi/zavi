
import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import Link from "next/link";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import {
  OPEN_ROLES,
  APPLY_EMAIL,
  applyHref,
  generalApplyHref,
  type OpenRole,
} from "@/lib/careers";

export const metadata: Metadata = marketingPageMetadata(
  "/careers",
  "Careers | Zavi",
  "Work at Zavi. We build the AI growth agent for your business: it writes the growth plan, does the work, and reports what moved. Proven on a real company before it reached a customer.",
);

const WHAT_ITS_LIKE = [
  {
    title: "You own the whole surface",
    body: "Small team, wide scope. You take a problem from schema to shipped UI and stay on it after it ships, with no handoff to someone else's backlog.",
  },
  {
    title: "Proven on a real business",
    body: "Our agents were built against a live company with real money and real customers, not a demo dataset. The bar is what actually survives production.",
  },
  {
    title: "Short path to shipped",
    body: "No committee between you and the customer. You'll talk to the people using what you build, and ship in days rather than quarters.",
  },
];

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[#e8e8e8] bg-[#fafafa] px-3 py-1 text-[13px] font-medium leading-5 text-[#525252]">
      {children}
    </span>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-5 shrink-0 text-[#8a8a8a] transition-transform duration-200 group-open:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 7.5l5 5 5-5" />
    </svg>
  );
}

function BulletList({ heading, items }: { heading: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[14px] font-semibold leading-6 text-[#0e0f11]">
        {heading}
      </h4>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-3 text-[14px] leading-6 text-[#525252]"
          >
            <span
              className="mt-[9px] size-[5px] shrink-0 rounded-full bg-[#c4c4c4]"
              aria-hidden
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleCard({ role }: { role: OpenRole }) {
  return (
    <li id={role.slug} className="scroll-mt-28">
      <details className="group rounded-xl border border-[#ececec] bg-white transition-colors hover:border-[#d8d8d8] open:border-[#d8d8d8]">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-4 sm:p-6 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h3 className="text-[20px] font-semibold leading-7 tracking-[-0.2px] text-[#0e0f11]">
              {role.title}
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <MetaChip>{role.team}</MetaChip>
              <MetaChip>{role.location}</MetaChip>
              <MetaChip>{role.type}</MetaChip>
              {role.compensation ? (
                <MetaChip>{role.compensation}</MetaChip>
              ) : null}
            </div>
          </div>
          <Chevron />
        </summary>

        <div className="border-t border-[#f0f0f0] px-4 pb-6 pt-5 sm:px-6">
          <p className="text-[14px] leading-6 text-[#525252]">{role.summary}</p>

          <div className="mt-6 flex flex-col gap-6">
            <BulletList heading="What you'll do" items={role.whatYoullDo} />
            <BulletList heading="What we're looking for" items={role.lookingFor} />
          </div>

          <a
            href={applyHref(role)}
            className="mt-7 inline-flex items-center justify-center rounded-lg bg-[#0e0f11] px-4 py-3 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]"
          >
            Apply for {role.title}
          </a>
          <p className="mt-3 text-[13px] leading-5 text-[#8a8a8a]">
            Opens your mail app. Attach a resume and add anything you&apos;ve
            built that you&apos;re proud of.
          </p>
        </div>
      </details>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-[#dcdcdc] bg-[#fbfbfb] px-6 py-10 text-center">
      <p className="text-[16px] font-semibold leading-7 text-[#0e0f11]">
        No open roles right now.
      </p>
      <p className="mx-auto mt-2 max-w-md text-[14px] leading-6 text-[#525252]">
        We hire in bursts, and the best people usually reach out before a role
        is posted. If that&apos;s you, send us a note. We read every one.
      </p>
      <a
        href={generalApplyHref()}
        className="mt-6 inline-flex items-center justify-center rounded-lg bg-[#0e0f11] px-4 py-3 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]"
      >
        Send an open application
      </a>
    </div>
  );
}

export default async function CareersPage() {
  const { cta, email } = await resolveMarketingSession();
  const hasRoles = OPEN_ROLES.length > 0;

  return (
    <main
      className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink selection:bg-ink selection:text-white`}
    >
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      {}
      <section className="mx-auto max-w-3xl px-6 pb-4 pt-16 sm:pt-24">
        <p className="text-[16px] font-semibold uppercase tracking-[1.2px] text-[#8a8a8a]">
          Careers
        </p>
        <h1 className="mt-4 text-[38px] font-semibold leading-[1.12] tracking-[-1px] text-[#0e0f11] sm:text-[52px]">
          Come build Zavi.
        </h1>
        <p className="mt-5 max-w-2xl text-[20px] leading-7 text-[#525252]">
          We&apos;re building Zavi, the AI growth agent for your business: it
          writes the growth plan and does the growth work. It was proven on a live
          company, with real customers and real money, before it ever shipped to
          anyone else. If you like owning hard problems end to end, we should
          talk.
        </p>
      </section>

      {}
      <section
        aria-labelledby="what-its-like"
        className="mx-auto max-w-3xl px-6 pt-12 sm:pt-16"
      >
        <h2
          id="what-its-like"
          className="text-[24px] font-semibold leading-8 tracking-[-0.4px] text-[#0e0f11]"
        >
          What it&apos;s like here
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {WHAT_ITS_LIKE.map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-[#ececec] bg-[#fbfbfb] p-4"
            >
              <h3 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
                {item.title}
              </h3>
              <p className="mt-2 text-[16px] leading-[22px] text-[#525252]">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {}
      <section
        aria-labelledby="open-roles"
        className="mx-auto max-w-3xl px-6 pt-14 sm:pt-20"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="open-roles"
            className="text-[24px] font-semibold leading-8 tracking-[-0.4px] text-[#0e0f11]"
          >
            Open roles
          </h2>
          {hasRoles ? (
            <p className="text-[16px] leading-6 text-[#8a8a8a]">
              {OPEN_ROLES.length}{" "}
              {OPEN_ROLES.length === 1 ? "position" : "positions"}
            </p>
          ) : null}
        </div>

        <div className="mt-6">
          {hasRoles ? (
            <ul className="flex flex-col gap-3">
              {OPEN_ROLES.map((role) => (
                <RoleCard key={role.slug} role={role} />
              ))}
            </ul>
          ) : (
            <EmptyState />
          )}
        </div>
      </section>

      {}
      {hasRoles ? (
        <section className="mx-auto max-w-3xl px-6 pb-20 pt-14 sm:pb-28 sm:pt-20">
          <div className="rounded-xl border border-[#ececec] bg-[#fbfbfb] p-6 sm:p-8">
            <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.3px] text-[#0e0f11]">
              Nothing fits, but you want in?
            </h2>
            <p className="mt-2 max-w-xl text-[14px] leading-6 text-[#525252]">
              Tell us what you&apos;d want to own and what you&apos;ve built.
              We&apos;d rather hear from a great person early than wait for the
              right posting.
            </p>
            <a
              href={generalApplyHref()}
              className="mt-6 inline-flex items-center justify-center rounded-lg bg-[#0e0f11] px-4 py-3 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]"
            >
              Send an open application
            </a>
            <p className="mt-3 text-[13px] leading-5 text-[#8a8a8a]">
              Or email{" "}
              <a
                href={generalApplyHref()}
                className="text-[#0e0f11] underline underline-offset-2"
              >
                {APPLY_EMAIL}
              </a>
              .
            </p>
          </div>
        </section>
      ) : (
        <div className="pb-20 sm:pb-28" />
      )}

      <GrowthFooter startHref="/start" />
    </main>
  );
}
