import type { ReactNode } from "react";
import { Container, Section, type SectionTone } from "../ui/layout";
import { SiteImage, hasImage, type SiteImageSource } from "../ui/image";
import { Actions, type Action } from "./action";

export function CTA({
  variant = "banner",
  title,
  subtitle,
  actions,
  image,
  tone = "inverse",
  id,
  "data-zavi-section": marker,
}: {
  variant?: "banner" | "split";
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: Action[];
  image?: SiteImageSource | null;
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  if (variant === "split" && hasImage(image)) {
    return (
      <Section tone={tone} id={id} data-zavi-section={marker}>
        <Container className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
          <div>
            <h2 className="text-display-md">{title}</h2>
            {subtitle ? <p className="mt-4 text-lg text-muted-foreground">{subtitle}</p> : null}
            <Actions actions={actions} className="mt-8" />
          </div>
          <SiteImage image={image} aspect="landscape" className="shadow-lg" />
        </Container>
      </Section>
    );
  }
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container size="narrow" className="text-center">
        <h2 className="text-display-md">{title}</h2>
        {subtitle ? <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">{subtitle}</p> : null}
        <Actions actions={actions} align="center" className="mt-8" />
      </Container>
    </Section>
  );
}
