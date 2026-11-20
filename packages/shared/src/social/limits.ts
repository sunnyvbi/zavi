
export type SocialLimit = {
  text: number;
  title?: number;
  vendor_review_pending?: string;
};

export const SOCIAL_LIMITS = {
  linkedin: { text: 3000 },
  linkedin_image: { text: 3000 },
  linkedin_video: { text: 3000 },
  x: { text: 280 },
  x_image: { text: 280 },
  x_video: { text: 280 },
  reddit: { title: 300, text: 40000 },
  reddit_comment: { text: 10000 },
  instagram_image: { text: 2200 },
  instagram_video: { text: 2200 },
  youtube_video: { title: 100, text: 5000 },
  tiktok_video: { text: 2200, vendor_review_pending: "TikTok Direct Post audit" },
  pinterest_pin: { title: 100, text: 500 },
} as const satisfies Record<string, SocialLimit>;

export type SocialChannel = keyof typeof SOCIAL_LIMITS;

export function socialLimit(channel: string): SocialLimit | null {
  return (SOCIAL_LIMITS as Record<string, SocialLimit>)[channel] ?? null;
}

export const X_THREAD_MAX_PARTS = 4;

const X_URL_WEIGHT = 23;
const X_URL_RE = /((?<![a-z0-9._%+-])[a-z0-9._%+-]+[@＠][a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})|(?:https?:\/\/[^\s<>"']+)|(?:(?<![@＠\w./-])\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?:\/[^\s<>"']*)?)/gi;

function xCharWeight(cp: number): number {
  if (cp <= 0x10ff) return 1;
  if (cp >= 0x2000 && cp <= 0x200d) return 1;
  if (cp >= 0x2010 && cp <= 0x201f) return 1;
  if (cp >= 0x2032 && cp <= 0x2037) return 1;
  return 2;
}

export type XWeightedCount = {
  length: number;
  cutAt: number | null;
};

export function xWeightedLength(text: string, cap: number = SOCIAL_LIMITS.x.text): XWeightedCount {
  const urlSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(X_URL_RE)) {
    if (m.index !== undefined && m[0].length > 0 && !m[1]) urlSpans.push([m.index, m.index + m[0].length]);
  }
  let length = 0;
  let cutAt: number | null = null;
  let i = 0;
  while (i < text.length) {
    const span = urlSpans.find(([s]) => s === i);
    if (span) {
      length += X_URL_WEIGHT;
      if (cutAt === null && length > cap) cutAt = i;
      i = span[1];
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    length += xCharWeight(cp);
    if (cutAt === null && length > cap) cutAt = i;
    i += cp > 0xffff ? 2 : 1;
  }
  return { length, cutAt };
}
