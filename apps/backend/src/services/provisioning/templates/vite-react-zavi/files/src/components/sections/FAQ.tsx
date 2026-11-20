import type { ReactNode } from "react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Accordion, AccordionItem } from "../ui/accordion";

export type FaqItem = { question: string; answer: ReactNode };

export function FAQ({
  eyebrow,
  title = "Questions, answered",
  subtitle,
  items,
  tone,
  id = "faq",
  "data-zavi-section": marker,
}: {
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  items: FaqItem[];
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  if (!items.length) return null;
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container size="narrow">
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <Accordion>
          {items.map((item, i) => (
            <AccordionItem key={item.question} title={item.question} defaultOpen={i === 0}>
              {item.answer}
            </AccordionItem>
          ))}
        </Accordion>
      </Container>
    </Section>
  );
}
