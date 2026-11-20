
"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { Play, Star } from "lucide-react";
import { StepGlyph } from "./stepIcons";

const HEADING = "The kind of ads Zavi drafts for you";
const SUBHEAD =
  "Posts, Reels, product and search ads, UGC, drafted in your voice for every channel. Shown here for an example brand; nothing goes live until you approve it.";

const PHOTO = "/marketing/growth-home/channel-posts";

type Card =
  | { kind: "post"; brand: string; img: string; caption: string; cta: string }
  | { kind: "video"; brand: string; img: string; caption: string }
  | { kind: "product"; img: string; name: string; price: string }
  | { kind: "search"; url: string; title: string; body: string }
  | { kind: "review"; img: string; quote: string; by: string };

const CARDS: Card[] = [
  { kind: "post", brand: "Instagram", img: "coldbrew", caption: "Cold brew season is officially here ☕", cta: "Shop now" },
  { kind: "video", brand: "TikTok", img: "cups", caption: "New reusable cups just dropped 🥤" },
  { kind: "product", img: "sale", name: "Weekend flash sale", price: "25% off" },
  {
    kind: "search",
    url: "bloomandco.com/coldbrew",
    title: "Best cold brew, delivered to your door",
    body: "Roasted weekly. Free delivery on your first order.",
  },
  { kind: "review", img: "team", quote: "“I got my mornings back.”", by: "A regular, 5★" },
  { kind: "post", brand: "Meta", img: "gift", caption: "Refer a friend, you both get a free drink 🎁", cta: "Get offer" },
  { kind: "product", img: "counter", name: "Barista starter kit", price: "$39" },
  { kind: "video", brand: "YouTube", img: "coldbrew", caption: "60s: how we brew every batch" },
  { kind: "product", img: "cups", name: "Reusable cup, 3 colours", price: "$18" },
  { kind: "post", brand: "Instagram", img: "counter", caption: "Behind the counter: meet the team ☀️", cta: "Follow" },
  {
    kind: "review",
    img: "gift",
    quote: "“Best subscription I didn't know I needed.”",
    by: "@maya, 5★",
  },
  { kind: "video", brand: "TikTok", img: "sale", caption: "Flash sale ends tonight ⏰" },
  {
    kind: "search",
    url: "bloomandco.com/subscribe",
    title: "Coffee subscription, cancel anytime",
    body: "Freshly roasted, shipped to your door every week.",
  },
  { kind: "post", brand: "Meta", img: "team", caption: "New here? Your first drink is on us 💚", cta: "Claim it" },
  { kind: "product", img: "coldbrew", name: "Cold brew 6-pack", price: "$24" },
  { kind: "video", brand: "YouTube", img: "gift", caption: "How the referral perk works" },
];

const BRAND_MARK: Record<string, string> = {
  Instagram: "Instagram",
  Meta: "Meta Ads",
  TikTok: "TikTok",
  YouTube: "YouTube",
};

const BASE_W = 1000;
const SEATS = 16;
const GAP = 6;
const STAGE_PAD = 60;
const MAX_SCALE = 1.3;
const CHORD = 2 * Math.sin(Math.PI / SEATS);

type Optics = { cardW: number; cardH: number; radius: number; perspective: number };

function opticsFor(width: number): Optics {
  const [cardW, perspective] = width < 640 ? [190, 2600] : width < 1024 ? [170, 2200] : [190, 4040];
  return {
    cardW,
    cardH: Math.round(cardW * (width < 640 ? 1.9 : 1.95)),
    radius: Math.round((cardW + GAP) / CHORD),
    perspective,
  };
}

const SHELL =
  "flex h-full w-full shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white shadow-[0_20px_44px_-30px_rgba(16,18,20,0.35)]";
const WELL = "relative flex-1 overflow-hidden bg-[#f9f9f9]";

function Photo({ img }: { img: string }) {
  return <img src={`${PHOTO}/${img}.jpg`} alt="" loading="lazy" className="size-full object-cover" />;
}

function BrandPill({ brand }: { brand: string }) {
  return (
    <span className="absolute left-3 top-3">
      <span className="inline-flex items-center gap-2 rounded-full bg-white/90 px-2.5 py-1 text-[12px] font-semibold text-[#0e0f11] shadow-sm backdrop-blur-sm">
        <StepGlyph name={BRAND_MARK[brand]} className="size-3.5" />
        {brand}
      </span>
    </span>
  );
}

