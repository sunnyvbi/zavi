"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, MessageSquare, Play, Star } from "lucide-react";
import { money } from "../../ugc/hub";
import { nicheLabel } from "@/lib/creator/packageSpec";
import type { CreatorCardData, CreatorCardPackage } from "./types";
import { NextChevron } from "@/components/ui/NextChevron";

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function IntroTile({
  name,
  hasVideo,
  photoUrl = null,
  illustrationUrl = null,
  size = "md",
}: {
  name: string;
  hasVideo: boolean;
  photoUrl?: string | null;
  illustrationUrl?: string | null;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "w-[54px]" : "w-[88px]";
  if (photoUrl) {
    return (
      <div className={`relative aspect-[9/16] ${box} shrink-0 overflow-hidden rounded-xl bg-creamDeep`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimisable asset */}
        <img src={photoUrl} alt={`${name}'s photo`} className="h-full w-full object-cover" loading="lazy" />
      </div>
    );
  }
  if (hasVideo) {
    return (
      <div
        className={`relative flex aspect-[9/16] ${box} shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#1f2937] to-[#0e0f11] text-white`}
        aria-label={`${name} intro video`}
      >
        <span className={`flex items-center justify-center rounded-full bg-cream/90 ${size === "sm" ? "size-6" : "size-9"}`}>
          <Play className={`${size === "sm" ? "h-3 w-3" : "h-4 w-4"} text-ink`} aria-hidden="true" />
        </span>
      </div>
    );
  }
  if (illustrationUrl) {
    return (
      <div className={`relative aspect-[9/16] ${box} shrink-0 overflow-hidden rounded-xl bg-creamDeep`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimisable asset */}
        <img src={illustrationUrl} alt={`Illustration for ${name}'s niches`} className="h-full w-full object-cover" loading="lazy" />
        <span
          className={`absolute inset-x-1 bottom-1 rounded-md bg-cream/90 text-center font-semibold text-inkMuted ${
            size === "sm" ? "text-[7px] leading-[12px]" : "text-[9px] leading-[16px]"
          }`}
        >
          Illustration
        </span>
      </div>
    );
  }
  return (
    <div
      className={`flex aspect-[9/16] ${box} shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-ink/[0.15] bg-creamDeep px-1 text-center`}
      aria-label={`${name} has no intro video yet`}
    >
      <span className={`font-bold text-inkMuted ${size === "sm" ? "text-[13px]" : "text-[20px]"}`}>{initials(name)}</span>
      <span className={`leading-tight text-inkMuted ${size === "sm" ? "text-[8px]" : "text-[11px]"}`}>No intro video yet</span>
    </div>
  );
}

export function RatingBadge({ rating }: { rating: CreatorCardData["rating"] }) {
  return rating.count > 0 && rating.average !== null ? (
    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink">
      <Star className="h-3.5 w-3.5 fill-[#946300] text-amber-600" aria-hidden="true" />
      {rating.average} ({rating.count} {rating.count === 1 ? "review" : "reviews"})
    </span>
  ) : (
    <span className="rounded-full bg-[#027bff]/10 px-2 py-0.5 text-[12px] font-semibold text-[#027bff]">No reviews yet</span>
  );
}

const PLATFORM: Record<string, { name: string; bg: string; text: string }> = {
  tiktok: { name: "TikTok", bg: "bg-ink", text: "Tk" },
  instagram: { name: "Instagram", bg: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]", text: "IG" },
  youtube: { name: "YouTube", bg: "bg-[#ff0000]", text: "" },
  x: { name: "X", bg: "bg-ink", text: "X" },
  linkedin: { name: "LinkedIn", bg: "bg-[#0a66c2]", text: "in" },
};
export const platformName = (p: string) => PLATFORM[p]?.name ?? p.charAt(0).toUpperCase() + p.slice(1);

const PLATFORM_LOGO: Record<string, { src: string; bg: string; fit: "cover" | "contain" }> = {
  tiktok: { src: "/logos/tiktok-channel.svg", bg: "bg-black", fit: "cover" },
  instagram: { src: "/logos/instagram-channel.svg", bg: "bg-logo", fit: "contain" },
  youtube: { src: "/logos/youtube-channel.svg", bg: "bg-logo", fit: "contain" },
  x: { src: "/logos/twitter-channel.svg", bg: "bg-black", fit: "cover" },
  linkedin: { src: "/logos/linkedin-channel.svg", bg: "bg-channel-linkedin", fit: "cover" },
};

export function PlatformIcon({ platform, className = "size-5 rounded-md" }: { platform: string; className?: string }) {
  const logo = PLATFORM_LOGO[platform];
  if (!logo) {
    const m = PLATFORM[platform] ?? { bg: "bg-zinc-500", text: platform.charAt(0).toUpperCase() };
    return (
      <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center text-[9px] leading-none font-bold text-white ${m.bg} ${className}`}>
        {m.text}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${logo.bg} ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static brand mark */}
      <img src={logo.src} alt="" className={logo.fit === "cover" ? "h-full w-full object-cover" : "h-[72%] w-[72%] object-contain"} />
    </span>
  );
}

export function Audience({ creator, compact = false }: { creator: CreatorCardData; compact?: boolean }) {
  if (creator.socials.length === 0) return null;
  return (
    <div>
      <ul className="grid gap-1">
        {creator.socials.map((s) => {
          const handle = s.platform === "linkedin" ? s.handle : `@${s.handle}`;
          return (
            <li
              key={`${s.platform}:${s.handle}`}
              className={`flex items-center gap-x-2 text-[14px] text-ink ${compact ? "min-w-0 flex-nowrap" : "flex-wrap gap-y-0.5"}`}
            >
              <PlatformIcon platform={s.platform} />
              <span title={handle} className={`font-semibold ${compact ? "min-w-0 truncate" : ""}`}>
                {handle}
              </span>
              {s.followers !== null && (
                <span className={`text-inkMuted ${compact ? "shrink-0" : ""}`}>{s.followers.toLocaleString("en-US")} followers</span>
              )}
              {s.url && (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`View on ${platformName(s.platform)}`}
                  className={`inline-flex items-center gap-1 text-[13px] font-medium text-[#027bff] underline-offset-4 hover:underline ${compact ? "shrink-0" : ""}`}
                >
                  {compact ? <span className="sr-only">View on {platformName(s.platform)}</span> : <>View on {platformName(s.platform)}</>}
                  <ExternalLink className={compact ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className={`mt-0.5 text-[12px] text-inkMuted ${compact ? "truncate" : ""}`}>Follower numbers: {creator.socials[0].label}</p>
    </div>
  );
}

export function laneLabels(c: CreatorCardData): string[] {
  const out: string[] = [];
  if (c.lanes.includes("ugc_video")) out.push("UGC video");
  return out;
}

export function termsLine(p: CreatorCardPackage): string {
  const n = p.video_count ?? 1;
  const parts = [`${n} UGC ${n > 1 ? "videos" : "video"}`];
  if (p.video_length_seconds) parts.push(`${p.video_length_seconds}s`);
  if (p.ad_rights_days) parts.push(`ad rights ${p.ad_rights_days} days`);
  parts.push(`delivered in ${p.delivery_days} days`);
  parts.push("2 rounds of changes");
  return parts.join(" · ");
}

export function CreatorSummary({ creator }: { creator: CreatorCardData }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl bg-creamDeep p-3">
      <IntroTile
        name={creator.display_name}
        hasVideo={creator.has_intro_video}
        photoUrl={creator.photo_url}
        illustrationUrl={creator.illustration_url}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <RatingBadge rating={creator.rating} />
          <span className="text-[13px] text-inkMuted">{laneLabels(creator).join(" · ")}</span>
        </div>
        <div className="mt-1.5">
          <Audience creator={creator} />
        </div>
        {creator.packages.length > 0 && (
          <>
            <p className="mt-2 text-[11px] font-bold tracking-[0.12em] text-inkMuted uppercase">Packages</p>
            <ul className={`mt-1 grid gap-1 ${creator.packages.length > 3 ? "max-h-[84px] scrollbar-visible overflow-y-auto overscroll-contain pr-1" : ""}`}>
              {creator.packages.map((p) => (
                <li key={p.id} className="text-[13px] text-inkSoft">
                  <span className="font-semibold text-ink">
                    {p.title}, {money(p.price_cents)}
                  </span>{" "}
                  · {termsLine(p)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

const BOOK =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full bg-ink px-3 text-[13px] font-semibold whitespace-nowrap text-cream hover:opacity-90";
const MESSAGE =
  "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-rule bg-cream px-4 text-[14px] font-semibold text-inkSoft hover:bg-creamDeep";
const MESSAGE_UNREAD =
  "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-[#027bff] bg-[#027bff]/10 px-4 text-[14px] font-semibold text-[#027bff] hover:bg-[#027bff]/15";

const compactCount = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

function Cover({ c, onPlayIntro }: { c: CreatorCardData; onPlayIntro?: () => void }) {
  const tags: string[] = [];
  if (!c.photo_url && c.illustration_url) tags.push("Illustration");
  if (c.has_intro_video) tags.push("Intro video");
  return (
    <>
      {c.photo_url || c.illustration_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimisable asset
        <img
          src={(c.photo_url ?? c.illustration_url) as string}
          alt={c.photo_url ? `${c.display_name}'s photo` : `Illustration for ${c.display_name}'s niches`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#2b3442] to-[#11141a] pb-10">
          <span className="text-[30px] font-bold tracking-wide text-white/85">{initials(c.display_name)}</span>
        </div>
      )}
      {tags.length > 0 && (
        <div className="absolute top-2.5 right-2.5 flex gap-2">
          {tags.map((t) =>
            t === "Intro video" && onPlayIntro ? (
              <button
                key={t}
                type="button"
                onClick={onPlayIntro}
                aria-label={`Play ${c.display_name}'s intro video in a new tab`}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm px-2.5 py-1 text-[12px] font-semibold shadow-sm hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Play className="h-3 w-3 fill-white text-white" aria-hidden="true" />
                Play intro
              </button>
            ) : (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm px-2 py-0.5 text-[12px] font-semibold">
                {t === "Intro video" ? <Play className="h-3 w-3 fill-white text-white" aria-hidden="true" /> : null}
                {t}
              </span>
            ),
          )}
        </div>
      )}
    </>
  );
}

export function shortTerms(p: CreatorCardPackage): string {
  const parts: string[] = [];
  if (p.video_length_seconds) parts.push(`${p.video_length_seconds}s`);
  if (p.ad_rights_days) parts.push(`ad rights ${p.ad_rights_days}d`);
  parts.push(`${p.delivery_days} ${p.delivery_days === 1 ? "day" : "days"}`);
  return parts.join(" · ");
}

function PackageRow({ p, bookable, onBook }: { p: CreatorCardPackage; bookable: boolean; onBook: (id: string) => void }) {
  const total = money(p.business_total_cents);
  return (
    <div className="h-full min-w-0 rounded-xl border border-ink/[0.08] bg-creamDeep px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p title={termsLine(p)} className="min-w-0 truncate text-[14px] font-semibold text-ink">
          {p.title}
        </p>
        <p className="shrink-0 text-[14px] leading-5 font-bold tabular-nums text-ink">{money(p.price_cents)}</p>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p title={termsLine(p)} className="min-w-0 truncate text-[12px] text-inkMuted">
          {shortTerms(p)}
        </p>
        {bookable ? (
          <button
            type="button"
            onClick={() => onBook(p.id)}
            title={`You pay ${total} with Zavi's 10% fee`}
            aria-label={`Book ${p.title}, you pay ${total} with Zavi's 10% fee`}
            className={BOOK}
          >
            Book · <span className="tabular-nums">{total}</span>
            <NextChevron />
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-inkMuted">You pay {total}</span>
        )}
      </div>
    </div>
  );
}

function PackageCarousel({ c, onBook }: { c: CreatorCardData; onBook: (id: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const pkgs = [...c.packages].sort((x, y) => x.price_cents - y.price_cents);
  const n = pkgs.length;
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onScroll = () => setAt(Math.min(n - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(1, el.clientWidth)))));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [n]);
  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const next = Math.min(n - 1, Math.max(0, i));
    el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
    setAt(next);
  };
  const arrow =
    "inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-rule bg-cream text-ink hover:bg-bone disabled:cursor-default disabled:opacity-35";
  return (
    <div role="region" aria-roledescription="carousel" aria-label={`Packages from ${c.display_name}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold tracking-[0.06em] text-inkMuted uppercase">
          {n > 1 ? `${n} packages · from ${money(pkgs[0].price_cents)}` : "Package"}
        </p>
        {n > 1 && (
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="text-[12px] tabular-nums text-inkMuted">
              {at + 1} of {n}
            </span>
            <button type="button" aria-label="Previous package" disabled={at === 0} onClick={() => go(at - 1)} className={arrow}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" aria-label="Next package" disabled={at === n - 1} onClick={() => go(at + 1)} className={arrow}>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div ref={track} className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain">
        {pkgs.map((p, i) => (
          <div
            key={p.id}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${n}`}
            className="w-full shrink-0 snap-start"
          >
            <PackageRow p={p} bookable={c.bookable} onBook={onBook} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CreatorCardSkeleton() {
  const bone = "block animate-pulse bg-bone motion-reduce:animate-none";
  return (
    <div role="status" aria-live="polite" className="flex">
      <span className="sr-only">Loading a creator.</span>
      <div aria-hidden="true" className="flex w-full flex-col overflow-hidden rounded-2xl border border-ink/[0.07] bg-cream shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <span className={`${bone} aspect-[16/9] w-full`} />
        <div className="flex flex-1 flex-col gap-2 p-3.5">
          <span className={`${bone} h-3.5 w-36 rounded-md`} />
          <div className="flex gap-2">
            <span className={`${bone} h-5 w-16 rounded-full`} />
            <span className={`${bone} h-5 w-14 rounded-full`} />
          </div>
          <span className={`${bone} h-3.5 w-11/12 rounded-md`} />
          <div className="mt-auto flex flex-col gap-2 pt-1">
            <div className="flex items-center justify-between gap-2">
              <span className={`${bone} h-3 w-20 rounded-md`} />
              <div className="flex items-center gap-2">
                <span className={`${bone} h-3 w-10 rounded-md`} />
                <span className={`${bone} size-9 rounded-full`} />
                <span className={`${bone} size-9 rounded-full`} />
              </div>
            </div>
            <div className="rounded-xl border border-rule bg-creamDeep px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className={`${bone} h-3.5 w-2/3 rounded-md`} />
                <span className={`${bone} h-4 w-9 rounded-md`} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <span className={`${bone} h-3 w-40 rounded-md`} />
                <span className={`${bone} h-8 w-24 rounded-full`} />
              </div>
            </div>
            <span className={`${bone} h-9 w-full rounded-full`} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SocialPills({ c }: { c: CreatorCardData }) {
  if (c.socials.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {c.socials.map((s) => {
        const handle = s.platform === "linkedin" ? s.handle : `@${s.handle}`;
        const title = s.followers !== null
          ? `${handle}: ${s.followers.toLocaleString("en-US")} followers on ${platformName(s.platform)}, self-reported`
          : `${handle} on ${platformName(s.platform)}`;
        const inner = (
          <>
            <PlatformIcon platform={s.platform} className="size-[18px] rounded-full" />
            <span className="truncate">{s.followers !== null ? compactCount(s.followers) : handle}</span>
            {}
            {s.followers !== null && <span className="sr-only"> followers, self-reported</span>}
          </>
        );
        const cls = "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-ink/[0.12] py-0.5 pr-2 pl-0.5 text-[12px] font-semibold text-ink";
        return s.url ? (
          <a key={`${s.platform}:${s.handle}`} href={s.url} target="_blank" rel="noopener noreferrer" title={title} className={`${cls} hover:bg-creamDeep`}>
            {inner}
            <ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            <span className="sr-only">View {handle} on {platformName(s.platform)} (opens in a new tab)</span>
          </a>
        ) : (
          <span key={`${s.platform}:${s.handle}`} title={title} className={cls}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}

function InvitedNote() {
  return (
    <p className="text-[13px] leading-[18px] text-inkMuted">
      Not on Zavi yet. A message sends them an email to join; booking opens once they do.
    </p>
  );
}

function CoverFoot({ c, meta }: { c: CreatorCardData; meta: string }) {
  return (
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-3 pt-8 pb-2.5">
      <div className="flex items-center gap-2">
        <h2 title={c.display_name} className="min-w-0 truncate text-[16.5px] leading-6 font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]">
          {c.display_name}
        </h2>
        {c.invited ? null : c.rating.count > 0 && c.rating.average !== null ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-white">
            <Star className="h-3.5 w-3.5 fill-[#f5b301] text-[#f5b301]" aria-hidden="true" />
            {c.rating.average}
            <span className="font-normal text-white/80">({c.rating.count})</span>
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm px-2 py-0.5 text-[11px] font-semibold">No reviews yet</span>
        )}
      </div>
      {meta && (
        <p title={meta} className="mt-0.5 truncate text-[13px] font-medium text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]">
          {meta}
        </p>
      )}
    </div>
  );
}

const NICHE_CHIP = "shrink-0 rounded-full border border-ink/[0.12] px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-inkSoft";
const NICHE_MORE = "shrink-0 rounded-full border border-ink/[0.12] px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap text-inkSoft";
const NICHE_GAP = 8;
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Niches({ c }: { c: CreatorCardData }) {
  const box = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(c.niches.length);
  const key = c.niches.join("|");
  useBeforePaint(() => {
    const el = box.current;
    const r = ruler.current;
    if (!el || !r) return;
    const fit = () => {
      const chips = Array.from(r.children) as HTMLElement[];
      const more = chips.pop()?.offsetWidth ?? 0;
      const room = el.clientWidth;
      let used = 0;
      let n = 0;
      for (let i = 0; i < chips.length; i++) {
        const w = chips[i].offsetWidth + (i > 0 ? NICHE_GAP : 0);
        const rest = chips.length - (i + 1);
        if (used + w + (rest > 0 ? NICHE_GAP + more : 0) > room) break;
        used += w;
        n = i + 1;
      }
      setShown(n);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  if (c.niches.length === 0) return null;
  const extra = c.niches.length - shown;
  return (
    <div ref={box} className="relative flex flex-nowrap gap-2 overflow-hidden">
      {c.niches.slice(0, shown).map((n) => (
        <span key={n} className={NICHE_CHIP}>
          {nicheLabel(n)}
        </span>
      ))}
      {extra > 0 && (
        <span title={c.niches.slice(shown).map(nicheLabel).join(", ")} className={NICHE_MORE}>
          +{extra}
        </span>
      )}
      <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute top-0 left-0 flex gap-2">
        {c.niches.map((n) => (
          <span key={n} className={NICHE_CHIP}>
            {nicheLabel(n)}
          </span>
        ))}
        <span className={NICHE_MORE}>+{c.niches.length}</span>
      </div>
    </div>
  );
}

export function CreatorProfileCard({
  creator: c,
  onBook,
  onPlayIntro,
}: {
  creator: CreatorCardData;
  onBook: (packageId: string) => void;
  onPlayIntro?: () => void;
}) {
  const place = [c.city, c.country_code].filter(Boolean).join(", ");
  const meta = c.invited ? "" : [place, ...laneLabels(c)].filter(Boolean).join(" · ");
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-ink/[0.07] bg-cream shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:flex-row">
      <div className="relative aspect-[16/9] w-full shrink-0 overflow-hidden bg-creamDeep sm:aspect-auto sm:min-h-[210px] sm:w-[220px]">
        <Cover c={c} onPlayIntro={c.has_intro_video ? onPlayIntro : undefined} />
        <CoverFoot c={c} meta={meta} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <SocialPills c={c} />
        <Niches c={c} />
        {c.bio && (
          <p title={c.bio} className="line-clamp-2 break-words text-[14px] leading-[20px] text-inkMuted">
            {c.bio}
          </p>
        )}
        <div className="mt-auto flex flex-col gap-2 pt-1">
          {c.invited ? (
            <InvitedNote />
          ) : c.packages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-rule px-3 py-3 text-center text-[13px] text-inkMuted">No packages yet. Send a custom offer below.</p>
          ) : (
            <PackageCarousel c={c} onBook={onBook} />
          )}
          {!c.bookable && !c.invited && (
            <p className="rounded-lg border border-ink/12 bg-ink/[0.04] px-3 py-2 text-[12px] text-inkMuted">
              Zavi cannot pay creators in this creator&apos;s country yet, so they cannot be booked.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

export function CreatorProfileCardSkeleton() {
  const bone = "block animate-pulse bg-bone motion-reduce:animate-none";
  return (
    <div aria-hidden="true" className="flex flex-col overflow-hidden rounded-2xl border border-ink/[0.07] bg-cream sm:flex-row">
      <span className={`${bone} aspect-[16/9] w-full shrink-0 sm:aspect-auto sm:min-h-[210px] sm:w-[220px]`} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <span className={`${bone} h-3.5 w-36 rounded-md`} />
        <div className="flex gap-2">
          <span className={`${bone} h-5 w-16 rounded-full`} />
          <span className={`${bone} h-5 w-14 rounded-full`} />
        </div>
        <span className={`${bone} h-3.5 w-11/12 rounded-md`} />
        <div className="mt-auto flex flex-col gap-2 pt-1">
          <span className={`${bone} h-3 w-20 rounded-md`} />
          <div className="rounded-xl border border-rule bg-creamDeep px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className={`${bone} h-3.5 w-2/3 rounded-md`} />
              <span className={`${bone} h-4 w-9 rounded-md`} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className={`${bone} h-3 w-40 rounded-md`} />
              <span className={`${bone} h-8 w-24 rounded-full`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CreatorCard({
  creator: c,
  onBook,
  onMessage,
  onPlayIntro,
  unread = 0,
}: {
  creator: CreatorCardData;
  onBook: (packageId: string) => void;
  onMessage: () => void;
  onPlayIntro?: () => void;
  unread?: number;
}) {
  const place = [c.city, c.country_code].filter(Boolean).join(", ");
  const meta = c.invited ? "" : [place, ...laneLabels(c)].filter(Boolean).join(" · ");
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-ink/[0.07] bg-cream shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-creamDeep">
        <Cover c={c} onPlayIntro={c.has_intro_video ? onPlayIntro : undefined} />
        <CoverFoot c={c} meta={meta} />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <SocialPills c={c} />
        <Niches c={c} />
        {c.bio && (
          <p title={c.bio} className="line-clamp-2 break-words text-[14px] leading-[20px] text-inkMuted">
            {c.bio}
          </p>
        )}

        {}
        <div className="mt-auto flex flex-col gap-2 pt-1">
          {c.invited ? (
            <InvitedNote />
          ) : c.packages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-rule px-3 py-3 text-center text-[13px] text-inkMuted">No packages yet.</p>
          ) : (
            <PackageCarousel c={c} onBook={onBook} />
          )}
          {!c.bookable && !c.invited && (
            <p className="rounded-lg border border-ink/12 bg-ink/[0.04] px-3 py-2 text-[12px] text-inkMuted">
              Zavi cannot pay creators in this creator&apos;s country yet, so they cannot be booked.
            </p>
          )}
          <button
            type="button"
            onClick={onMessage}
            aria-label={unread > 0 ? `Message, ${unread} new ${unread === 1 ? "message" : "messages"}` : undefined}
            className={unread > 0 ? MESSAGE_UNREAD : MESSAGE}
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            Message
            {unread > 0 && (
              <span aria-hidden="true" className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#027bff] px-1.5 text-[11px] font-bold text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </div>
      </div>
    </article>
  );
}
