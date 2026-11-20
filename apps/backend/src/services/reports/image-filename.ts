
export function safeFilename(raw: string | undefined, index: number, ext: "png" | "svg" = "png"): string {
  const base = (raw && raw.trim()) || `image-${index + 1}`;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  const name = cleaned || `image-${index + 1}`;
  if (ext === "svg") return /\.svg$/i.test(name) ? name : `${name.replace(/\.(png|jpe?g)$/i, "")}.svg`;
  return /\.(png|jpe?g)$/i.test(name) ? name : `${name}.png`;
}
