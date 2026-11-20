
export const SEED_PLACEHOLDER_MARKERS: readonly string[] = [
  "<title>Your Company</title>",
  "Your company app is live.",
  "This is a working Next.js starter.",
  'data-zavi-seed="placeholder"',
  "This site is being built.",
  "A starter to-do app. Extend it.",
  "Starter blog. Add posts.",
  "Starter view. Replace mocks with real data.",
] as const;

export function looksLikeSeedPlaceholder(body: unknown): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  const haystack = body.toLowerCase();
  return SEED_PLACEHOLDER_MARKERS.some((m) =>
    m === SEED_ATTRIBUTE_MARKER
      ? haystack.includes(m) && SEED_ATTRIBUTE_COPY.every((c) => haystack.includes(c))
      : haystack.includes(m.toLowerCase()),
  );
}

const SEED_ATTRIBUTE_MARKER = 'data-zavi-seed="placeholder"';
const SEED_ATTRIBUTE_COPY: readonly string[] = ["coming soon", "this site is being built."];
