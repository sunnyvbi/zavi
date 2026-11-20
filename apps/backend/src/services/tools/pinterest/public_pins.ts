
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";

const PIDGET_BASE = "https://widgets.pinterest.com/v3/pidgets";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_500_000;

const USERNAME = /^[A-Za-z0-9_]{3,30}$/;
const BOARD_SLUG = /^[a-z0-9-]{1,100}$/;
const RESERVED_SEGMENTS = new Set(["pin", "search", "ideas", "today", "business", "_"]);

export function pinterestUsername(raw: string): string {
  const t = raw.trim();
  const m = t.match(/pinterest\.[a-z.]+\/([^/?#]+)/i);
  const bare = (m ? m[1] : t).replace(/^@+/, "").replace(/\/+$/, "");
  return bare;
}

const inputSchema = z.object({
  username: z.string().min(1).max(200),
  board: z.string().min(1).max(100).optional(),
  max_pins: z.number().int().min(1).max(50).default(25),
});

type RawPin = {
  id?: string;
  description?: string | null;
  link?: string | null;
  domain?: string | null;
  repin_count?: number | null;
  is_video?: boolean | null;
  board?: { name?: string | null; url?: string | null; follower_count?: number | null } | null;
  aggregated_pin_data?: { aggregated_stats?: { saves?: number | null } | null } | null;
  images?: Record<string, { width?: number; height?: number }> | null;
};

type RawUser = {
  full_name?: string | null;
  about?: string | null;
  follower_count?: number | null;
  pin_count?: number | null;
  profile_url?: string | null;
};

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function aspectOf(images: RawPin["images"]): string | null {
  if (!images) return null;
  const orig = images.orig ?? images["736x"] ?? Object.values(images)[0];
  if (!orig?.width || !orig?.height) return null;
  const r = orig.height / orig.width;
  if (Math.abs(r - 1.5) < 0.06) return "2:3";
  if (Math.abs(r - 1) < 0.06) return "1:1";
  if (Math.abs(r - 1.25) < 0.06) return "4:5";
  if (Math.abs(r - 16 / 9) < 0.08) return "9:16";
  return r > 1 ? "tall" : "wide";
}

export function mapPin(p: RawPin) {
  const saves = num(p.aggregated_pin_data?.aggregated_stats?.saves);
  return {
    pin_url: p.id ? `https://www.pinterest.com/pin/${p.id}/` : null,
    description: clip(p.description, 240),
    link: clip(p.link?.replace(/&amp;/g, "&"), 240),
    domain: clip(p.domain, 80),
    saves,
    repins: num(p.repin_count),
    is_video: p.is_video ?? null,
    aspect: aspectOf(p.images),
    board: clip(p.board?.name, 80),
  };
}

export type PinterestPublicPinsResult = ReturnType<typeof summarise>;

export function summarise(
  username: string,
  board: string | null,
  user: RawUser | null,
  rawPins: RawPin[],
  maxPins: number,
) {
  const pins = rawPins.map(mapPin);
  const kept = pins.slice(0, maxPins);
  const saves = pins.map((p) => p.saves).filter((s): s is number => s !== null);
  const domains = new Map<string, number>();
  for (const p of pins) if (p.domain) domains.set(p.domain, (domains.get(p.domain) ?? 0) + 1);
  const aspects = new Map<string, number>();
  for (const p of pins) if (p.aspect) aspects.set(p.aspect, (aspects.get(p.aspect) ?? 0) + 1);
  const top = [...pins]
    .filter((p) => p.saves !== null)
    .sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0))
    .slice(0, 5);
  return {
    source: "pinterest_public_widget" as const,
    fetched_at: new Date().toISOString(),
    username,
    board,
    profile: user
      ? {
          full_name: clip(user.full_name, 120),
          about: clip(user.about, 300),
          followers: num(user.follower_count),
          pins_total: num(user.pin_count),
          profile_url: clip(user.profile_url, 200),
        }
      : null,
    summary: {
      pins_read: pins.length,
      median_saves: median(saves),
      max_saves: saves.length ? Math.max(...saves) : null,
      video_pins: pins.filter((p) => p.is_video).length,
      link_domains: Object.fromEntries([...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)),
      image_aspects: Object.fromEntries(aspects),
      top_by_saves: top,
    },
    pins: kept,
    cannot_see:
      "No post dates, impressions, outbound clicks, pin clicks or save rate: those are the account owner's analytics. Saves are what other people saved, never reach. This is the most recent ~50 pins, not the archive.",
  };
}

export const pinterestPublicPinsTool: ToolSpec = {
  name: "pinterest_public_pins",
  effect: "read",
  description:
    "Read ONE public Pinterest account's most recent pins (up to 50), free, nothing connected. Give `username` (a username, @username or pinterest.com profile URL), optionally `board` (a board slug) to read one board. Returns the profile (followers, pins_total, about), per-pin description, destination link and domain, public save count, video flag, image aspect and board, plus a summary computed over every pin read: median/max saves, which domains the pins send traffic to, the image-aspect mix and the top 5 pins by saves. Use it for the company's own account and for 2-3 competitor accounts. Cannot see post dates, impressions, clicks or save rate.",
  input_schema: inputSchema,
  async execute(_ctx, input) {
    const { username: rawUser, board, max_pins } = inputSchema.parse(input);
    const username = pinterestUsername(rawUser);
    if (RESERVED_SEGMENTS.has(username.toLowerCase())) {
      throw new ExpectedToolError(
        "tool_input_invalid",
        `"${rawUser}" is a Pinterest pin or search link, not an account. Pass the account's profile URL, e.g. https://www.pinterest.com/acmehome/.`,
      );
    }
    if (!USERNAME.test(username)) {
      throw new ExpectedToolError(
        "tool_input_invalid",
        `"${rawUser}" is not a Pinterest username. Pass the part after pinterest.com/, e.g. "acmehome".`,
      );
    }
    if (board && !BOARD_SLUG.test(board)) {
      throw new ExpectedToolError("tool_input_invalid", `"${board}" is not a board slug (lowercase, digits, hyphens).`);
    }
    const url = board
      ? `${PIDGET_BASE}/boards/${username}/${board}/pins/`
      : `${PIDGET_BASE}/users/${username}/pins/`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let text: string;
    let status: number;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; ZaviBot/1.0; +https://zaviagent.com)" },
        signal: ac.signal,
      });
      status = res.status;
      text = (await res.text()).slice(0, MAX_BYTES);
    } catch (e) {
      throw new ExpectedToolError(
        "pinterest_public_unavailable",
        `Could not reach Pinterest's public widget (${(e as Error).name}). Treat this account as UNREAD, not as having no pins.`,
      );
    } finally {
      clearTimeout(timer);
    }

    let json: { status?: string; data?: { pins?: RawPin[]; user?: RawUser } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (status === 404 || (json && json.status !== "success" && /not ?found/i.test(text))) {
      throw new ExpectedToolError(
        "tool_no_data",
        `Pinterest has no public account "${username}"${board ? ` with board "${board}"` : ""}. Check the spelling from their site's Pinterest link before concluding they are not on Pinterest.`,
      );
    }
    if (status !== 200 || !json || json.status !== "success" || !Array.isArray(json.data?.pins)) {
      throw new ExpectedToolError(
        "pinterest_public_unavailable",
        `Pinterest's public widget answered HTTP ${status} for "${username}". Treat this account as UNREAD, not as empty.`,
      );
    }
    const pins = json.data!.pins!;
    if (pins.length === 0) {
      throw new ExpectedToolError(
        "tool_no_data",
        `"${username}" exists but the public widget returned 0 pins. That is "could not verify", not "they never pin".`,
      );
    }
    return summarise(username, board ?? null, json.data?.user ?? null, pins, max_pins);
  },
};
