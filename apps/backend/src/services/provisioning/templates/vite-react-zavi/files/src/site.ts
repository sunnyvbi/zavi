import type { Action, NavItem } from "./components/sections";

export const SITE: { name: string; logo?: string; tagline: string; nav: NavItem[]; cta?: Action } = {
  name: "New site",
  tagline: "A new site, coming soon.",
  nav: [{ label: "Contact", href: "/#contact" }],
  cta: { label: "Get in touch", href: "/#contact" },
};
