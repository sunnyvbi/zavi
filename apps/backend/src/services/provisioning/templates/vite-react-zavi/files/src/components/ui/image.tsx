import { useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ImageFocal = { x: number; y: number };

export type SiteImageSource = {
  src: string;
  alt: string;
  srcset?: string;
  srcSet?: string;
  sizes?: string;
  width?: number;
  height?: number;
  focal?: ImageFocal;
};

const ASPECTS = {
  square: "aspect-square",
  portrait: "aspect-[4/5]",
  landscape: "aspect-[4/3]",
  wide: "aspect-[16/9]",
  banner: "aspect-[21/9]",
} as const;

export type ImageAspect = keyof typeof ASPECTS | "fill";

export function hasImage(image?: SiteImageSource | null): image is SiteImageSource {
  return !!image && typeof image.src === "string" && image.src.trim().length > 0;
}

function clampPct(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

export function focalPosition(focal?: ImageFocal | null): string | undefined {
  const x = clampPct(focal?.x);
  const y = clampPct(focal?.y);
  return x === null || y === null ? undefined : `${x}% ${y}%`;
}

const PRIORITY = { fetchpriority: "high" } as Record<string, string>;

export function BrandPanel({ className, children, failed = false }: { className?: string; children?: ReactNode; failed?: boolean }) {
  return (
    <div aria-hidden data-zavi-image={failed ? "error" : "none"} className={cn("relative overflow-hidden bg-gradient-to-br from-primary via-primary/85 to-accent", className)}>
      <div aria-hidden className="pointer-events-none absolute -right-1/4 -top-1/3 h-3/4 w-3/4 rounded-full bg-accent/50 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-1/3 -left-1/4 h-2/3 w-2/3 rounded-full bg-primary-foreground/10 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(rgb(var(--primary-foreground))_1px,transparent_1px)] [background-size:20px_20px]"
      />
      {children ? <div className="relative flex h-full w-full items-center justify-center text-primary-foreground">{children}</div> : null}
    </div>
  );
}

export function SiteImage({
  image,
  aspect = "landscape",
  priority = false,
  sizes,
  objectPosition,
  onFail,
  className,
  imgClassName,
}: {
  image?: SiteImageSource | null;
  aspect?: ImageAspect;
  priority?: boolean;
  sizes?: string;
  objectPosition?: string;
  onFail?: () => void;
  className?: string;
  imgClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = cn("relative overflow-hidden rounded-lg", aspect === "fill" ? "absolute inset-0 rounded-none" : ASPECTS[aspect], className);
  if (!hasImage(image)) return <BrandPanel className={cn(box, "pointer-events-none")} />;
  if (failedSrc === image.src) return <BrandPanel failed className={cn(box, "pointer-events-none")} />;
  const wide = aspect === "fill" || aspect === "wide" || aspect === "banner";
  const srcSet = image.srcSet ?? image.srcset;
  const position = objectPosition ?? focalPosition(image.focal);
  const style: CSSProperties | undefined = position ? { objectPosition: position } : undefined;
  return (
    <div className={cn(box, "bg-muted")}>
      <img
        src={image.src}
        alt={image.alt}
        {...(srcSet ? { srcSet, sizes: sizes ?? image.sizes ?? (wide ? "100vw" : "(min-width: 1024px) 50vw, 100vw") } : {})}
        {...(image.width && image.height ? { width: image.width, height: image.height } : {})}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        {...(priority ? PRIORITY : {})}
        onError={() => {
          setFailedSrc(image.src);
          onFail?.();
        }}
        style={style}
        className={cn("h-full w-full object-cover", imgClassName)}
      />
    </div>
  );
}
