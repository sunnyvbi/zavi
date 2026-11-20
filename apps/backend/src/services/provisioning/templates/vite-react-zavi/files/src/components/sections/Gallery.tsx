import type { ReactNode } from "react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { SiteImage, hasImage, type ImageAspect, type SiteImageSource } from "../ui/image";
import { Reveal } from "../ui/reveal";
import { cn } from "../../lib/utils";

export type GalleryProps = {
  variant?: "grid" | "masonry" | "feature";
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  images: SiteImageSource[];
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
};

const MASONRY = ["portrait", "square", "landscape"] as const;

export const FEATURE_MAX_OTHERS = 4;

export type FeatureCell = { className?: string; aspect: ImageAspect; frameClassName?: string; imgClassName?: string };

export function featureGalleryLayout(othersCount: number): { grid: string; lead: FeatureCell; others: FeatureCell[] } {
  const n = Math.max(0, Math.min(FEATURE_MAX_OTHERS, Math.floor(othersCount) || 0));
  const tall: FeatureCell = { className: "col-span-2 md:row-span-2", aspect: "portrait", frameClassName: "md:aspect-auto md:h-full", imgClassName: "md:absolute md:inset-0" };
  const square: FeatureCell = { aspect: "square" };
  if (n === 0) return { grid: "grid grid-cols-1 gap-3 md:gap-4", lead: { aspect: "landscape" }, others: [] };
  if (n === 1) return { grid: "grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4", lead: { aspect: "portrait" }, others: [{ aspect: "portrait" }] };
  const grid = "grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4";
  if (n === 2) return { grid, lead: tall, others: [{ className: "md:col-span-2", aspect: "landscape" }, { className: "md:col-span-2", aspect: "landscape" }] };
  if (n === 3) return { grid, lead: tall, others: [square, square, { className: "col-span-2", aspect: "wide" }] };
  return { grid, lead: tall, others: [square, square, square, square] };
}

function Tile({ image, aspect, sizes, delay, className, frameClassName, imgClassName }: { image: SiteImageSource; aspect: ImageAspect; sizes: string; delay?: number; className?: string; frameClassName?: string; imgClassName?: string }) {
  return (
    <Reveal delay={delay} className={className}>
      <SiteImage image={image} aspect={aspect} sizes={sizes} className={frameClassName} imgClassName={imgClassName} />
    </Reveal>
  );
}

function FeatureGrid({ images, zoom }: { images: SiteImageSource[]; zoom: string }) {
  const [lead, ...rest] = images;
  if (!lead) return null;
  const others = rest.slice(0, FEATURE_MAX_OTHERS);
  const layout = featureGalleryLayout(others.length);
  return (
    <div className={layout.grid}>
      <Reveal className={layout.lead.className}>
        <SiteImage image={lead} aspect={layout.lead.aspect} sizes="(min-width: 768px) 50vw, 100vw" className={layout.lead.frameClassName} imgClassName={layout.lead.imgClassName} />
      </Reveal>
      {others.map((img, i) => (
        <Reveal key={`${img.src}-${i}`} delay={(i % 4) * 60} className={layout.others[i]!.className}>
          <SiteImage image={img} aspect={layout.others[i]!.aspect} sizes="(min-width: 768px) 25vw, 50vw" className={layout.others[i]!.frameClassName} imgClassName={cn(zoom, layout.others[i]!.imgClassName)} />
        </Reveal>
      ))}
    </div>
  );
}

export function Gallery({ variant = "grid", eyebrow, title, subtitle, images: all, tone, id, "data-zavi-section": marker }: GalleryProps) {
  const images = all.filter((img) => hasImage(img));
  if (!images.length) return null;
  const zoom = "transition-transform duration-500 hover:scale-105";
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container size="wide">
        {title ? <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} /> : null}
        {variant === "feature" ? (
          <FeatureGrid images={images} zoom={zoom} />
        ) : variant === "masonry" ? (
          <div className="columns-2 gap-3 md:columns-3 md:gap-4">
            {images.map((img, i) => (
              <Tile key={`${img.src}-${i}`} image={img} aspect={MASONRY[i % MASONRY.length]} sizes="(min-width: 768px) 33vw, 50vw" className="mb-3 break-inside-avoid md:mb-4" />
            ))}
          </div>
        ) : (
          <div className={cn("grid grid-cols-2 gap-3 md:gap-4", images.length >= 6 ? "md:grid-cols-3" : "md:grid-cols-2", images.length >= 8 && "lg:grid-cols-4")}>
            {images.map((img, i) => (
              <Tile key={`${img.src}-${i}`} image={img} aspect="square" sizes="(min-width: 768px) 33vw, 50vw" delay={(i % 4) * 60} imgClassName={zoom} />
            ))}
          </div>
        )}
      </Container>
    </Section>
  );
}
