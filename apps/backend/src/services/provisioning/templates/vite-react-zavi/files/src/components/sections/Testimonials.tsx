import type { ReactNode } from "react";
import { Quote, Star } from "lucide-react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Card } from "../ui/card";
import { Reveal } from "../ui/reveal";
import { countGrid } from "../../lib/grid";
import { cn } from "../../lib/utils";

export type Testimonial = { quote: string; name: string; detail?: string; rating?: 1 | 2 | 3 | 4 | 5 };

export type TestimonialsProps = {
  variant?: "cards" | "quote";
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  items: Testimonial[];
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
};

function Stars({ rating }: { rating?: number }) {
  if (!rating) return null;
  return (
    <div className="mb-4 flex gap-0.5 text-primary" role="img" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} aria-hidden className="size-4" fill={i < rating ? "currentColor" : "none"} />
      ))}
    </div>
  );
}

export function Testimonials({ variant = "cards", eyebrow, title, subtitle, items, tone, id, "data-zavi-section": marker }: TestimonialsProps) {
  if (!items.length) return null;
  if (variant === "quote") {
    const t = items[0];
    return (
      <Section tone={tone} id={id} data-zavi-section={marker}>
        <Container size="narrow" className="text-center">
          <Quote aria-hidden className="mx-auto mb-8 size-10 text-primary" />
          <blockquote className="font-display text-2xl leading-snug md:text-4xl">&ldquo;{t.quote}&rdquo;</blockquote>
          <p className="mt-8 font-semibold">{t.name}</p>
          {t.detail ? <p className="text-sm text-muted-foreground">{t.detail}</p> : null}
        </Container>
      </Section>
    );
  }
  const layout = countGrid(items.length, 3);
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container>
        {title ? <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} /> : null}
        <div className={cn(layout.grid, "gap-6")}>
          {items.map((t, i) => (
            <Reveal key={`${t.name}-${i}`} delay={i * 80} className={cn("h-full", layout.item(i))}>
              <Card className="h-full p-7">
                <figure className="flex h-full flex-col">
                  <Stars rating={t.rating} />
                  <blockquote className="flex-1 text-base leading-relaxed">&ldquo;{t.quote}&rdquo;</blockquote>
                  <figcaption className="mt-6 border-t border-border pt-4">
                    <p className="font-semibold">{t.name}</p>
                    {t.detail ? <p className="text-sm text-muted-foreground">{t.detail}</p> : null}
                  </figcaption>
                </figure>
              </Card>
            </Reveal>
          ))}
        </div>
      </Container>
    </Section>
  );
}
