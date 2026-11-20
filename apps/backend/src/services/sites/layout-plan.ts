
import { planSectionId } from "./design-fidelity";
import type { BriefLayout, PlanComponent, PlanTone, SitePlan, SitePlanPage, SitePlanSection } from "./design-brief";

type Shape = {
  hero: { photo: string; plain: string };
  variants: Partial<Record<PlanComponent, { photo?: string; plain: string }>>;
  lead: PlanComponent[];
  tones?: Partial<Record<PlanComponent, PlanTone>>;
  quiet?: boolean;
};

export const LAYOUT_SHAPES: Readonly<Record<BriefLayout, Shape>> = {
  split: {
    hero: { photo: "split", plain: "centered" },
    variants: { Features: { photo: "alternating", plain: "cards" }, Testimonials: { plain: "cards" }, Gallery: { plain: "grid" }, CTA: { photo: "split", plain: "banner" } },
    lead: [],
  },
  centered: {
    hero: { photo: "image", plain: "centered" },
    variants: { Features: { plain: "cards" }, Testimonials: { plain: "cards" }, Gallery: { plain: "grid" }, CTA: { plain: "banner" } },
    lead: [],
  },
  editorial: {
    hero: { photo: "editorial", plain: "editorial" },
    variants: { Features: { photo: "split", plain: "cards" }, Testimonials: { plain: "quote" }, Gallery: { plain: "feature" }, CTA: { plain: "banner" } },
    lead: [],
  },
  bold: {
    hero: { photo: "image", plain: "image" },
    variants: { Features: { plain: "icons" }, Testimonials: { plain: "quote" }, Gallery: { plain: "masonry" }, CTA: { plain: "banner" } },
    lead: [],
    tones: { Stats: "inverse", CTA: "inverse" },
  },
  minimal: {
    hero: { photo: "minimal", plain: "minimal" },
    variants: { Features: { plain: "icons" }, Testimonials: { plain: "quote" }, Gallery: { plain: "grid" }, CTA: { plain: "banner" } },
    lead: ["Gallery"],
    quiet: true,
  },
};

export function layoutFits(layout: BriefLayout, photos: boolean): boolean {
  return layout !== "split" || photos;
}

function heroOf(sections: readonly SitePlanSection[]): number {
  return sections.findIndex((s) => s.component === "Hero");
}

function withVariant(sec: SitePlanSection, shape: Shape): SitePlanSection {
  const c = sec.component;
  if (!c || c === "Hero") return sec;
  const want = shape.variants[c];
  const out: SitePlanSection = { ...sec };
  if (want) out.variant = sec.image && want.photo ? want.photo : want.plain;
  const tone = shape.tones?.[c];
  if (tone) out.tone = tone;
  else if (shape.quiet && out.tone === "inverse") out.tone = "muted";
  return out;
}

function heroFor(sec: SitePlanSection, shape: Shape): SitePlanSection {
  return { ...sec, variant: sec.image ? shape.hero.photo : shape.hero.plain };
}

function idsAreOrderFree(sections: readonly SitePlanSection[]): boolean {
  return new Set(sections.map((s) => planSectionId(s.name))).size === sections.length;
}

function reorder(sections: SitePlanSection[], lead: readonly PlanComponent[]): SitePlanSection[] {
  const hero = heroOf(sections);
  if (hero < 0 || lead.length === 0 || !idsAreOrderFree(sections)) return sections;
  const moved: SitePlanSection[] = [];
  for (const c of lead) {
    const i = sections.findIndex((s, j) => j > hero && s.component === c && !moved.includes(s));
    if (i >= 0) moved.push(sections[i]!);
  }
  if (moved.length === 0) return sections;
  const rest = sections.filter((s) => !moved.includes(s));
  const at = rest.indexOf(sections[hero]!) + 1;
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

function mapHome(plan: SitePlan, fn: (home: SitePlanPage) => SitePlanPage): SitePlan {
  return { ...plan, pages: plan.pages.map((p) => (p.path === "/" ? fn(p) : p)) };
}

export function planForLayout(plan: SitePlan, layout: BriefLayout): SitePlan {
  const shape = LAYOUT_SHAPES[layout];
  return mapHome(plan, (home) => {
    const hero = heroOf(home.sections);
    const sections = home.sections.map((s, i) => (i === hero ? heroFor(s, shape) : withVariant(s, shape)));
    return { ...home, sections: reorder(sections, shape.lead) };
  });
}

export function planHeroForLayout(plan: SitePlan, layout: BriefLayout): SitePlan {
  const shape = LAYOUT_SHAPES[layout];
  return mapHome(plan, (home) => {
    const hero = heroOf(home.sections);
    if (hero < 0) return home;
    return {
      ...home,
      sections: home.sections.map((s, i) =>
        i === hero ? heroFor(s, shape) : s.component === "Features" && s.variant === "alternating" && !s.image ? { ...s, variant: "cards" } : s,
      ),
    };
  });
}