function AdCard({ c }: { c: Card }) {
  if (c.kind === "post") {
    return (
      <article className={SHELL}>
        <div className={WELL}>
          <Photo img={c.img} />
          <BrandPill brand={c.brand} />
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="line-clamp-2 text-[16px] font-medium leading-snug text-[#0e0f11]">{c.caption}</p>
          <span className="inline-flex h-9 w-fit items-center rounded-full bg-[#0e0f11] px-4 text-[13px] font-semibold text-white">
            {c.cta}
          </span>
        </div>
      </article>
    );
  }

  if (c.kind === "video") {
    return (
      <article className={SHELL}>
        <div className={WELL}>
          <Photo img={c.img} />
          <BrandPill brand={c.brand} />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/85 backdrop-blur-sm">
              <Play aria-hidden="true" className="size-5 translate-x-[1px] fill-[#0e0f11] text-[#0e0f11]" />
            </span>
          </span>
          <p className="absolute bottom-3 left-3 max-w-[70%] text-[13px] font-semibold leading-snug text-white drop-shadow">
            {c.caption}
          </p>
        </div>
      </article>
    );
  }

  if (c.kind === "product") {
    return (
      <article className={SHELL}>
        <div className={WELL}>
          <Photo img={c.img} />
        </div>
        <div className="flex items-center justify-between gap-2 p-4">
          <div className="min-w-0">
            <p className="truncate text-[16px] font-semibold text-[#0e0f11]">{c.name}</p>
            <p className="text-[14px] font-bold text-[#027bff]">{c.price}</p>
          </div>
          <span className="inline-flex h-9 shrink-0 items-center rounded-full border border-black/[0.12] px-3.5 text-[13px] font-semibold text-[#0e0f11]">
            Shop
          </span>
        </div>
      </article>
    );
  }

  if (c.kind === "search") {
    return (
      <article className={`${SHELL} justify-center gap-2 p-4`}>
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-[#f9f9f9] px-2 py-1 text-[12px] font-semibold text-[#595959]">
          <StepGlyph name="Google" className="size-3.5" /> Search ad
        </span>
        <span className="mt-1 inline-flex w-fit items-center rounded-full border border-black/[0.1] px-2 py-0.5 text-[11px] font-bold tracking-wide text-[#595959]">
          Ad
        </span>
        <p className="truncate text-[13px] text-[#0d7d33]">{c.url}</p>
        <p className="line-clamp-3 text-[16px] font-medium leading-snug text-[#1a0dab]">{c.title}</p>
        <p className="line-clamp-4 text-[13px] leading-relaxed text-[#595959]">{c.body}</p>
      </article>
    );
  }

  return (
    <article className={SHELL}>
      <div className={WELL}>
        <Photo img={c.img} />
        <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
        <div className="absolute inset-x-4 bottom-4 text-white">
          <span className="flex gap-0.5 text-[#ffd43b]">
            {[0, 1, 2, 3, 4].map((i) => (
              <Star key={i} aria-hidden="true" className="size-3.5 fill-current" />
            ))}
          </span>
          <p className="mt-2 text-[16px] font-semibold leading-snug">{c.quote}</p>
          <p className="mt-1 text-[13px] text-white/80">{c.by}</p>
        </div>
      </div>
    </article>
  );
}

export function GrowthRealAds() {
  const stage = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [optics, setOptics] = useState<Optics>(() => opticsFor(BASE_W));

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      setScale(Math.min(MAX_SCALE, Math.max(1, w / BASE_W)));
      setOptics(opticsFor(w));
    };
    fit();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", fit);
      return () => window.removeEventListener("resize", fit);
    }
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cardW, cardH, radius, perspective } = optics;

  return (
    <section className="w-full overflow-hidden bg-[#f9f9f9] py-16 lg:py-20">
      <div className="mx-auto max-w-[900px] px-6 text-center">
        {}
        <h2 className="text-[clamp(1.4rem,3.6vw,3rem)] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e0f11] sm:whitespace-nowrap">
          {HEADING}
        </h2>
        <p className="mx-auto mt-4 max-w-[64ch] text-[16px] leading-relaxed text-[#595959]">{SUBHEAD}</p>
      </div>
      {}
      <div className="mx-auto mt-12 w-full max-w-[1450px] px-6">
        <div
          ref={stage}
          className="zavi-ad-stage relative overflow-hidden"
          style={{ height: Math.round((cardH + STAGE_PAD) * scale), perspective: `${perspective}px` }}
        >
          <div
            className="absolute inset-0"
            style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}
          >
            <div className="zavi-ad-cylinder absolute left-1/2 top-1/2 h-0 w-0">
              {Array.from({ length: SEATS }, (_, i) => (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    width: cardW,
                    height: cardH,
                    left: -cardW / 2,
                    top: -cardH / 2,
                    transform: `rotateY(${(i * 360) / SEATS}deg) translateZ(${radius}px)`,
                    backfaceVisibility: "hidden",
                  }}
                >
                  <AdCard c={CARDS[i % CARDS.length]} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
