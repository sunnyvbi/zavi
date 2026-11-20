
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { MAX_IMAGES_PER_CALL } from "./generate";
import { SITE_IMAGES_TOOL_NAME } from "./sandbox-tool";

export type SiteImagePlan = { subjects: string[]; style: string } | null;

export const SITE_ICONS_RULE =
  "Icons come from `lucide-react` (in the starter; if `package.json` lacks it, add it exact-pinned): `import { Calendar, MapPin, Phone } from \"lucide-react\"` and `<Calendar className=\"h-5 w-5\" aria-hidden=\"true\" />`, sized and coloured with Tailwind, next to a text label (or with an `aria-label` when the icon is the only content of a button). Use one icon per feature, service or contact line where it helps scanning. Never use emoji as icons, and never draw icons as hand-written SVG paths.";

export function siteImagesPromptFragment(input: SiteImagePlan): string {
  if (input && input.subjects.length === 0) {
    return `### Images and icons\nThe founder asked for no photos: do not call \`${SITE_IMAGES_TOOL_NAME}\`. Carry the look with type, colour, spacing and icons.\n${SITE_ICONS_RULE}`;
  }
  const subjects = (input?.subjects ?? [])
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_IMAGES_PER_CALL);
  const style = input?.style?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "";
  const plan = subjects.length
    ? `\nThe design brief's photos (one entry each, in this style${style ? "" : " of the site"}):\n${renderUntrustedBlock(
        "image_plan",
        [...subjects.map((s, i) => `${i + 1}. ${s.slice(0, 300)}`), ...(style ? [`Style: ${style}`] : [])].join("\n"),
      )}`
    : "\nPick the photos from the idea: a hero that shows what this business does or sells, plus up to three for the key sections (a service, the place, the product, the people at work). Be specific to this business: its trade, setting and customers.";
  return `### Images and icons
The site gets real photos. Call \`${SITE_IMAGES_TOOL_NAME}\` ONCE, in the same turn as your first file write so the first preview is not held up, with a hero (\`slug: "hero"\`, the plan's aspect or \`16:9\`) and up to ${MAX_IMAGES_PER_CALL - 1} more for the key sections (\`4:5\` or \`1:1\`). Write each prompt as a scene: subject, setting, light, mood and the site's palette, consistent across all photos; no text, logos or real people's names. Give each a plain alt that says what it shows, its \`role\`, and the plan's \`placement\`, \`overlay\` and \`focal\` when it has them${subjects.length && style ? ", and `style` set to the Style line" : ""}.${plan}
Then pass each returned image's \`{src, srcset, width, height, alt, focal}\` as the section's \`image\` (\`SiteImage\` sets sizes, lazy loading and the focal crop). Outside the section library use \`<img src={src} srcSet={srcset} sizes="(min-width: 1024px) 50vw, 100vw" width={width} height={height} alt={alt} className="h-full w-full object-cover" />\` (\`sizes="100vw"\` for a full-width hero; \`loading="lazy"\` for images below the first screen). The home page shows the hero photo near the top. Images are files in \`public/images/\`: use only the \`/images/\` files this tool returns or the founder's own photos (those first; a generated photo is never presented as the business's real staff, products or customers); never an image URL from another site, a stock photo link or a placeholder service (the publish check fails a hotlinked image). If a photo is skipped or the call returns none, do not call again for it: build that block's no-image layout (with the starter's sections, leave \`image\` out: Hero falls back to centered, Features alternating to an icon panel, CTA split to the banner, Gallery drops it; by hand, a brand-colour or gradient panel with the headline). Never ship a placeholder (a box labelled "image" or "photo", an image icon standing in for a photo, a grey empty frame), a broken image or an \`<img>\` pointing at a file that does not exist: the publish check fails them.
${SITE_ICONS_RULE}`;
}
