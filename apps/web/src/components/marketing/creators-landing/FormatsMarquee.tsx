import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Play, Video } from "lucide-react";
import { CHANNEL_PAGES, ChannelGlyph } from "@/components/marketing/growth-home/channels/channelPages";
import { ExampleTag } from "./shared";

type Mark = ComponentType<{ className?: string; style?: CSSProperties }>;
type Platform = { Icon: Mark; color?: string };

function glyph(id: string): Platform {
  const channel = CHANNEL_PAGES.find((c) => c.id === id);
  if (!channel) throw new Error(`creators landing: no channel glyph for ${id}`);
  const Icon: Mark = ({ className }) => <ChannelGlyph channel={channel} className={className} />;
  Icon.displayName = `Glyph(${id})`;
  return { Icon };
}

const TT = glyph("tiktok");
const IG = glyph("instagram");
const YT = glyph("youtube");
const UGC: Platform = { Icon: Video, color: "#e11d48" };

type Card =
  | { kind: "vertical"; format: string; p: Platform; img: string; caption: string }
  | { kind: "wide"; format: string; p: Platform; img: string; title: string };

const UGC_CARD: Card = { kind: "vertical", format: "UGC video", p: UGC, img: "/marketing/creators/coldbrew.jpg", caption: "My new morning order, honestly" };

const ROW_A: Card[] = [
  UGC_CARD,
  { kind: "vertical", format: "TikTok video", p: TT, img: "/marketing/creators/cups.jpg", caption: "Rating every cup at the new cafe" },
  { kind: "wide", format: "YouTube video", p: YT, img: "/marketing/creators/counter.jpg", title: "A day behind the counter at a local roastery" },
  { kind: "vertical", format: "Instagram Reel", p: IG, img: "/marketing/creators/sale.jpg", caption: "Weekend sale, shot in one take" },
  { kind: "vertical", format: "YouTube Short", p: YT, img: "/marketing/creators/stream.jpg", caption: "60 seconds of my weekend" },
];

const ROW_B: Card[] = [
  { kind: "vertical", format: "Instagram Reel", p: IG, img: "/marketing/creators/team.jpg", caption: "Meet the people who make my coffee" },
  { kind: "wide", format: "YouTube video", p: YT, img: "/marketing/creators/sunday.jpg", title: "Where I work on Sunday mornings" },
  { ...UGC_CARD, img: "/marketing/creators/cups.jpg", caption: "Unboxing the reusable cup" },
  { kind: "vertical", format: "TikTok video", p: TT, img: "/marketing/creators/flights.jpg", caption: "Packing my travel coffee kit" },
  { kind: "vertical", format: "YouTube Short", p: YT, img: "/marketing/creators/gift.jpg", caption: "The gift box I keep sending friends" },
];

const SHELL =
  "flex h-[248px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white shadow-[0_20px_44px_-30px_rgba(16,18,20,0.35)]";

function Img({ src, className = "" }: { src: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" className={`size-full object-cover ${className}`} />;
}

function PlayDot() {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-white/85 backdrop-blur-sm">
        <Play className="size-4 translate-x-[1px] fill-[#0e0f11] text-[#0e0f11]" />
      </span>
    </span>
  );
}

function Footer({ c }: { c: Card }) {
  const { Icon, color } = c.p;
  return (
    <div className="flex items-center gap-2 border-t border-black/[0.06] px-3 py-2.5">
      <Icon className="size-4 shrink-0" style={color ? { color } : undefined} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0e0f11]">{c.format}</span>
    </div>
  );
}

function Body({ c }: { c: Card }): ReactNode {
  if (c.kind === "vertical") {
    return (
      <div className="relative flex-1 overflow-hidden bg-[#f9f9f9]">
        <Img src={c.img} />
        <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20" />
        <span className="absolute top-5 right-2.5">
          <ExampleTag dark />
        </span>
        <PlayDot />
        <p className="absolute inset-x-3 bottom-3 text-[13px] leading-snug font-semibold text-white drop-shadow">{c.caption}</p>
      </div>
    );
  }
  return (
    <>
      <div className="relative h-[150px] shrink-0 overflow-hidden bg-[#f9f9f9]">
        <Img src={c.img} />
        <span className="absolute top-2.5 right-2.5">
          <ExampleTag dark />
        </span>
        <PlayDot />
      </div>
      <p className="line-clamp-2 flex-1 px-3 pt-3 text-[13px] leading-snug font-semibold text-[#0e0f11]">{c.title}</p>
    </>
  );
}

const WIDTH: Record<Card["kind"], string> = { vertical: "w-[176px]", wide: "w-[296px]" };

function FormatCard({ c }: { c: Card }) {
  return (
    <article className={`${SHELL} ${WIDTH[c.kind]}`}>
      <Body c={c} />
      <Footer c={c} />
    </article>
  );
}

function Row({ cards, dir }: { cards: Card[]; dir: "right" | "left" }) {
  const loop = [...cards, ...cards];
  return (
    <div className="group overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)] motion-reduce:overflow-x-auto motion-reduce:[mask-image:none]">
      <div
        className={`flex w-max gap-4 px-2 group-hover:[animation-play-state:paused] motion-reduce:[animation:none] ${
          dir === "right" ? "[animation:cfRight_60s_linear_infinite]" : "[animation:cfLeft_60s_linear_infinite]"
        }`}
      >
        {loop.map((c, i) => (
          <div key={i} aria-hidden={i >= cards.length ? true : undefined} className="contents">
            <FormatCard c={c} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FormatsMarquee() {
  return (
    <section data-formats className="w-full overflow-hidden bg-white py-14 lg:py-16">
      <style>{`
        @keyframes cfRight{from{transform:translateX(-50%)}to{transform:translateX(0)}}
        @keyframes cfLeft{from{transform:translateX(0)}to{transform:translateX(-50%)}}
      `}</style>
      <div className="mx-auto max-w-[900px] px-6 text-center">
        <h2 className="text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
          What you can sell
        </h2>
        <p className="mx-auto mt-4 max-w-[60ch] text-[16px] leading-relaxed text-[#595959]">
          UGC videos the business runs on its own accounts and ads, cut for TikTok, Instagram Reels and YouTube.
        </p>
      </div>

      <div className="mt-10 flex flex-col gap-4">
        <Row cards={ROW_A} dir="right" />
        <Row cards={ROW_B} dir="left" />
      </div>
    </section>
  );
}
