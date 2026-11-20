import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { Reveal } from "../ui/reveal";
import { ActionLink, type Action } from "./action";
import { cn } from "../../lib/utils";
import { countGrid } from "../../lib/grid";

export type PricingPlan = {
  name: string;
  price: string;
  period?: string;
  description?: string;
  features: string[];
  cta?: Action;
  featured?: boolean;
  featuredLabel?: string;
};

export function Pricing({
  eyebrow,
  title,
  subtitle,
  plans,
  tone,
  id = "pricing",
  "data-zavi-section": marker,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  plans: PricingPlan[];
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  const layout = countGrid(plans.length, 3);
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <div className={cn("mx-auto max-w-5xl items-stretch gap-6", layout.grid)}>
          {plans.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 80} className={cn("h-full", layout.item(i))}>
              <Card className={cn("relative flex h-full flex-col p-7 md:p-8", plan.featured && "border-primary shadow-lg ring-1 ring-primary")}>
                {plan.featured ? (
                  <Badge variant="default" className="absolute -top-3 left-7">
                    {plan.featuredLabel ?? "Most popular"}
                  </Badge>
                ) : null}
                <h3 className="text-xl">{plan.name}</h3>
                {plan.description ? <p className="mt-2 text-sm text-muted-foreground">{plan.description}</p> : null}
                <p className="mt-6 flex items-baseline gap-1">
                  <span className="font-display text-4xl font-semibold tracking-tight">{plan.price}</span>
                  {plan.period ? <span className="text-sm text-muted-foreground">{plan.period}</span> : null}
                </p>
                <ul className="mt-6 flex-1 space-y-3 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="flex gap-3">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {plan.cta ? <ActionLink action={plan.cta} variant={plan.featured ? "default" : "outline"} className="mt-8 w-full" /> : null}
              </Card>
            </Reveal>
          ))}
        </div>
      </Container>
    </Section>
  );
}
