
export type PostCell = { text: string; strong?: boolean; dim?: boolean; sub?: string; href?: string };
export type PostColumn = { label: string; width: number; right?: boolean };
export type TopPostsTable = {
  title: string;
  columns: PostColumn[];
  rows: Array<{ id: string; cells: PostCell[] }>;
  empty: string;
  caption: string | null;
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function postedDate(iso: unknown): string {
  if (typeof iso !== "string") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const POST: PostColumn = { label: "Post", width: 190 };
const col = (label: string, width = 78): PostColumn => ({ label, width, right: true });

const count = (v: unknown, strong = false): PostCell => {
  const n = num(v);
  return n === null ? { text: "—", dim: true } : { text: fmt(n), ...(strong ? { strong: true } : {}) };
};

function postCell(p: Rec, noText: string, sub?: string): PostCell {
  const text = typeof p.text === "string" && p.text ? p.text : noText;
  return { text, ...(sub ? { sub } : {}), ...(typeof p.url === "string" && p.url ? { href: p.url } : {}) };
}

function xSub(p: Rec): string {
  const bits = [typeof p.format === "string" && p.format ? p.format.charAt(0).toUpperCase() + p.format.slice(1) : null];
  if (p.source === "zavi") bits.push("Zavi wrote it");
  return bits.filter(Boolean).join(" · ");
}

export function topPostsTable(slug: string, payload: unknown): TopPostsTable | null {
  const d = rec(payload);
  if (!d || !Array.isArray(d.top_posts)) return null;
  const posts = (d.top_posts as unknown[]).map(rec).filter((p): p is Rec => !!p);
  const id = (p: Rec, i: number) => (typeof p.id === "string" ? p.id : `post-${i}`);
  switch (slug) {
    case "x_organic":
      return {
        title: "Top posts",
        columns: [POST, col("Views"), col("Likes"), col("Replies"), col("Reposts"), col("Bookmarks", 92), col("Eng. rate", 92), col("Posted")],
        rows: posts.map((p, i) => ({
          id: id(p, i),
          cells: [
            postCell(p, "(no text)", xSub(p) || undefined),
            count(p.views, true),
            count(p.likes),
            count(p.replies),
            count(p.reposts),
            count(p.bookmarks),
            num(p.eng_rate) === null ? { text: "—", dim: true } : { text: `${p.eng_rate}%`, strong: true, sub: `${fmt(num(p.views) ?? 0)} views` },
            { text: postedDate(p.posted_at) },
          ],
        })),
        empty: d.connected === true ? "Nothing published in this window yet." : "Connect X to see your posts here.",
        caption: null,
      };
    case "linkedin_organic":
      return {
        title: "Top posts",
        columns: [POST, col("Reactions", 100), col("Comments", 104), col("Reposts"), col("Posted")],
        rows: posts.map((p, i) => ({
          id: id(p, i),
          cells: [postCell(p, "(no text)"), count(p.reactions, true), count(p.comments), count(p.reposts), { text: postedDate(p.posted_at) }],
        })),
        empty: d.page_url ? "No public posts on this page yet." : "Save your LinkedIn page in Settings to see its posts here.",
        caption: "Public counts from your LinkedIn page. LinkedIn shows views to the author only.",
      };
    case "instagram_organic":
      return {
        title: "Top posts",
        columns: [POST, col("Views"), col("Likes"), col("Comments", 104), col("Saves"), col("Posted")],
        rows: posts.map((p, i) => ({
          id: id(p, i),
          cells: [postCell(p, "(no caption)"), count(p.views, true), count(p.likes), count(p.comments), count(p.saves), { text: postedDate(p.posted_at) }],
        })),
        empty: d.connected ? "No posts read yet. Refresh reads your account's latest posts." : "Connect Instagram in Settings and Zavi reads your own posts' real numbers.",
        caption: "Your account's own insights from Instagram. Views replaced impressions in April 2025.",
      };
    case "tiktok_organic":
      return {
        title: "Top posts",
        columns: [POST, col("Views"), col("Likes"), col("Comments", 104), col("Shares"), col("Posted")],
        rows: posts.map((p, i) => ({
          id: id(p, i),
          cells: [postCell(p, "(no caption)"), count(p.views, true), count(p.likes), count(p.comments), count(p.shares), { text: postedDate(p.posted_at) }],
        })),
        empty: d.connected ? "No posts read yet. Refresh reads your account's recent posts." : "Connect TikTok in Settings and Zavi reads your own posts' real numbers.",
        caption: "Your account's own counts from TikTok's API, across your recent public posts.",
      };
    default:
      return null;
  }
}

export const TOP_POSTS_SHOWN = 3;
