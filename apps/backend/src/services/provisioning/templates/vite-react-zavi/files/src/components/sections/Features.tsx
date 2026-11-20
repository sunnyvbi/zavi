import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Card } from "../ui/card";
import { BrandPanel, SiteImage, hasImage, type SiteImageSource } from "../ui/image";
import { Reveal } from "../ui/reveal";
import { Actions, type Action } from "./action";
import { cn } from "../../lib/utils";
import { countGrid } from "../../lib/grid";

export type FeatureItem = {
  title: string;
  body: ReactNode;
  icon?: LucideIcon;
  image?: SiteImageSource | null;
  action?: Action;
};

export type FeaturesProps = {
  variant?: "cards" | "icons" | "alternating" | "split";
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  items: FeatureItem[];
  image?: SiteImageSource | null;
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
};

function IconBadge({ icon: Icon }: { icon?: LucideIcon }) {
  if (!Icon) return null;
  return (
    <span className="mb-5 inline-flex size-12 items-center justify-center rounded-lg bg-accent text-accent-foreground">
      <Icon aria-hidden className="size-6" />
    </span>
  );
}

function PanelIcon({ icon: Icon }: { icon?: LucideIcon }) {
  if (!Icon) return null;
  return <Icon aria-hidden className="size-16 opacity-90 md:size-20" strokeWidth={1.25} />;
}

function AlternatingRow({ item, index }: { item: FeatureItem; index: number }) {
  const photo = hasImage(item.image) ? item.image : null;
  const flip = index % 2 === 1;
  return (
    <Reveal className="grid items-center gap-8 md:grid-cols-12 md:gap-12">
      {photo ? (
        <SiteImage image={photo} aspect="landscape" className={cn("shadow-md md:col-span-7", flip && "md:order-2")} />
      ) : (
        <BrandPanel className={cn("aspect-[4/3] rounded-lg shadow-md md:col-span-7", flip && "md:order-2")}>
          <PanelIcon icon={item.icon} />
        </BrandPanel>
      )}
      <div className="md:col-span-5">
        <p aria-hidden className="mb-4 font-display text-sm font-semibold tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</p>
        <IconBadge icon={photo ? item.icon : undefined} />
        <h3 className="text-2xl md:text-3xl">{item.title}</h3>
        <div className="mt-4 text-lg text-muted-foreground">{item.body}</div>
        {item.action ? <Actions actions={[item.action]} className="mt-6" /> : null}
      </div>
    </Reveal>
  );
}

function FeatureCard({ item }: { item: FeatureItem }) {
  const photo = hasImage(item.image) ? item.image : null;
  return (
    <Card className="flex h-full flex-col overflow-hidden transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-lg">
      {photo ? <SiteImage image={photo} aspect="landscape" className="rounded-none" /> : null}
      <div className="flex flex-1 flex-col p-6 md:p-7">
        <IconBadge icon={photo ? undefined : item.icon} />
        <h3 className="text-xl">{item.title}</h3>
        <div className="mt-2 flex-1 text-muted-foreground">{item.body}</div>
        {item.action ? <Actions actions={[item.action]} className="mt-5" /> : null}
      </div>
    </Card>
  );
}

function SplitList({ eyebrow, title, subtitle, items, image }: Omit<FeaturesProps, "variant" | "tone" | "id" | "data-zavi-section">) {
  const photo = hasImage(image) ? image : null;
  return (
    <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
      <div className="lg:col-span-5">
        <div className="lg:sticky lg:top-24">
          <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} align="left" className="mb-8 md:mb-10" />
          {photo ? <SiteImage image={photo} aspect="portrait" sizes="(min-width: 1024px) 40vw, 100vw" className="shadow-md" /> : null}
        </div>
      </div>
      <ol className="divide-y divide-border border-y border-border lg:col-span-7">
        {items.map((item, i) => (
          <li key={item.title}>
            <Reveal delay={i * 60} className="grid gap-3 py-7 sm:grid-cols-[3rem_1fr] sm:gap-6 md:py-9">
              <span aria-hidden className="font-display text-sm font-semibold tabular-nums text-primary sm:pt-1.5">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3 className="flex items-center gap-3 text-xl md:text-2xl">
                  {item.icon ? <item.icon aria-hidden className="size-5 shrink-0 text-primary" /> : null}
                  {item.title}
                </h3>
                <div className="mt-2 max-w-xl text-muted-foreground">{item.body}</div>
                {item.action ? <Actions actions={[item.action]} className="mt-4" /> : null}
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Features({ variant = "cards", eyebrow, title, subtitle, items, image, tone, id, "data-zavi-section": marker }: FeaturesProps) {
  const layout = countGrid(items.length, 3);
  if (variant === "split") {
    return (
      <Section tone={tone} id={id} data-zavi-section={marker}>
        <Container>
          <SplitList eyebrow={eyebrow} title={title} subtitle={subtitle} items={items} image={image} />
        </Container>
      </Section>
    );
  }
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        {variant === "alternating" ? (
          <div className="space-y-16 md:space-y-24">
            {items.map((item, i) => (
              <AlternatingRow key={item.title} item={item} index={i} />
            ))}
          </div>
        ) : (
          <div className={cn(layout.grid, "gap-6", variant === "icons" && "gap-x-10 gap-y-12")}>
            {items.map((item, i) =>
              variant === "icons" ? (
                <Reveal key={item.title} delay={i * 80} className={cn("flex flex-col items-center text-center", layout.item(i))}>
                  <IconBadge icon={item.icon} />
                  <h3 className="text-balance text-xl">{item.title}</h3>
                  <div className="mt-2 max-w-sm text-muted-foreground">{item.body}</div>
                </Reveal>
              ) : (
                <Reveal key={item.title} delay={i * 80} className={cn("h-full", layout.item(i))}>
                  <FeatureCard item={item} />
                </Reveal>
              ),
            )}
          </div>
        )}
      </Container>
    </Section>
  );
}
