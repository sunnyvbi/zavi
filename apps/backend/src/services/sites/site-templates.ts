
import { getThemePreset, renderThemeCss, type ThemePreset } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { planSectionId } from "./design-fidelity";
import {
  PLAN_MAX_SECTIONS,
  PLAN_SECTION_VARIANTS,
  PLAN_TONES,
  isBriefLayout,
  type BriefLayout,
  type DesignBrief,
  type PlanComponent,
  type PlanTone,
  type SitePlanSection,
} from "./design-brief";

export const SITE_TEMPLATES_VERSION = 1;

export type SiteTemplateSection = {
  name: string;
  component: PlanComponent;
  variant?: string;
  tone?: PlanTone;
  photo?: boolean;
  purpose: string;
};

export type SiteTemplate = {
  id: string;
  v: number;
  label: string;
  blurb: string;
  good_for: string;
  idea: string;
  look: { base: string; layout: BriefLayout };
  action: { label: string; journey: string };
  sections: SiteTemplateSection[];
  sample: { headline: string; subtitle: string };
};

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  {
    id: "book-a-service",
    v: SITE_TEMPLATES_VERSION,
    label: "Book a service",
    blurb: "Show what you offer and let people book a time.",
    good_for: "Salons, trades, clinics, tutors, coaches",
    idea: "A website for my [type of business] in [town or area]. We offer [services and their prices]. Customers book a time online.",
    look: { base: "fresh", layout: "split" },
    action: { label: "Book a time", journey: "visitors pick a service and an open time and book it" },
    sections: [
      { name: "Hero", component: "Hero", variant: "split", photo: true, purpose: "what you do and for whom, with the booking button" },
      { name: "Services", component: "Features", variant: "cards", purpose: "the services and prices the idea names" },
      { name: "How it works", component: "Features", variant: "icons", tone: "muted", purpose: "the steps from booking to the visit" },
      { name: "Questions", component: "FAQ", purpose: "what people ask before they book" },
      { name: "Book", component: "CTA", variant: "banner", purpose: "the booking call to action" },
    ],
    sample: { headline: "Book your next visit in a minute", subtitle: "Pick a service, choose a time, done." },
  },
  {
    id: "menu-and-hours",
    v: SITE_TEMPLATES_VERSION,
    label: "Menu and opening hours",
    blurb: "Your menu, your hours and where to find you.",
    good_for: "Cafés, restaurants, bakeries, food trucks",
    idea: "A website for my [café, restaurant or bakery] called [name] in [town]. We serve [menu items and prices], open [opening hours] at [address]. People can order ahead.",
    look: { base: "sunny", layout: "centered" },
    action: { label: "Order ahead", journey: "visitors send an order or a table request through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "image", photo: true, purpose: "the place and what it is known for" },
      { name: "Menu", component: "Menu", purpose: "the menu the idea names, by category" },
      { name: "Gallery", component: "Gallery", variant: "grid", purpose: "the food and the place" },
      { name: "Visit us", component: "HoursLocation", purpose: "opening hours and the address" },
      { name: "Order ahead", component: "CTA", variant: "banner", tone: "inverse", purpose: "the order call to action" },
    ],
    sample: { headline: "Fresh every morning, open till late", subtitle: "See the menu, then order ahead or drop in." },
  },
  {
    id: "portfolio",
    v: SITE_TEMPLATES_VERSION,
    label: "Portfolio",
    blurb: "Let the work speak, then take enquiries.",
    good_for: "Photographers, designers, artists, makers",
    idea: "A portfolio site for my [kind of work]. It shows my best work, a short about, what I offer and an enquiry form.",
    look: { base: "studio", layout: "minimal" },
    action: { label: "Send an enquiry", journey: "visitors send an enquiry through a form" },
    sections: [
      { name: "Intro", component: "Hero", variant: "minimal", purpose: "who you are and what you make, in one line" },
      { name: "Work", component: "Gallery", variant: "feature", purpose: "the best pieces" },
      { name: "About", component: "Features", variant: "split", photo: true, purpose: "a short about, with a portrait or the studio" },
      { name: "Services", component: "Features", variant: "icons", purpose: "what you can be hired for" },
      { name: "Contact", component: "Contact", purpose: "the enquiry form" },
    ],
    sample: { headline: "Work that tells the story", subtitle: "Selected projects, and how to work together." },
  },
  {
    id: "product-launch",
    v: SITE_TEMPLATES_VERSION,
    label: "Product launch",
    blurb: "Explain the product and grow a waitlist.",
    good_for: "Apps, software, new products",
    idea: "A launch page for [product name], a [what it is] for [who it is for]. It explains what it does and collects emails for the waitlist.",
    look: { base: "midnight", layout: "bold" },
    action: { label: "Join the waitlist", journey: "visitors join the waitlist with their email" },
    sections: [
      { name: "Hero", component: "Hero", variant: "image", purpose: "the promise in one line, with the waitlist button" },
      { name: "Features", component: "Features", variant: "icons", purpose: "the three things it does best" },
      { name: "How it works", component: "Features", variant: "alternating", purpose: "how it works, step by step" },
      { name: "Questions", component: "FAQ", purpose: "what people ask before they sign up" },
      { name: "Join", component: "CTA", variant: "banner", tone: "inverse", purpose: "the waitlist call to action" },
    ],
    sample: { headline: "The simpler way to get it done", subtitle: "Join the waitlist and be first in." },
  },
  {
    id: "professional-services",
    v: SITE_TEMPLATES_VERSION,
    label: "Professional services",
    blurb: "Explain how you help and win the first call.",
    good_for: "Consultants, agencies, accountants, lawyers",
    idea: "A website for my [kind of firm] that helps [who you help] with [what you help with]. It explains our services and how we work, and people book a first call.",
    look: { base: "trust", layout: "split" },
    action: { label: "Book a call", journey: "visitors request a first call through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "split", photo: true, purpose: "who you help and the outcome, with the call button" },
      { name: "Services", component: "Features", variant: "split", purpose: "the services the idea names" },
      { name: "How we work", component: "Features", variant: "icons", tone: "muted", purpose: "the steps of working together" },
      { name: "Questions", component: "FAQ", purpose: "what clients ask first" },
      { name: "Contact", component: "Contact", purpose: "the call request form" },
    ],
    sample: { headline: "Clear advice, when it matters", subtitle: "See how we help, then book a first call." },
  },
  {
    id: "classes-and-events",
    v: SITE_TEMPLATES_VERSION,
    label: "Classes and events",
    blurb: "A timetable, prices and an easy sign-up.",
    good_for: "Studios, gyms, workshops, schools, venues",
    idea: "A website for my [studio, school or venue] in [town]. We run [classes and their times], and they cost [prices]. People sign up for a class.",
    look: { base: "coastal", layout: "centered" },
    action: { label: "Sign up", journey: "visitors pick a class and sign up through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "image", photo: true, purpose: "the place and what you teach or host" },
      { name: "Classes", component: "Features", variant: "cards", purpose: "the classes or events and when they run" },
      { name: "Prices", component: "Pricing", purpose: "the prices the idea names" },
      { name: "Questions", component: "FAQ", purpose: "what newcomers ask" },
      { name: "Sign up", component: "CTA", variant: "banner", purpose: "the sign-up call to action" },
    ],
    sample: { headline: "Find your class this week", subtitle: "See the timetable and sign up in seconds." },
  },
  {
    id: "community",
    v: SITE_TEMPLATES_VERSION,
    label: "Cause or community",
    blurb: "Share what you do and bring people in.",
    good_for: "Nonprofits, clubs, groups, associations",
    idea: "A website for [name of the group], a [kind of group] in [place]. It explains what we do, shows our recent work and lets people get involved.",
    look: { base: "editorial", layout: "editorial" },
    action: { label: "Get involved", journey: "visitors join or volunteer through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "editorial", photo: true, purpose: "what the group does and why it matters" },
      { name: "What we do", component: "Features", variant: "alternating", purpose: "the work, in a few parts" },
      { name: "Recent work", component: "Gallery", variant: "feature", purpose: "photos of recent work or events" },
      { name: "Get involved", component: "Features", variant: "icons", tone: "muted", purpose: "the ways to help or join" },
      { name: "Join us", component: "CTA", variant: "banner", tone: "inverse", purpose: "the join call to action" },
    ],
    sample: { headline: "Together we get more done", subtitle: "See what we do and find your way to help." },
  },
  {
    id: "salon",
    v: SITE_TEMPLATES_VERSION,
    label: "Salon or spa",
    blurb: "Treatments, prices and a booking button on every screen.",
    good_for: "Hair salons, barbers, nail bars, spas, beauty studios",
    idea: "A website for my [salon, barber or spa] called [name] in [town]. We offer [treatments and their prices], open [opening hours]. Clients book an appointment online.",
    look: { base: "luxe", layout: "centered" },
    action: { label: "Book an appointment", journey: "visitors pick a treatment and an open time and book it" },
    sections: [
      { name: "Hero", component: "Hero", variant: "centered", photo: true, purpose: "the salon and the feeling of a visit, with the booking button" },
      { name: "Treatments", component: "Pricing", purpose: "the treatments and prices the idea names" },
      { name: "The space", component: "Gallery", variant: "masonry", purpose: "the salon and the work" },
      { name: "Visit us", component: "HoursLocation", tone: "muted", purpose: "opening hours and the address" },
      { name: "Book", component: "CTA", variant: "split", purpose: "the booking call to action" },
    ],
    sample: { headline: "Time for you, booked in a minute", subtitle: "See the treatments, pick a time, and relax." },
  },
  {
    id: "restaurant",
    v: SITE_TEMPLATES_VERSION,
    label: "Restaurant",
    blurb: "The food first, then the menu and a table request.",
    good_for: "Restaurants, bistros, bars, wine bars",
    idea: "A website for my restaurant called [name] in [town]. We cook [kind of food], our menu has [dishes and prices], open [opening hours] at [address]. Guests request a table online.",
    look: { base: "noir", layout: "editorial" },
    action: { label: "Request a table", journey: "visitors send a table request with a date, time and party size through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "image", photo: true, purpose: "the room and the food it is known for" },
      { name: "Our kitchen", component: "Features", variant: "alternating", purpose: "the cooking and where the food comes from" },
      { name: "Menu", component: "Menu", purpose: "the menu the idea names, by course" },
      { name: "Visit us", component: "HoursLocation", tone: "muted", purpose: "opening hours and the address" },
      { name: "Reserve", component: "CTA", variant: "banner", tone: "inverse", purpose: "the table request call to action" },
    ],
    sample: { headline: "Seasonal plates, a table waiting", subtitle: "See tonight's menu and request a table." },
  },
  {
    id: "gym",
    v: SITE_TEMPLATES_VERSION,
    label: "Gym or fitness",
    blurb: "Energy up front, memberships and a free first session.",
    good_for: "Gyms, boxing clubs, personal trainers, studios",
    idea: "A website for my [gym or fitness studio] called [name] in [town]. We offer [classes or training], memberships cost [prices]. People sign up for a free first session.",
    look: { base: "midnight", layout: "bold" },
    action: { label: "Claim a free session", journey: "visitors sign up for a free first session through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "image", photo: true, purpose: "the training and the promise, with the free session button" },
      { name: "Training", component: "Features", variant: "cards", purpose: "the classes or training the idea names" },
      { name: "Memberships", component: "Pricing", purpose: "the memberships and prices the idea names" },
      { name: "Questions", component: "FAQ", tone: "muted", purpose: "what newcomers ask before they start" },
      { name: "Start", component: "CTA", variant: "banner", tone: "inverse", purpose: "the free session call to action" },
    ],
    sample: { headline: "Stronger starts this week", subtitle: "Pick a class or a plan and try it free." },
  },
  {
    id: "clinic",
    v: SITE_TEMPLATES_VERSION,
    label: "Clinic or practice",
    blurb: "Calm, clear care information and easy appointments.",
    good_for: "Dentists, physios, therapists, vets, GPs",
    idea: "A website for my [kind of clinic] called [name] in [town]. We treat [conditions or services], open [opening hours] at [address]. Patients request an appointment online.",
    look: { base: "fresh", layout: "split" },
    action: { label: "Request an appointment", journey: "visitors request an appointment through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "split", photo: true, purpose: "who you care for and how, with the appointment button" },
      { name: "Treatments", component: "Features", variant: "icons", purpose: "the treatments or services the idea names" },
      { name: "Your first visit", component: "Features", variant: "split", tone: "muted", purpose: "what happens at a first appointment" },
      { name: "Questions", component: "FAQ", purpose: "what patients ask before booking" },
      { name: "Visit us", component: "HoursLocation", purpose: "opening hours and the address" },
      { name: "Contact", component: "Contact", purpose: "the appointment request form" },
    ],
    sample: { headline: "Gentle care, close to home", subtitle: "See how we help and request an appointment." },
  },
  {
    id: "agency",
    v: SITE_TEMPLATES_VERSION,
    label: "Agency or studio",
    blurb: "Your work, your services and a project enquiry.",
    good_for: "Design, marketing and dev agencies, studios, freelancers",
    idea: "A website for my [kind of agency] called [name]. We help [who you work with] with [services]. It shows our work and people send a project enquiry.",
    look: { base: "precise", layout: "split" },
    action: { label: "Start a project", journey: "visitors send a project enquiry through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "split", photo: true, purpose: "who you help and what changes for them" },
      { name: "Work", component: "Gallery", variant: "feature", purpose: "the best recent projects" },
      { name: "Services", component: "Features", variant: "cards", tone: "muted", purpose: "the services the idea names" },
      { name: "How we work", component: "Features", variant: "icons", purpose: "the steps of a project" },
      { name: "Contact", component: "Contact", purpose: "the project enquiry form" },
    ],
    sample: { headline: "Work that moves the numbers", subtitle: "See recent projects, then tell us about yours." },
  },
  {
    id: "shop",
    v: SITE_TEMPLATES_VERSION,
    label: "Online shop",
    blurb: "Show the products and take orders.",
    good_for: "Makers, small brands, boutiques, gift shops",
    idea: "A website for my shop called [name]. We sell [products and their prices]. Customers pick a product and send an order, and we [deliver or offer collection].",
    look: { base: "editorial", layout: "centered" },
    action: { label: "Order now", journey: "visitors pick a product and send an order through a form" },
    sections: [
      { name: "Hero", component: "Hero", variant: "centered", photo: true, purpose: "the shop and what makes its products special" },
      { name: "Products", component: "Gallery", variant: "grid", purpose: "the products the idea names, with prices" },
      { name: "Why us", component: "Features", variant: "icons", tone: "muted", purpose: "how it is made, delivery and returns as the idea says" },
      { name: "Questions", component: "FAQ", purpose: "what buyers ask before ordering" },
      { name: "Order", component: "CTA", variant: "banner", purpose: "the order call to action" },
    ],
    sample: { headline: "Made well, made to last", subtitle: "Browse the collection and order yours." },
  },
];

