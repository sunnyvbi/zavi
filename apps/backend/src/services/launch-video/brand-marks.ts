import { LOGO_SVG_B64 } from "./brand-marks.data";

const BRANDS: { file: string; title: string; hex: string; patterns: RegExp[] }[] = [
  {
    file: "stripe.svg",
    title: "Stripe",
    hex: "#635BFF",
    patterns: [/\bstripe\s+(payments?|checkout|connect|billing|integration)\b/i, /\b(pay|paid|pays|paying|powered|built|runs?)\s+(with|on|by|through|via)\s+stripe\b/i],
  },
  { file: "github-icon.svg", title: "GitHub", hex: "#181717", patterns: [/\bgithub\b/i] },
  { file: "slack-color.svg", title: "Slack", hex: "#4A154B", patterns: [/\bslack\b/i] },
  { file: "whatsapp-icon.svg", title: "WhatsApp", hex: "#25D366", patterns: [/\bwhats\s?app\b/i] },
  { file: "telegram-icon.svg", title: "Telegram", hex: "#26A5E4", patterns: [/\btelegram\b/i] },
  { file: "instagram-channel.svg", title: "Instagram", hex: "#E4405F", patterns: [/\binstagram\b/i] },
  { file: "tiktok-channel.svg", title: "TikTok", hex: "#000000", patterns: [/\btiktok\b/i] },
  { file: "youtube-channel.svg", title: "YouTube", hex: "#FF0000", patterns: [/\byoutube\b/i] },
  { file: "reddit-channel.svg", title: "Reddit", hex: "#FF4500", patterns: [/\breddit\b/i] },
  { file: "linkedin-channel.svg", title: "LinkedIn", hex: "#0A66C2", patterns: [/\blinkedin\b/i] },
  { file: "google-icon.svg", title: "Google", hex: "#4285F4", patterns: [/\bgoogle\b/i] },
  { file: "google-ads-icon.svg", title: "Google Ads", hex: "#4285F4", patterns: [/\bgoogle ads\b/i] },
  { file: "meta-icon.svg", title: "Meta", hex: "#0081FB", patterns: [/\bmeta ads\b/i, /\bfacebook\b/i] },
  { file: "teams.svg", title: "Microsoft Teams", hex: "#6264A7", patterns: [/\bmicrosoft teams\b/i] },
];

export type BrandMark = { title: string; src: string; hex: string };

export function resolveBrandMarks(fields: string[], max = 5): BrandMark[] {
  const haystack = fields.filter(Boolean).join("\n");
  if (!haystack.trim()) return [];
  const out: BrandMark[] = [];
  for (const brand of BRANDS) {
    if (out.length >= max) break;
    if (!brand.patterns.some((re) => re.test(haystack))) continue;
    const b64 = LOGO_SVG_B64[brand.file];
    if (b64) out.push({ title: brand.title, src: `data:image/svg+xml;base64,${b64}`, hex: brand.hex });
  }
  return out;
}
