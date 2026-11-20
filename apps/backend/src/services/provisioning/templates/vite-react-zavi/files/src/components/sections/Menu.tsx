import type { ReactNode } from "react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Reveal } from "../ui/reveal";
import { cn } from "../../lib/utils";

export type MenuItem = { name: string; price?: string; description?: string; tags?: string[] };
export type MenuCategory = { name: string; description?: string; items: MenuItem[] };

export function Menu({
  eyebrow,
  title,
  subtitle,
  categories,
  tone,
  id = "menu",
  "data-zavi-section": marker,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  categories: MenuCategory[];
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <div className={cn("grid gap-x-16 gap-y-14", categories.length === 1 ? "mx-auto max-w-2xl" : "md:grid-cols-4")}>
          {categories.map((cat, i) => (
            <Reveal key={cat.name} className={cn(categories.length > 1 && "md:col-span-2", categories.length > 1 && categories.length % 2 === 1 && i === categories.length - 1 && "md:col-start-2")}>
              <h3 className="border-b border-border pb-3 text-2xl">{cat.name}</h3>
              {cat.description ? <p className="mt-3 text-sm text-muted-foreground">{cat.description}</p> : null}
              <ul className="mt-6 space-y-6">
                {cat.items.map((item) => (
                  <li key={item.name}>
                    <div className="flex items-baseline gap-3">
                      <span className="font-medium">{item.name}</span>
                      <span aria-hidden className="min-w-4 flex-1 translate-y-[-4px] border-b border-dotted border-border" />
                      {item.price ? <span className="font-semibold tabular-nums">{item.price}</span> : null}
                    </div>
                    {item.description ? <p className="mt-1 text-sm text-muted-foreground">{item.description}</p> : null}
                    {item.tags?.length ? (
                      <p className="mt-1.5 flex flex-wrap gap-1.5">
                        {item.tags.map((t) => (
                          <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      </Container>
    </Section>
  );
}
