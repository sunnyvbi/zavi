import type { ArchetypeKit } from "@/services/agents/archetype-kits/types";

export const LANDING_KIT: ArchetypeKit = {
  slug: "landing",
  title: "Marketing landing page",
  summary:
    "A single-purpose marketing site that sells one thing and captures intent: " +
    "hero with the promise, proof, how-it-works, pricing, FAQ, and a capture " +
    "form wired to a real table. NO authentication, no app shell, no billing — " +
    "the whole page exists to convert a visitor into a lead or a signup.",
  keywords: [
    "landing page",
    "landing",
    "marketing site",
    "marketing page",
    "launch page",
    "coming soon",
    "waitlist",
    "lead capture",
    "email signup",
    "one pager",
    "one-pager",
    "splash page",
    "microsite",
    "product page",
    "sales page",
    "portfolio",
    "brochure site",
  ],
  pages: [
    {
      route: "/",
      name: "Landing",
      purpose:
        "The whole product in one scroll: hero promise, social proof, how it works, pricing, FAQ, and a closing capture form.",
      components: [
        "SiteHeader",
        "Hero",
        "LogoStrip",
        "FeatureGrid",
        "HowItWorks",
        "PricingTable",
        "FaqAccordion",
        "CaptureForm",
        "SiteFooter",
      ],
    },
    {
      route: "/thanks",
      name: "Thank you",
      purpose:
        "Post-submit confirmation that tells the visitor exactly what happens next. Distinct route so the conversion is measurable.",
      components: ["SiteHeader", "ConfirmationPanel", "SiteFooter"],
    },
  ],
  components: [
    { id: "SiteHeader", description: "Logo, a few anchor links, and one primary CTA button. Sticky on scroll." },
    { id: "Hero", description: "Headline stating the outcome, one-sentence subhead, primary CTA, and a product visual." },
    { id: "LogoStrip", description: "Row of customer or press logos for credibility. Renders nothing if no logos are supplied." },
    { id: "FeatureGrid", description: "Three to six benefit cards, each an outcome rather than a feature name." },
    { id: "HowItWorks", description: "Three numbered steps from signup to value, so the visitor can picture using it." },
    { id: "PricingTable", description: "Plan cards with the recommended plan visually pinned. Omitted when the product is pre-price." },
    { id: "FaqAccordion", description: "Expandable answers to the objections that block signup." },
    { id: "CaptureForm", description: "Email (and optional name) capture with inline validation, writing to the leads table." },
    { id: "ConfirmationPanel", description: "Success state naming the next concrete step and expected timing." },
    { id: "SiteFooter", description: "Secondary nav, contact, and legal links." },
  ],
  schema: [
    {
      name: "leads",
      purpose: "Every capture-form submission. The only table this archetype needs to be real rather than decorative.",
      columns: {
        id: "uuid pk",
        email: "text not null",
        name: "text",
        source: "text — which section or campaign the submit came from",
        referrer: "text — document.referrer at submit",
        created_at: "timestamptz",
      },
    },
  ],
  seedData: [
    "No seeded leads — an empty leads table is the correct first state, and a fake lead in a real customer's database is worse than an empty one.",
    "Placeholder hero copy, three benefit cards, three how-it-works steps and four FAQ entries written for the founder's ACTUAL product, so the page reads finished on first load.",
  ],
  responsive: [
    "Hero: side-by-side copy + visual on desktop, stacks to copy-then-visual under md, with the CTA above the fold on mobile.",
    "FeatureGrid: 1-col mobile → 2 tablet → 3 desktop.",
    "PricingTable: horizontally scrollable cards on mobile with the recommended plan first.",
    "SiteHeader: anchor links collapse into a menu button under md; the primary CTA stays visible.",
  ],
  visualDirection: {
    mood: "confident and uncluttered — generous whitespace, one strong accent, type doing most of the work.",
    layout: "single centered column of full-bleed sections, each section one idea.",
    accents: [
      "One accent color, reserved for CTAs only, so every button that matters looks the same.",
      "Large type scale on the hero headline; the promise is the loudest thing on the page.",
      "Every section ends with a path onward — the page should never dead-end before the form.",
    ],
  },
};
