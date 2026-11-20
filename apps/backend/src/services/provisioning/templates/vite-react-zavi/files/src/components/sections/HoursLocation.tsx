import type { ReactNode } from "react";
import { Clock, Mail, MapPin, Navigation, Phone } from "lucide-react";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Card } from "../ui/card";
import { ActionLink } from "./action";
import { cn } from "../../lib/utils";

export type OpeningHours = { days: string; hours: string };

export function HoursLocation({
  eyebrow,
  title = "Visit us",
  subtitle,
  hours,
  address,
  phone,
  email,
  note,
  showMap = true,
  tone,
  id = "visit",
  "data-zavi-section": marker,
}: {
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  hours?: OpeningHours[];
  address?: string;
  phone?: string;
  email?: string;
  note?: ReactNode;
  showMap?: boolean;
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  const mapsQuery = address ? encodeURIComponent(address) : "";
  const map = Boolean(address && showMap);
  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <div className={cn("grid gap-8", map ? "lg:grid-cols-5" : "mx-auto max-w-xl")}>
          <Card className={cn("p-7", map && "lg:col-span-2")}>
            {hours?.length ? (
              <div>
                <h3 className="flex items-center gap-2 text-lg">
                  <Clock aria-hidden className="size-5 text-primary" /> Opening hours
                </h3>
                <dl className="mt-4 divide-y divide-border text-sm">
                  {hours.map((h) => (
                    <div key={h.days} className="flex justify-between gap-4 py-2.5">
                      <dt className="text-muted-foreground">{h.days}</dt>
                      <dd className="text-right font-medium tabular-nums">{h.hours}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            <ul className="mt-6 space-y-3 text-sm">
              {address ? (
                <li className="flex gap-3">
                  <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{address}</span>
                </li>
              ) : null}
              {phone ? (
                <li className="flex gap-3">
                  <Phone aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="hover:underline">
                    {phone}
                  </a>
                </li>
              ) : null}
              {email ? (
                <li className="flex gap-3">
                  <Mail aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  <a href={`mailto:${email}`} className="break-all hover:underline">
                    {email}
                  </a>
                </li>
              ) : null}
            </ul>
            {note ? <div className="mt-6 text-sm text-muted-foreground">{note}</div> : null}
            {address ? (
              <ActionLink
                action={{ label: "Get directions", href: `https://www.google.com/maps/search/?api=1&query=${mapsQuery}` }}
                variant="outline"
                size="default"
                className="mt-7 w-full"
              >
                <Navigation aria-hidden /> Get directions
              </ActionLink>
            ) : null}
          </Card>
          {map ? (
            <div className="min-h-[18rem] overflow-hidden rounded-lg border border-border bg-muted lg:col-span-3">
              <iframe
                title={`Map of ${address}`}
                src={`https://www.google.com/maps?q=${mapsQuery}&output=embed`}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                className="h-full min-h-[18rem] w-full border-0"
              />
            </div>
          ) : null}
        </div>
      </Container>
    </Section>
  );
}
