import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Container } from "../ui/layout";
import type { NavItem } from "./SiteHeader";

export const PRIVACY_LINE = "Visits are counted without cookies.";

export type FooterColumn = { title: string; links: NavItem[] };
export type SocialLink = { label: string; href: string; icon: LucideIcon };

function FooterLink({ item }: { item: NavItem }) {
  const cls = "text-sm text-muted-foreground transition-colors hover:text-foreground";
  return item.href.startsWith("/") && !item.href.startsWith("//") ? (
    <Link to={item.href} className={cls}>
      {item.label}
    </Link>
  ) : (
    <a href={item.href} className={cls}>
      {item.label}
    </a>
  );
}

export function SiteFooter({
  variant = "simple",
  name,
  tagline,
  links = [],
  columns = [],
  social = [],
  children,
}: {
  variant?: "simple" | "columns";
  name: string;
  tagline?: ReactNode;
  links?: NavItem[];
  columns?: FooterColumn[];
  social?: SocialLink[];
  children?: ReactNode;
}) {
  const year = new Date().getFullYear();
  const socials = social.length ? (
    <div className="flex gap-2">
      {social.map((s) => (
        <a
          key={s.href}
          href={s.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={s.label}
          className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <s.icon aria-hidden className="size-5" />
        </a>
      ))}
    </div>
  ) : null;

  if (variant === "columns") {
    return (
      <footer className="border-t border-border bg-muted/40">
        <Container className="grid gap-10 py-14 md:grid-cols-4">
          <div className="md:col-span-2">
            <p className="font-display text-xl font-semibold">{name}</p>
            {tagline ? <p className="mt-3 max-w-sm text-sm text-muted-foreground">{tagline}</p> : null}
            <div className="mt-5">{socials}</div>
            {children}
          </div>
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <p className="text-sm font-semibold">{col.title}</p>
              <ul className="mt-4 space-y-3">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <FooterLink item={l} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </Container>
        <Container className="border-t border-border py-6 text-xs text-muted-foreground">
          &copy; {year} {name}. All rights reserved. <span data-zavi="privacy">{PRIVACY_LINE}</span>
        </Container>
      </footer>
    );
  }

  return (
    <footer className="border-t border-border">
      <Container className="flex flex-col items-center justify-between gap-5 py-10 text-center md:flex-row md:text-left">
        <div>
          <p className="font-display font-semibold">{name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            &copy; {year} {name}
          </p>
          <p data-zavi="privacy" className="mt-1 text-xs text-muted-foreground">
            {PRIVACY_LINE}
          </p>
        </div>
        {links.length ? (
          <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {links.map((l) => (
              <FooterLink key={l.href} item={l} />
            ))}
          </nav>
        ) : null}
        {socials}
        {children}
      </Container>
    </footer>
  );
}
