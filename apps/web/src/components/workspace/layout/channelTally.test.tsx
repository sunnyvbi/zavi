// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
  pending: {} as Record<string, number>,
  channels: [] as Array<{ slug: string; locked_tier: string | null; work_state?: string }>,
}));

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => "/workspace?tab=channels",
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    approvalsPending: 0,
    openAgentTab: vi.fn(),
    openTab: vi.fn(),
    tenantName: "Acme Bikes",
    role: "owner",
  }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({ decisions: [], channel_pending_counts: api.pending }),
      };
    if (path.startsWith("/api/channels/"))
      return { ok: true, json: async () => ({ actions: [], more: 0, store: "channel_actions" }) };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: api.channels.map((c) => ({
            channel_slug: c.slug,
            delivery_mode: "produce",
            work_state: c.work_state ?? "idle",
            priority: 1,
            last_run_at: null,
            connected: false,
            connectors: [],
            runnable: true,
            locked: false,
            locked_tier: c.locked_tier,
          })),
        }),
      };
    return { ok: false, json: async () => ({}) };
  }),
}));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { ChannelsWheel } from "./ChannelsWheel";
import { ChannelsPanel } from "./ChannelsPanel";
import { needYouTally } from "./channelTally";

const entry = (slug: string, over: Partial<ChannelEntry> = {}): ChannelEntry =>
  ({
    channel: { slug, name: slug.toUpperCase(), connectors: [] },
    count: 0,
    waiting: 0,
    subtitle: null,
    lock: null,
    ...over,
  }) as unknown as ChannelEntry;
const pro = { kind: "plan", label: "Pro plan", tier: "pro" } as const;
const starter = { kind: "plan", label: "Starter plan", tier: "starter" } as const;

const MIXED = [
  entry("seo", { waiting: 3 }),
  entry("reddit_organic", { waiting: 0, subtitle: "Done" }),
  entry("x_organic", { waiting: 0 }),
  entry("meta_ads", { waiting: 20, lock: pro, running: true }),
  entry("google_ads", { waiting: 3, lock: pro }),
  entry("tiktok_organic", { waiting: 0, lock: starter, running: true }),
];
const ALL_LOCKED = [
  entry("seo", { waiting: 0 }),
  entry("meta_ads", { waiting: 20, lock: pro, running: true }),
  entry("google_ads", { waiting: 6, lock: pro }),
];

const needYou = () => document.querySelector("[data-need-you]")?.textContent ?? null;
const centre = () => document.querySelector<HTMLElement>("[data-wheel-centre]")!;
const banner = () =>
  screen.queryAllByRole("status").find((el) => /Zavi is working on/.test(el.textContent ?? ""))?.textContent ?? null;

function page(entries: ChannelEntry[]) {
  return (
    <ChannelsPage
      entries={entries}
      loading={false}
      onShow={() => {}}
      onUpgrade={() => {}}
      renderDetail={() => null}
      companyName="Acme"
    />
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  api.pending = {};
  api.channels = [];
});

describe("needYouTally", () => {
  it("leaves plan-locked work out of the items and the channels", () => {
    expect(needYouTally(MIXED)).toEqual({ items: 3, channels: 1, lockedOnly: false });
  });

  it("is locked-only when every channel with work is behind a plan", () => {
    expect(needYouTally(ALL_LOCKED)).toEqual({ items: 0, channels: 0, lockedOnly: true });
  });

  it("is not locked-only when the open work is only already seen", () => {
    const seen = [entry("seo", { waiting: 4, noticeWaiting: 0 }), entry("meta_ads", { waiting: 9, lock: pro })];
    expect(needYouTally(seen)).toEqual({ items: 0, channels: 0, lockedOnly: false });
  });

  it("is not locked-only when nothing waits anywhere", () => {
    expect(needYouTally([entry("seo"), entry("meta_ads", { lock: pro })]).lockedOnly).toBe(false);
  });
});

