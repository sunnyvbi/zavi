
export const PAGE_DESIGN_GUIDE = `# Building a page someone will open, read and forward

Your page is one self-contained HTML document. It is shown in a locked frame, so
these are HARD limits, enforced in code. Anything else silently fails to load:
- Scripts only from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net/npm/
  (pin an exact version, load the UMD build, put the <script src> before the
  inline script that uses it). Most pages need no library at all.
- Fonts only from Google Fonts (<link href="https://fonts.googleapis.com/css2?...">),
  always with a system fallback stack.
- Images only as inline SVG or data: URIs. No remote images.
- No fetch, XHR, WebSocket, forms or remote embeds. Put the data IN the page.
- Links to other sites and new windows do not open. Show a source as plain text
  (the site name and page), not as a link.
- Under 200KB. A focused page is 20-80KB.

## 1. Decide what the page is for
Name the reader and the one job the page does for them ("the board sees whether
Q3 paid off", "a new hire learns how refunds work"). Every section earns its
place against that job. Use the tenant's real figures from this run. Never
invent a number, and say where each figure came from.

Pick the treatment the job calls for:
- A report, plan or explainer: calm and readable. Real type hierarchy, generous
  spacing, no giant hero.
- A dashboard or tool: scanned, not read. Summary first, then detail. Encode
  state in shape as well as colour (a chip, a stripe), and make interactive
  things look interactive. Open it in a realistic working state, never empty.
- A launch page or showcase: allowed one bold idea. Spend it in one place.

## 2. Tokens, and both themes
Define every colour as a CSS custom property on :root: the full light palette.
Then redefine ONLY those properties for dark mode:
  @media (prefers-color-scheme: dark) { :root { ...dark values... } }
Style every element through the properties, never a raw hex. Give body an
explicit background and text colour. Tint neutrals slightly toward your accent
instead of pure grey. Check the accent still reads on the dark ground.

## 3. Type
Pair a display face (used sparingly) with a body face; a mono face for data if
it helps. Set a small type scale and stay on it. Body text around 65 characters
wide, line-height about 1.5. Headings get text-wrap: balance. Numbers that line
up in columns get font-variant-numeric: tabular-nums. Avoid the default-looking
choices (Inter everywhere, a purple-to-blue gradient hero, emoji as section
markers, everything centred, the same rounded card on every block).

## 4. Layout that survives a phone
Lay out groups with flex or grid and gap. Keep a side gutter of at least 16px at
every width, set once on body or one wrapper. Rows wrap to one column near 400px
wide. Nothing gets a min-width wider than the screen; only tables, code and
charts may scroll sideways, each inside its own overflow-x: auto box. The page
body must never scroll horizontally.

## 5. Structure means something
Numbering, dividers, eyebrows and labels should encode something true (a real
sequence, a real category). Lift only what needs lifting: border, shadow and
fill each say "separate object". Repeated items share edges, padding and
baselines.

## 6. Charts
One scale places marks, ticks and labels. Every label names a value the chart
reaches. Chart text uses the theme properties so it reads in both themes. Leave
room for the outermost labels. Prefer inline SVG for a simple chart; load a
library only when it does real work.

## 7. Words
Write from the reader's side ("your refunds", not "refund_events table"). Active
voice. A button says what it does. A <title> that names the page in two to four
words, not a sentence. No lorem, no placeholder copy, no em dashes.

## 8. Finish
Everything meant to be read is visible on load, without scrolling to trigger it.
Close every tag, double-quote attributes, give keyboard focus a visible outline,
and respect prefers-reduced-motion.
`;

export type GuideBrandKit = {
  primary?: string | null;
  accent?: string | null;
  bg?: string | null;
  text?: string | null;
  source?: string;
  source_url?: string | null;
};

const NEUTRAL_PALETTE =
  "--bg:#fafafa --surface:#ffffff --surface-2:#f4f4f5 --border:#e4e4e7 " +
  "--text:#09090b --text-muted:#71717a --accent:#18181b --accent-fg:#fafafa";

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexOrNull = (v: string | null | undefined): string | null =>
  typeof v === "string" && HEX.test(v.trim()) ? v.trim().toLowerCase() : null;

export function brandGuideSection(kit: GuideBrandKit | null | undefined): string {
  const primary = hexOrNull(kit?.primary);
  const unknown = !kit || kit.source === "default" || !primary;
  if (unknown) {
    return `
## 9. Colours — we do not know this customer's brand

We could not read a brand colour off this customer's site. So do NOT invent one:
a page in a confident wrong colour reads as carelessness, and a stock indigo or
purple-to-blue gradient reads as a template. Use this neutral palette as the
tokens from section 2, and carry the emphasis with type, space and rules instead
of with a hue:
  ${NEUTRAL_PALETTE}
Say nothing on the page about brand colours or about what we could or could not
read; the reader is here for the content.
`;
  }
  const parts = [`main ${primary}`];
  const accent = hexOrNull(kit?.accent);
  const bg = hexOrNull(kit?.bg);
  const text = hexOrNull(kit?.text);
  if (accent) parts.push(`accent ${accent}`);
  if (bg) parts.push(`background ${bg}`);
  if (text) parts.push(`text ${text}`);
  const where = kit?.source === "manual" ? "set by the customer" : "read from their own site";
  return `
## 9. Colours — this customer's brand, ${where}

  ${parts.join(" · ")}

These are THEIR hexes, not a palette suggestion. Use the main colour as the
\`--accent\` token from section 2 and tint the neutrals toward it. Do not
substitute a different hue because it would look better, and do not add a second
brand-looking colour of your own. If the main colour fails contrast on a surface
(AA, 4.5:1 for text), keep it for the large or decorative element and use the
neutral text colour for the copy — never quietly swap it for a colour they do
not use.
`;
}
