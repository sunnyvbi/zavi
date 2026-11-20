import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { jakartaHeavy } from "@/components/marketing/growth-home/fonts";
import { CREATOR_JOIN_HREF, CREATOR_SIGNIN_HREF, PRIMARY, SECONDARY } from "./shared";

const TITLE = `${jakartaHeavy.className} text-[clamp(2.4rem,6vw,4.25rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-[#0e0f11]`;

export function CreatorHero({ creatorArea = null }: { creatorArea?: { href: string; label: string } | null }) {
  return (
    <section data-creator-hero className="relative isolate w-full overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/marketing/growth-home/hero-bg.webp')", backgroundSize: "calc(100% + 120px) calc(100% + 120px)" }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 bg-white/25" />

      <div className="relative z-10 mx-auto flex max-w-[860px] flex-col items-center px-6 pt-32 pb-14 text-center sm:pt-36 sm:pb-20">
        <p className="mb-5 text-[14px] font-bold tracking-[0.14em] text-[#46658a] uppercase">Zavi for creators</p>

        <h1 className={TITLE}>
          Make videos for businesses.
          <br />
          <span className="relative inline-block">
            <span className="relative z-[1]">Get paid for each one.</span>
            <span
              aria-hidden="true"
              className="absolute inset-x-[-0.1em] bottom-[0.08em] -z-0 h-[0.36em] rounded-[4px] bg-[#bedeff]/70"
            />
          </span>
        </h1>

        <p className="mt-6 max-w-[560px] text-[20px] leading-relaxed font-medium text-[#595959] sm:text-[21px]">
          You set your prices. Businesses book you inside Zavi, and you get paid through Stripe.
        </p>

        <div className="mt-9 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
          <Link href={creatorArea ? creatorArea.href : CREATOR_JOIN_HREF} className={PRIMARY}>
            {creatorArea ? creatorArea.label : "Join as a creator"}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          {creatorArea ? null : (
            <Link href={CREATOR_SIGNIN_HREF} className={SECONDARY}>
              Sign in
            </Link>
          )}
        </div>
        {creatorArea ? null : <p className="mt-4 text-[14px] text-[#6b6b6b]">Free to join. No bank details until your first job.</p>}
      </div>
    </section>
  );
}
