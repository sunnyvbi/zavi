import type { Metadata } from "next";
import Link from "next/link";
import type { StartCard } from "@zavi/shared";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { GrowthCard } from "@/components/start-card/GrowthCard";
import { challengePath, getStartCard } from "@/lib/start-card/api";
import { RefreshWhileRunning } from "./RefreshWhileRunning";

export const dynamic = "force-dynamic";

type Loaded = { kind: "card"; card: StartCard } | { kind: "missing" } | { kind: "error" };

async function load(id: string): Promise<Loaded> {
  try {
    const card = await getStartCard(id, { cache: "no-store" });
    return card ? { kind: "card", card } : { kind: "missing" };
  } catch {
    return { kind: "error" };
  }
}

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const params = await props.params;
  const res = await load(params.id);
  const base: Metadata = { robots: { index: false, follow: false } };
  if (res.kind !== "card" || res.card.status === "removed" || res.card.status === "expired") {
    return { ...base, title: "Growth check · Zavi" };
  }
  const { card } = res;
  const title = card.score
    ? `${card.domain} scored ${card.score.total}/${card.score.out_of} · Zavi growth check`
    : `${card.domain} · Zavi growth check`;
  const description = "Google, AI answers, SEO, design and competitors, checked for free. What's your growth score?";
  return {
    ...base,
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

const HEADER_CTA = { href: "/start", label: "Get started" };

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-[560px] flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-[28px] font-bold tracking-tight">{title}</h1>
      <p className="text-[14px] text-inkMuted">{body}</p>
      <Link
        href="/start"
        className="flex min-h-12 items-center justify-center rounded-xl bg-[#027bff] px-6 text-[14px] font-semibold text-white"
      >
        Scan my site (free, sign in with Google)
      </Link>
    </div>
  );
}

export default async function ResultPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<{ remove?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const res = await load(params.id);

  let body: React.ReactNode;
  if (res.kind === "error") {
    body = <Notice title="We couldn't load this result" body="Something went wrong on our side. Try again in a moment." />;
  } else if (res.kind === "missing") {
    body = <Notice title="This result doesn't exist" body="Check the link, or run a growth check on your own site." />;
  } else if (res.card.status === "removed") {
    body = <Notice title="Removed at the owner's request" body="This growth check is no longer available." />;
  } else if (res.card.status === "expired") {
    body = <Notice title="This result expired, scan again" body="Growth checks are kept for 90 days." />;
  } else {
    const { card } = res;
    body = (
      <div className="mx-auto grid max-w-[1000px] items-start gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.2fr_1fr]">
        {(card.status === "running" || card.status === "queued") && <RefreshWhileRunning />}
        <GrowthCard card={card} domain={card.domain} readOnly openReport={searchParams?.remove === "1"} />
        <div className="flex flex-col gap-4 rounded-2xl border border-black/10 bg-white p-6">
          {card.score && (
            <p className="text-[13px] text-inkMuted">
              {card.domain} scored {card.score.total}/{card.score.out_of} on Zavi&apos;s growth check.
            </p>
          )}
          <h1 className="text-[24px] font-bold leading-tight tracking-tight">What&apos;s your growth score?</h1>
          <Link
            href={challengePath(card.public_id)}
            className="flex min-h-12 items-center justify-center rounded-xl bg-[#027bff] text-[14px] font-semibold text-white"
          >
            Scan my site (free, sign in with Google)
          </Link>
          <hr className="border-black/10" />
          <p className="text-[13px] text-inkMuted">
            Is this your business? Use Report / remove on the card (verified by an email to your domain). Links expire
            after 90 days.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <GrowthHeader cta={HEADER_CTA} email={null} />
      <main className="min-h-screen bg-white pt-20 text-ink">{body}</main>
      <GrowthFooter startHref="/start" />
    </>
  );
}