export function getSiteTemplate(id: unknown): SiteTemplate | null {
  if (typeof id !== "string") return null;
  return SITE_TEMPLATES.find((t) => t.id === id.trim().toLowerCase()) ?? null;
}

export function parseSiteTemplate(raw: unknown): SiteTemplate | null {
  const t = raw as Partial<SiteTemplate> | null;
  if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.label !== "string") return null;
  if (!t.look || !getThemePreset(String(t.look.base)) || !isBriefLayout(t.look.layout)) return null;
  if (!t.action || typeof t.action.label !== "string" || typeof t.action.journey !== "string") return null;
  if (!Array.isArray(t.sections) || t.sections.length === 0 || t.sections.length > PLAN_MAX_SECTIONS) return null;
  for (const s of t.sections) {
    if (!s || typeof s.name !== "string" || typeof s.purpose !== "string" || !(s.component in PLAN_SECTION_VARIANTS)) return null;
    if (s.variant !== undefined && !(PLAN_SECTION_VARIANTS[s.component] as readonly string[]).includes(s.variant)) return null;
    if (s.tone !== undefined && !PLAN_TONES.includes(s.tone)) return null;
  }
  return t as SiteTemplate;
}

const BLANK = /\[[^\[\]\n]{1,60}\]/g;

export function unfilledTemplateBlanks(idea: string): string[] {
  return [...new Set(idea.match(BLANK) ?? [])];
}

