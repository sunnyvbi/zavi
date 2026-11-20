import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Container } from "../ui/layout";
import { BrandPanel, SiteImage, hasImage, type SiteImageSource } from "../ui/image";
import { Badge } from "../ui/badge";
import { Actions, type Action } from "./action";
import { cn } from "../../lib/utils";

export type HeroProps = {
  variant?: "centered" | "split" | "image" | "editorial" | "minimal";
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: Action[];
  image?: SiteImageSource | null;
  highlights?: string[];
  id?: string;
  "data-zavi-section"?: string;
};

function Highlights({ items, className }: { items?: string[]; className?: string }) {
  if (!items?.length) return null;
  return (
    <ul className={cn("flex flex-wrap gap-x-6 gap-y-2 text-sm", className)}>
      {items.map((h) => (
        <li key={h} className="flex items-center gap-2">
          <Check aria-hidden className="size-4 text-primary" />
          {h}
        </li>
      ))}
    </ul>
  );
}

export function Hero({ variant: asked = "split", eyebrow, title, subtitle, actions, image, highlights, id, "data-zavi-section": marker }: HeroProps) {
  const photo = hasImage(image) ? image : null;
  const variant = asked === "split" && !photo ? "centered" : asked;
  if (variant === "editorial") {
    return (
      <section id={id} data-zavi-section={marker} className="relative overflow-hidden bg-background">
        <Container className={cn("grid gap-10 pb-section pt-16 md:pt-24", photo && "lg:grid-cols-12 lg:gap-12")}>
          <div className={cn("animate-fade-up", photo ? "lg:col-span-7 lg:pt-8" : "max-w-4xl")}>
            {eyebrow ? (
              <p className="mb-6 flex items-center gap-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                <span aria-hidden className="h-px w-10 bg-primary" />
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-display-xl">{title}</h1>
            <div className={cn("mt-8 grid gap-8", !photo && "md:grid-cols-2 md:items-end")}>
              {subtitle ? <p className="max-w-xl text-lg text-muted-foreground md:text-xl">{subtitle}</p> : null}
              <div>
                <Actions actions={actions} />
                <Highlights items={highlights} className="mt-6 text-muted-foreground" />
              </div>
            </div>
          </div>
          {photo ? (
            <div className="relative animate-fade-in [animation-delay:150ms] lg:col-span-5 lg:mt-24">
              <div aria-hidden className="absolute -bottom-4 -left-4 hidden h-2/3 w-2/3 rounded-lg bg-accent lg:block" />
              <SiteImage image={photo} aspect="portrait" priority sizes="(min-width: 1024px) 40vw, 100vw" className="relative shadow-lg" />
            </div>
          ) : null}
        </Container>
      </section>
    );
  }

  if (variant === "image") {
    return (
      <section id={id} data-zavi-section={marker} className="surface-overlay relative isolate flex min-h-[78vh] items-end overflow-hidden">
        {photo ? <SiteImage image={photo} aspect="fill" priority sizes="100vw" className="-z-20" /> : <BrandPanel className="absolute inset-0 -z-20" />}
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/45 to-black/10" />
        <Container className="animate-fade-up py-section">
          {eyebrow ? <p className="mb-4 text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p> : null}
          <h1 className="max-w-3xl text-display-xl">{title}</h1>
          {subtitle ? <p className="mt-6 max-w-xl text-lg text-muted-foreground md:text-xl">{subtitle}</p> : null}
          <Actions actions={actions} className="mt-9" />
          <Highlights items={highlights} className="mt-8 text-muted-foreground" />
        </Container>
      </section>
    );
  }

  if (variant === "split") {
    return (
      <section id={id} data-zavi-section={marker} className="overflow-hidden bg-background">
        <Container className="grid items-center gap-12 py-section lg:grid-cols-2 lg:gap-16">
          <div className="animate-fade-up">
            {eyebrow ? <Badge className="mb-5">{eyebrow}</Badge> : null}
            <h1 className="text-display-lg">{title}</h1>
            {subtitle ? <p className="mt-6 max-w-xl text-lg text-muted-foreground">{subtitle}</p> : null}
            <Actions actions={actions} className="mt-9" />
            <Highlights items={highlights} className="mt-8 text-muted-foreground" />
          </div>
          <div className="relative animate-fade-in [animation-delay:150ms]">
            <div aria-hidden className="absolute -inset-4 -z-0 rounded-2xl bg-accent/70 blur-2xl" />
            <SiteImage image={photo} aspect="portrait" priority className="relative shadow-lg sm:aspect-[4/3] lg:aspect-[4/5]" />
          </div>
        </Container>
      </section>
    );
  }

  const minimal = variant === "minimal";
  return (
    <section id={id} data-zavi-section={marker} className={cn("relative overflow-hidden bg-background", minimal ? "pb-12 pt-16 md:pt-24" : "py-section")}>
      {!minimal ? (
        <div aria-hidden className="absolute inset-x-0 top-0 -z-0 h-[28rem] bg-gradient-to-b from-accent/60 to-transparent" />
      ) : null}
      <Container size="narrow" className="relative animate-fade-up text-center">
        {eyebrow ? <p className="mb-4 text-sm font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p> : null}
        <h1 className={minimal ? "text-display-md" : "text-display-xl"}>{title}</h1>
        {subtitle ? <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl">{subtitle}</p> : null}
        <Actions actions={actions} align="center" className="mt-9" />
        <Highlights items={highlights} className="mt-8 justify-center text-muted-foreground" />
      </Container>
      {!minimal && photo ? (
        <Container className="relative mt-14 animate-fade-in [animation-delay:200ms]">
          <SiteImage image={photo} aspect="wide" priority sizes="(min-width: 1152px) 1152px, 100vw" className="shadow-lg" />
        </Container>
      ) : null}
    </section>
  );
}
