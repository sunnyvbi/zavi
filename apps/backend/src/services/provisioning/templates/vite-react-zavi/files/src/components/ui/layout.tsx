import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Container({ className, size = "default", ...props }: HTMLAttributes<HTMLDivElement> & { size?: "narrow" | "default" | "wide" }) {
  const max = size === "narrow" ? "max-w-3xl" : size === "wide" ? "max-w-7xl" : "max-w-6xl";
  return <div className={cn("mx-auto w-full px-4 sm:px-6 lg:px-8", max, className)} {...props} />;
}

export type SectionTone = "default" | "muted" | "inverse";

const TONES: Record<SectionTone, string> = {
  default: "bg-background text-foreground",
  muted: "bg-muted text-foreground",
  inverse: "surface-inverse",
};

export function Section({
  tone = "default",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { tone?: SectionTone }) {
  return (
    <section className={cn("py-section", TONES[tone], className)} {...props}>
      {children}
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "center",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div className={cn("mb-12 max-w-2xl md:mb-16", align === "center" ? "mx-auto text-center" : "", className)}>
      {eyebrow ? <p className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-primary">{eyebrow}</p> : null}
      <h2 className="text-display-md">{title}</h2>
      {subtitle ? <p className="mt-4 text-lg text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}
