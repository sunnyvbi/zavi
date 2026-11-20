
export const MIN_IDEA = 8;

export const IDEA_TOO_SHORT_HINT = "Add a few more words so Zavi knows what to build, for example what the site is for.";

export const IDEA_EXAMPLES_LABEL = "Or start from an example:";

export const IDEA_EXAMPLES: ReadonlyArray<{ label: string; idea: string }> = [
  { label: "Bakery website", idea: "A website for my bakery with the menu, opening hours and a contact form." },
  { label: "Dog grooming bookings", idea: "A booking site for my dog grooming shop where customers pick a service and a time slot." },
  { label: "Photography portfolio", idea: "A portfolio site for my photography with a gallery and an enquiry form." },
  { label: "Yoga studio timetable", idea: "A site for my yoga studio with the class timetable, prices and a sign-up form." },
];

export const ideaValid = (idea: string): boolean => idea.trim().length >= MIN_IDEA;

export const IDEA_IMAGE_MAX_COUNT = 3;
export const IDEA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IDEA_IMAGE_TOTAL_MAX_CHARS = 4_000_000;
export const IDEA_IMAGE_TYPE_ERROR = "Images must be PNG, JPEG or WebP.";
export const IDEA_IMAGE_SIZE_ERROR = "Each image must be 5 MB or smaller.";
export const IDEA_IMAGE_COUNT_ERROR = `You can attach up to ${IDEA_IMAGE_MAX_COUNT} images.`;
export const IDEA_IMAGE_TOTAL_ERROR = "These images are too large together. Try smaller images.";

export const isIdeaImageDataUrl = (v: unknown): v is string =>
  typeof v === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(v);

export const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export function addIdeaImage(held: readonly string[], base64: string, mime: string): { images: string[] } | { error: string } {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) return { error: IDEA_IMAGE_TYPE_ERROR };
  if (base64Bytes(base64) > IDEA_IMAGE_MAX_BYTES) return { error: IDEA_IMAGE_SIZE_ERROR };
  if (held.length >= IDEA_IMAGE_MAX_COUNT) return { error: IDEA_IMAGE_COUNT_ERROR };
  const url = `data:${mime};base64,${base64}`;
  if (held.reduce((n, u) => n + u.length, 0) + url.length > IDEA_IMAGE_TOTAL_MAX_CHARS) return { error: IDEA_IMAGE_TOTAL_ERROR };
  return { images: [...held, url] };
}

export const BRAINSTORM_MAX_TURNS = 20;

export const RESEARCH_STEPS = [
  "Scanning competitors…",
  "Reading the market…",
  "Mapping pricing models…",
  "Finding the gap…",
  "Pulling it together…",
];

export type BrainstormMsg = { role: "agent" | "user"; text: string; options?: string[]; recommended?: string };

export type Landscape = {
  competitors?: Array<{ name: string; angle: string }>;
  market?: string;
  pricing?: string;
  gap?: string;
  wedge?: string;
  v1?: string;
  sources?: Array<{ title: string; url: string }>;
  grounded?: boolean;
};

export function landscapeForRequest(l: Landscape | null) {
  return l ? { competitors: l.competitors, market: l.market, pricing: l.pricing, gap: l.gap, wedge: l.wedge, v1: l.v1 } : undefined;
}

export function hasLandscape(l: Landscape | null): boolean {
  return !!l && ((l.competitors?.length ?? 0) > 0 || !!l.wedge || !!l.market || !!l.gap || !!l.v1);
}

export function canUseIdea(o: { userTurns: number; done: boolean; landscape: Landscape | null; messages: number }): boolean {
  return o.userTurns >= 2 || o.done || (!!o.landscape && o.messages > 0);
}
