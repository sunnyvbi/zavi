import sharp from "sharp";
import type { PostDraftContent } from "@zavi/shared";

const dimensions = { feed: [1080, 1350], square: [1080, 1080], story: [1080, 1920], pin: [1000, 1500] } satisfies Record<string, [number, number]>;
function escapeXml(value: string) { return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char] ?? ""); }

export async function renderPostArtwork(source: Buffer, content: PostDraftContent): Promise<Buffer> {
  const [width, height] = dimensions[content.size ?? "feed"];
  const image = sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: "cover", position: "centre" });
  if (content.headline?.trim()) {
    const lines = content.headline.trim().match(/.{1,26}(?:\s|$)|\S{1,26}/g) ?? [];
    const text = lines.slice(0, 5).map((line, index) => `<text x="64" y="${height - 64 - (lines.length - 1 - index) * 86}" fill="white" font-family="sans-serif" font-size="72" font-weight="600">${escapeXml(line.trim())}</text>`).join("");
    image.composite([{ input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="black" stop-opacity="0"/><stop offset="1" stop-color="black" stop-opacity="0.8"/></linearGradient></defs><rect x="0" y="${height - 420}" width="${width}" height="420" fill="url(#fade)"/>${text}</svg>`) }]);
  }
  return image.jpeg({ quality: 90 }).toBuffer();
}
