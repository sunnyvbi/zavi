
import type { ZaviHead } from "./vite-zavi-head";

export const PRIVATE_PATHS = ["/admin", "/account", "/login", "/auth"];

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const attr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function siteOrigin(head: ZaviHead): string {
  const raw = (head.url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch {
    return "";
  }
}

export function isPrivatePath(path: string): boolean {
  return PRIVATE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

export function pagePathOf(fileName: string): string | null {
  if (!/\.html$/i.test(fileName) || fileName.startsWith("/") || fileName.includes("..")) return null;
  if (fileName === "index.html") return "/";
  if (/^404\.html$/i.test(fileName)) return null;
  const path = `/${fileName.replace(/(?:^|\/)index\.html$/i, "").replace(/\.html$/i, "")}`;
  return path === "/" ? null : path;
}

export function robotsTxt(origin: string): string {
  const lines = ["User-agent: *", "Allow: /"];
  for (const p of PRIVATE_PATHS) lines.push(`Disallow: ${p}$`, `Disallow: ${p}?`, `Disallow: ${p}/`);
  if (origin) lines.push("", `Sitemap: ${origin}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

export function sitemapXml(origin: string, paths: string[], lastmod: string): string {
  const unique = [...new Set(["/", ...paths])].filter((p) => !isPrivatePath(p)).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
  const urls = unique.map(
    (p) => `  <url>\n    <loc>${xml(origin + (p === "/" ? "/" : p))}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

const HAS_CANONICAL = /<link\b[^>]*\brel\s*=\s*["']canonical["']/i;

function beforeHeadClose(html: string, tag: string): string {
  const at = html.search(/<\/head>/i);
  return at < 0 ? html : `${html.slice(0, at)}    ${tag}\n  ${html.slice(at)}`;
}

export function withCanonicalLink(html: string, origin: string, path: string): string {
  if (!origin || HAS_CANONICAL.test(html)) return html;
  return beforeHeadClose(html, `<link rel="canonical" href="${attr(origin + path)}" />`);
}

type EmitFile = (file: { type: "asset"; fileName: string; source: string }) => string;
type Bundle = Record<string, { type: string; fileName?: string; source?: unknown }>;
type FsLike = { existsSync(path: string): boolean };

async function shipsOwn(publicDir: string, name: string): Promise<boolean> {
  if (!publicDir) return false;
  try {
    const spec = "node:fs";
    const fs = (await import( spec)) as FsLike;
    return fs.existsSync(`${publicDir.replace(/\/+$/, "")}/${name}`);
  } catch {
    return false;
  }
}

export function zaviSeo(head: ZaviHead) {
  const origin = siteOrigin(head);
  let publicDir = "";
  return {
    name: "zavi-seo",
    enforce: "post" as const,
    configResolved(config: { publicDir?: string }) {
      publicDir = config.publicDir ?? "";
    },
    async generateBundle(this: { emitFile: EmitFile }, _options: unknown, bundle: Bundle) {
      const paths: string[] = [];
      for (const [fileName, file] of Object.entries(bundle)) {
        if (file.type !== "asset") continue;
        const path = pagePathOf(fileName);
        if (!path) continue;
        if (path !== "/") {
          file.source = withCanonicalLink(String(file.source ?? ""), origin, path);
          paths.push(path);
        }
      }
      if (!bundle["robots.txt"] && !(await shipsOwn(publicDir, "robots.txt"))) {
        this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(origin) });
      }
      if (origin && !bundle["sitemap.xml"] && !(await shipsOwn(publicDir, "sitemap.xml"))) {
        const lastmod = new Date().toISOString().slice(0, 10);
        this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(origin, paths, lastmod) });
      }
    },
  };
}
