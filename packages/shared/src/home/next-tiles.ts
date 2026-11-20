import { CHANNELS } from "../channels/registry";

export type NextTileKind = "plan" | "channel" | "ask" | "talk" | "make";

export type NextTile = {
  kind: NextTileKind;
  state: string;
  key: string;
  label: string;
  detail: string;
};

export type NextTilePrompt = { label: string; prompt: string };

export const NEXT_TILE_THINK_PROMPTS: readonly NextTilePrompt[] = [
  { label: "Plan my next month", prompt: "What's my 30 day marketing strategy?" },
  {
    label: "Find my target customer",
    prompt: "Who's my target customer and what pain points should I lead with?",
  },
  { label: "My competitors", prompt: "Show me the competitors I'm tracking" },
  { label: "Position my product", prompt: "How do you think we should position our product?" },
  { label: "Write a one-liner", prompt: "Write me a one-liner that sells my product better" },
  {
    label: "Grow organic traffic",
    prompt: "How can we grow our organic traffic in the next 90 days?",
  },
];

export const NEXT_TILE_MAKE_PROMPTS: readonly NextTilePrompt[] = [
  { label: "Design social posts", prompt: "Design a set of Instagram posts for my product" },
  { label: "Make a deck", prompt: "Make me a short deck that explains what we do" },
  {
    label: "Write a blog post",
    prompt: "Write a blog post that could rank for what my customers search",
  },
  {
    label: "Size up a competitor",
    prompt: "Pick my closest competitor and tell me where they beat me",
  },
];

export type NextTilesInput = {
  plan: "none" | "drafting" | "ready";
  planOpened: boolean;
  planChannels: string[];
  channelStatus: Record<string, string | null>;
  channelLocks?: Record<string, string | null> | null;
  messagingConnected: boolean;
  asked: Record<string, string>;
  made: Record<string, string>;
};

const WORKING_STATUSES = new Set(["queued", "running"]);
const FALLBACK_CHANNELS = ["seo"];

const CHANNEL_NAME_BY_SLUG: ReadonlyMap<string, string> = new Map(
  CHANNELS.map((c) => [c.slug as string, c.name as string]),
);

function titleCase(slug: string): string {
  return slug
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function channelDisplayName(slug: string): string {
  return CHANNEL_NAME_BY_SLUG.get(slug) ?? titleCase(slug);
}

function planTile(input: NextTilesInput): NextTile | null {
  if (input.plan === "none") {
    return {
      kind: "plan",
      state: "see",
      key: "plan",
      label: "See your growth plan",
      detail: "Zavi writes it from your site",
    };
  }
  if (input.plan === "drafting") {
    return {
      kind: "plan",
      state: "writing",
      key: "plan",
      label: "Your plan is being written",
      detail: "Ready in about 15 minutes",
    };
  }
  if (!input.planOpened) {
    return {
      kind: "plan",
      state: "open",
      key: "plan",
      label: "Open your growth plan",
      detail: "Your plan is ready to read",
    };
  }
  return null;
}

function channelTile(input: NextTilesInput): NextTile | null {
  const order =
    input.plan === "ready" && input.planChannels.length > 0
      ? input.planChannels
      : FALLBACK_CHANNELS;
  const seen = new Set<string>();
  for (const slug of order) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const status = input.channelStatus[slug] ?? null;
    const name = channelDisplayName(slug);
    if (status === null) {
      const locks = input.channelLocks;
      if (locks !== undefined && !(locks && slug in locks && locks[slug] === null)) continue;
      return {
        kind: "channel",
        state: "run",
        key: slug,
        label: `Run ${name}`,
        detail: `Opens ${name}. Run it from there`,
      };
    }
    if (WORKING_STATUSES.has(status)) {
      return {
        kind: "channel",
        state: "working",
        key: slug,
        label: `${name} is working`,
        detail: "Open to watch it work",
      };
    }
  }
  return null;
}

function askTile(p: NextTilePrompt): NextTile {
  return {
    kind: "ask",
    state: "ask",
    key: p.prompt,
    label: p.label,
    detail: "Answer in about a minute",
  };
}

const TALK_TILE: NextTile = {
  kind: "talk",
  state: "connect",
  key: "messaging",
  label: "Connect WhatsApp or Slack",
  detail: "Connect in Messaging",
};

function makeTile(p: NextTilePrompt): NextTile {
  return {
    kind: "make",
    state: "make",
    key: p.prompt,
    label: p.label,
    detail: "Zavi makes it in chat",
  };
}

export function resolveNextTiles(input: NextTilesInput): NextTile[] {
  const tiles: NextTile[] = [];
  const has = (t: NextTile) => tiles.some((x) => x.kind === t.kind && x.key === t.key);
  const push = (t: NextTile | null) => {
    if (t && tiles.length < 3 && !has(t)) tiles.push(t);
  };

  push(planTile(input));
  push(channelTile(input));

  const nextAsk = NEXT_TILE_THINK_PROMPTS.find((p) => !(p.prompt in input.asked));
  if (nextAsk) push(askTile(nextAsk));

  if (!input.messagingConnected) push(TALK_TILE);

  const nextMake = NEXT_TILE_MAKE_PROMPTS.find((p) => !(p.prompt in input.made));
  if (nextMake) push(makeTile(nextMake));

  if (tiles.length < 3) {
    const ts = (p: NextTilePrompt) => {
      const at = input.asked[p.prompt];
      if (at === undefined) return -Infinity;
      const ms = Date.parse(at);
      return Number.isNaN(ms) ? -Infinity : ms;
    };
    const fill = NEXT_TILE_THINK_PROMPTS.map((p, i) => ({ p, i })).sort(
      (a, b) => ts(a.p) - ts(b.p) || a.i - b.i,
    );
    for (const { p } of fill) push(askTile(p));
  }

  return tiles;
}

export const DEFAULT_NEXT_TILES: NextTile[] = resolveNextTiles({
  plan: "none",
  planOpened: false,
  planChannels: [],
  channelStatus: {},
  messagingConnected: true,
  asked: {},
  made: {},
});

export function isFirstRunDone(input: NextTilesInput): boolean {
  if (!input.planOpened) return false;
  if (Object.keys(input.asked).length === 0) return false;
  return Object.entries(input.channelStatus).some(
    ([slug, status]) => status !== null && CHANNEL_NAME_BY_SLUG.has(slug),
  );
}
