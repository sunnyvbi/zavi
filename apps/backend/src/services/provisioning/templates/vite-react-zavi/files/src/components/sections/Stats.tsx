import { Container, Section, type SectionTone } from "../ui/layout";
import { Reveal } from "../ui/reveal";
import { countGrid } from "../../lib/grid";
import { cn } from "../../lib/utils";

export function Stats({ items, tone, id, "data-zavi-section": marker }: { items: Array<{ value: string; label: string }>; tone?: SectionTone; id?: string; "data-zavi-section"?: string }) {
  if (!items.length) return null;
  const layout = countGrid(items.length, 4);
  const n = items.length;
  const phone = n > 1 ? "grid-cols-2" : "";
  const phoneItem = (i: number) => (n > 1 && n % 2 === 1 && i === n - 1 ? (n === 3 ? "col-span-2 md:col-span-1" : "col-span-2") : "");
  return (
    <Section tone={tone} id={id} data-zavi-section={marker} className="py-14 md:py-16">
      <Container>
        <dl className={cn(phone, layout.grid, "gap-x-8 gap-y-10 text-center")}>
          {items.map((s, i) => (
            <Reveal key={s.label} delay={i * 80} className={cn("flex flex-col-reverse justify-end", phoneItem(i), layout.item(i))}>
              <dt className="mx-auto mt-3 max-w-[22ch] text-balance text-sm text-muted-foreground">{s.label}</dt>
              <dd className="font-display text-4xl font-semibold leading-none tracking-tight tabular-nums md:text-5xl">{s.value}</dd>
            </Reveal>
          ))}
        </dl>
      </Container>
    </Section>
  );
}