export function designBriefTemplateLines(template: SiteTemplate): string {
  const sections = template.sections
    .map((s, i) => `${i + 1}. ${s.name}: ${[s.component, s.variant].filter(Boolean).join(" ")}${s.tone ? `, ${s.tone}` : ""}${s.photo ? ", with a photo" : ""} (${s.purpose})`)
    .join("\n");
  return `STARTING TEMPLATE (the founder picked "${template.label}"): plan the home page with exactly these sections, in this order, with these components and variants, and write every headline for this business. Leave out a section the idea gives nothing true to say in. The main action is "${template.action.label}": ${template.action.journey}.\n${sections}`;
}

function sectionFor(slot: SiteTemplateSection, from: SitePlanSection): SitePlanSection {
  const out: SitePlanSection = { name: from.name || slot.name, headline: from.headline, component: slot.component };
  if (slot.variant) out.variant = slot.variant;
  if (slot.tone && slot.component !== "Hero") out.tone = slot.tone;
  if (from.image) out.image = from.image;
  return out;
}

export function applySiteTemplate(brief: DesignBrief, template: SiteTemplate): DesignBrief {
  const look = { base: template.look.base, layout: template.look.layout, alternates: brief.look?.alternates ?? [] };
  const out: DesignBrief = { ...brief, look, look_given: "template", template: { id: template.id, v: template.v } };
  const plan = brief.plan;
  const home = plan?.pages.find((p) => p.path === "/");
  if (!plan || !home || !home.sections.some((s) => s.component === "Hero")) return out;
  const left = [...home.sections];
  const take = (c: PlanComponent): SitePlanSection | null => {
    const i = left.findIndex((s) => s.component === c);
    return i < 0 ? null : left.splice(i, 1)[0]!;
  };
  const placed: SitePlanSection[] = [];
  for (const slot of template.sections) {
    const from = take(slot.component);
    if (from) placed.push(sectionFor(slot, from));
  }
  const sections = [...placed, ...left.map((s) => ({ ...s }))].slice(0, PLAN_MAX_SECTIONS);
  const seen = new Set<string>();
  for (const s of sections) {
    const name = s.name;
    let id = planSectionId(name);
    for (let n = 2; seen.has(id); n++) {
      const suffix = ` ${n}`;
      s.name = `${name.slice(0, 32 - suffix.length).trimEnd()}${suffix}`;
      id = planSectionId(s.name);
    }
    seen.add(id);
  }
  return { ...out, plan: { ...plan, pages: plan.pages.map((p) => (p === home ? { ...home, sections } : p)) } };
}

