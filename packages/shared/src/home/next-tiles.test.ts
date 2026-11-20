import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEXT_TILES,
  isFirstRunDone,
  NEXT_TILE_MAKE_PROMPTS,
  NEXT_TILE_THINK_PROMPTS,
  resolveNextTiles,
  type NextTilesInput,
} from "./next-tiles";

const base = (over: Partial<NextTilesInput> = {}): NextTilesInput => ({
  plan: "none",
  planOpened: false,
  planChannels: [],
  channelStatus: {},
  messagingConnected: true,
  asked: {},
  made: {},
  ...over,
});

const T = NEXT_TILE_THINK_PROMPTS;
const M = NEXT_TILE_MAKE_PROMPTS;
const allAsked = (): Record<string, string> =>
  Object.fromEntries(T.map((p, i) => [p.prompt, `2026-09-0${i + 1}T00:00:00Z`]));
const allMade = (): Record<string, string> =>
  Object.fromEntries(M.map((p) => [p.prompt, "2026-09-01T00:00:00Z"]));

describe("resolveNextTiles", () => {
  it("first login: plan see, SEO run, first think prompt", () => {
    const tiles = resolveNextTiles(base());
    expect(tiles).toEqual([
      { kind: "plan", state: "see", key: "plan", label: "See your growth plan", detail: "Zavi writes it from your site" },
      { kind: "channel", state: "run", key: "seo", label: "Run SEO", detail: "Opens SEO. Run it from there" },
      { kind: "ask", state: "ask", key: T[0].prompt, label: T[0].label, detail: "Answer in about a minute" },
    ]);
    expect(DEFAULT_NEXT_TILES).toEqual(tiles);
  });

  it("drafting shows the writing tile", () => {
    expect(resolveNextTiles(base({ plan: "drafting" }))[0]).toMatchObject({
      kind: "plan",
      state: "writing",
      label: "Your plan is being written",
      detail: "Ready in about 15 minutes",
    });
  });

  it("ready and not opened shows open", () => {
    expect(resolveNextTiles(base({ plan: "ready" }))[0]).toMatchObject({
      kind: "plan",
      state: "open",
      label: "Open your growth plan",
      detail: "Your plan is ready to read",
    });
  });

  it("ready and opened drops the plan tile", () => {
    const tiles = resolveNextTiles(base({ plan: "ready", planOpened: true }));
    expect(tiles.some((t) => t.kind === "plan")).toBe(false);
    expect(tiles).toHaveLength(3);
  });

  it("uses plan channel order when the plan is ready", () => {
    const tiles = resolveNextTiles(base({ plan: "ready", planChannels: ["meta_ads", "seo"] }));
    expect(tiles[1]).toMatchObject({ kind: "channel", key: "meta_ads", label: "Run Meta Ads" });
  });

  it("skips a channel the plan does not include, and offers no Run while the plan is unknown", () => {
    const locked = resolveNextTiles(
      base({ plan: "ready", planChannels: ["meta_ads", "seo"], channelLocks: { meta_ads: "pro", seo: null } }),
    );
    expect(locked.find((t) => t.kind === "channel")).toMatchObject({ key: "seo", label: "Run SEO" });
    const unknown = resolveNextTiles(base({ plan: "ready", planChannels: ["seo"], channelLocks: null }));
    expect(unknown.some((t) => t.kind === "channel" && t.state === "run")).toBe(false);
    expect(unknown).toHaveLength(3);
  });

  it("falls back to SEO when there is no plan, even with plan channels", () => {
    const tiles = resolveNextTiles(base({ plan: "drafting", planChannels: ["meta_ads"] }));
    expect(tiles[1]).toMatchObject({ kind: "channel", key: "seo" });
  });

  it("queued or running shows working", () => {
    for (const s of ["queued", "running"]) {
      const tiles = resolveNextTiles(base({ channelStatus: { seo: s } }));
      expect(tiles[1]).toMatchObject({
        kind: "channel",
        state: "working",
        label: "SEO is working",
        detail: "Open to watch it work",
      });
    }
  });

  it("a channel that ran moves to the next channel", () => {
    const tiles = resolveNextTiles(
      base({ plan: "ready", planChannels: ["seo", "x_organic"], channelStatus: { seo: "succeeded" } }),
    );
    expect(tiles.find((t) => t.kind === "channel")).toMatchObject({ key: "x_organic", state: "run" });
  });

  it("title-cases an unknown slug", () => {
    const tiles = resolveNextTiles(base({ plan: "ready", planChannels: ["some_new_thing"] }));
    expect(tiles.find((t) => t.kind === "channel")?.label).toBe("Run Some New Thing");
  });

  it("all channels run skips the channel tile", () => {
    const tiles = resolveNextTiles(
      base({ plan: "ready", planOpened: true, planChannels: ["seo"], channelStatus: { seo: "failed" } }),
    );
    expect(tiles.some((t) => t.kind === "channel")).toBe(false);
    expect(tiles).toHaveLength(3);
  });

  it("talk shows only when messaging is not connected", () => {
    const off = resolveNextTiles(
      base({ plan: "ready", planOpened: true, channelStatus: { seo: "succeeded" }, messagingConnected: false }),
    );
    expect(off.find((t) => t.kind === "talk")).toEqual({
      kind: "talk",
      state: "connect",
      key: "messaging",
      label: "Connect WhatsApp or Slack",
      detail: "Connect in Messaging",
    });
    const on = resolveNextTiles(
      base({ plan: "ready", planOpened: true, channelStatus: { seo: "succeeded" } }),
    );
    expect(on.some((t) => t.kind === "talk")).toBe(false);
  });

  it("ask skips asked prompts", () => {
    const tiles = resolveNextTiles(base({ asked: { [T[0].prompt]: "2026-09-01T00:00:00Z" } }));
    expect(tiles[2]).toMatchObject({ kind: "ask", key: T[1].prompt });
  });

  it("make skips made prompts", () => {
    const tiles = resolveNextTiles(
      base({
        plan: "ready",
        planOpened: true,
        channelStatus: { seo: "succeeded" },
        made: { [M[0].prompt]: "2026-09-01T00:00:00Z" },
      }),
    );
    expect(tiles.find((t) => t.kind === "make")).toEqual({
      kind: "make",
      state: "make",
      key: M[1].prompt,
      label: M[1].label,
      detail: "Zavi makes it in chat",
    });
  });

  it("fills to 3 with think prompts, oldest asked first, never duplicating", () => {
    const asked = allAsked();
    asked[T[3].prompt] = "2026-08-01T00:00:00Z";
    const tiles = resolveNextTiles(
      base({ plan: "ready", planOpened: true, channelStatus: { seo: "succeeded" }, asked, made: allMade() }),
    );
    expect(tiles.map((t) => t.key)).toEqual([T[3].prompt, T[0].prompt, T[1].prompt]);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(3);
  });

  it("always returns exactly 3 tiles", () => {
    const inputs: NextTilesInput[] = [
      base(),
      base({ plan: "ready", planOpened: true, asked: allAsked(), made: allMade() }),
      base({ plan: "drafting", messagingConnected: false }),
      base({ plan: "ready", planChannels: ["seo"], channelStatus: { seo: "running" } }),
    ];
    for (const i of inputs) expect(resolveNextTiles(i)).toHaveLength(3);
  });

  it("copy carries no em or en dashes", () => {
    const all = JSON.stringify([
      resolveNextTiles(base({ messagingConnected: false })),
      resolveNextTiles(base({ plan: "drafting", channelStatus: { seo: "running" } })),
      resolveNextTiles(base({ plan: "ready", planOpened: true, channelStatus: { seo: "x" }, messagingConnected: false })),
    ]);
    expect(all).not.toMatch(/[–—]/);
  });
});

describe("isFirstRunDone", () => {
  const base = {
    plan: "ready" as const,
    planOpened: true,
    planChannels: [],
    channelStatus: { seo: "succeeded" } as Record<string, string | null>,
    messagingConnected: false,
    asked: { [NEXT_TILE_THINK_PROMPTS[0].prompt]: "2026-09-22T00:00:00Z" },
    made: {},
  };
  it("is true once the plan was opened, a channel ran and a question was asked", () => {
    expect(isFirstRunDone(base)).toBe(true);
  });
  it("is false until the plan was opened", () => {
    expect(isFirstRunDone({ ...base, planOpened: false })).toBe(false);
  });
  it("is false until a question was asked", () => {
    expect(isFirstRunDone({ ...base, asked: {} })).toBe(false);
  });
  it("is false until a channel ran; a non-channel agent's run does not count", () => {
    expect(isFirstRunDone({ ...base, channelStatus: { seo: null } })).toBe(false);
    expect(isFirstRunDone({ ...base, channelStatus: { operator: "succeeded" } })).toBe(false);
  });
});