describe("ChannelsPage header, list view", () => {
  beforeEach(() => window.localStorage.setItem("zavi:channels-view", "list"));

  it("counts only open work, while the working-on banner still counts locked channels", () => {
    render(page(MIXED));
    expect(needYou()).toBe("3 items need you");
    expect(banner()).toContain("Zavi is working on 2 channels for Acme.");
  });

  it("says Upgrade instead of a count when all the work is locked, and keeps the banner", () => {
    render(page(ALL_LOCKED));
    expect(needYou()).toBe("Upgrade to start your channels");
    expect(document.body.textContent).not.toMatch(/items? needs? you/);
    expect(banner()).toContain("Zavi is working on 1 channel for Acme.");
  });

  it("follows a lock that lands mid-session, both ways", () => {
    const open = MIXED.map((e) => (e.channel.slug === "google_ads" ? { ...e, lock: null } : e));
    const view = render(page(open));
    expect(needYou()).toBe("6 items need you");
    view.rerender(page(MIXED));
    expect(needYou()).toBe("3 items need you");
    view.rerender(page(ALL_LOCKED));
    expect(needYou()).toBe("Upgrade to start your channels");
    view.rerender(page(open));
    expect(needYou()).toBe("6 items need you");
  });
});

describe("ChannelsWheel centre", () => {
  it("counts open actions across only the channels that have them", () => {
    render(<ChannelsWheel entries={MIXED} onOpen={() => {}} onUpgrade={() => {}} />);
    expect(centre().textContent).toContain("3actions across 1 channel");
    expect(centre().textContent).not.toContain("26");
  });

  it("says Upgrade when every channel with work is locked", () => {
    render(<ChannelsWheel entries={ALL_LOCKED} onOpen={() => {}} onUpgrade={() => {}} />);
    expect(centre().querySelector("[data-wheel-upgrade]")?.textContent).toBe("Upgrade to start your channels");
    expect(centre().textContent).not.toMatch(/across/);
  });

  it("the page header and the wheel centre agree on the Wheel", () => {
    window.localStorage.setItem("zavi:channels-view", "wheel");
    render(page(MIXED));
    expect(needYou()).toBe("3 items need you");
    expect(centre().textContent).toContain("3actions across 1 channel");
    expect(banner()).toContain("Zavi is working on 2 channels");
  });
});

describe("ChannelsPanel rail", () => {
  it("the collapsed badge leaves out plan-locked channels", async () => {
    api.pending = { seo: 4, meta_ads: 20, google_ads: 2 };
    api.channels = [
      { slug: "seo", locked_tier: null },
      { slug: "meta_ads", locked_tier: "pro" },
      { slug: "google_ads", locked_tier: "pro" },
    ];
    render(<ChannelsPanel collapsed width={56} onToggle={() => {}} />);
    const button = await screen.findByRole("button", { name: "Show channels: 4 items need you" });
    expect(button.textContent).toBe("4");
    expect(screen.queryByRole("button", { name: /26 items|24 items|22 items/ })).toBeNull();
  });

  it("the collapsed rail says Upgrade when all the work is locked", async () => {
    api.pending = { meta_ads: 20, google_ads: 6 };
    api.channels = [
      { slug: "seo", locked_tier: null },
      { slug: "meta_ads", locked_tier: "pro", work_state: "running" },
      { slug: "google_ads", locked_tier: "pro" },
    ];
    render(<ChannelsPanel collapsed width={56} onToggle={() => {}} />);
    const button = await screen.findByRole("button", { name: "Show channels: Upgrade to start your channels" });
    expect(button.textContent).toBe("");
  });

  it("the open panel's header counts the same thing", async () => {
    api.pending = { seo: 4, meta_ads: 20, google_ads: 2 };
    api.channels = [
      { slug: "seo", locked_tier: null },
      { slug: "meta_ads", locked_tier: "pro", work_state: "running" },
      { slug: "google_ads", locked_tier: "pro" },
    ];
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByLabelText("4 pending");
    expect(screen.queryByLabelText("26 pending")).toBeNull();
    expect(screen.getByText("2 actions waiting")).toBeTruthy();
  });
});