function neutralPreset(template: SiteTemplate): ThemePreset {
  const base = getThemePreset(template.look.base)!;
  return {
    ...base,
    name: "template",
    colors: {
      background: "#ffffff",
      foreground: "#1f2328",
      primary: "#3b3f46",
      primaryForeground: "#ffffff",
      accent: "#eceef1",
      muted: "#f4f5f7",
      mutedForeground: "#5d636c",
      border: "#e3e5e8",
      inverseBackground: "#1f2328",
      inverseForeground: "#ffffff",
    },
  };
}

export type PublicSiteTemplate = {
  id: string;
  v: number;
  label: string;
  blurb: string;
  good_for: string;
  idea: string;
  layout: BriefLayout;
  fonts: { display: string; body: string };
  theme_css: string;
  preview: {
    name: string;
    eyebrow: string;
    headline: string;
    subtitle: string;
    primary_action: string;
    hero_variant?: string;
    sections: Array<{ title: string; body: string; kind: string; variant?: string; tone?: string }>;
  };
};

function publicTemplate(t: SiteTemplate): PublicSiteTemplate {
  const preset = neutralPreset(t);
  const hero = t.sections.find((s) => s.component === "Hero");
  return {
    id: t.id,
    v: t.v,
    label: t.label,
    blurb: t.blurb,
    good_for: t.good_for,
    idea: t.idea,
    layout: t.look.layout,
    fonts: preset.fonts,
    theme_css: renderThemeCss(preset),
    preview: {
      name: "Your business",
      eyebrow: t.good_for.split(",")[0]!.trim(),
      headline: t.sample.headline,
      subtitle: t.sample.subtitle,
      primary_action: t.action.label,
      ...(hero?.variant ? { hero_variant: hero.variant } : {}),
      sections: t.sections
        .filter((s) => s !== hero)
        .map((s) => ({ title: s.name, body: s.purpose[0]!.toUpperCase() + s.purpose.slice(1), kind: s.component, ...(s.variant ? { variant: s.variant } : {}), ...(s.tone ? { tone: s.tone } : {}) })),
    },
  };
}

let cachedPublic: PublicSiteTemplate[] | null = null;

export function publicSiteTemplates(): PublicSiteTemplate[] {
  cachedPublic ??= SITE_TEMPLATES.map(publicTemplate);
  return cachedPublic;
}

export type TemplateChoice =
  | { ok: true; template: SiteTemplate | null }
  | { ok: false; code: "template_blanks" | "invalid_template"; message: string };

export function templateChoiceFrom(raw: unknown, idea: string): TemplateChoice {
  if (raw === undefined || raw === null || raw === "") return { ok: true, template: null };
  const template = getSiteTemplate(raw);
  if (!template) return { ok: false, code: "invalid_template", message: "That template is not available any more. Pick another one, or remove it and describe your idea." };
  const blanks = unfilledTemplateBlanks(idea);
  if (blanks.length) {
    return { ok: false, code: "template_blanks", message: `Fill in the parts in brackets first: ${blanks.join(", ")}.` };
  }
  return { ok: true, template };
}
