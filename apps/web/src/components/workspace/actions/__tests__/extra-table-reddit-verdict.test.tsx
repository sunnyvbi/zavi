// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable } from "../ExtraTable";
import { redditKpiTables } from "../../agent/reddit/extraTables";
import type { RedditInsights } from "../../agent/reddit/types";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

const community = (over: Partial<RedditInsights["communities"][number]>) => ({
  name: "smallbusiness",
  relevance: 82,
  relevance_why: null,
  subscribers: null,
  posts_per_day: null,
  posts_per_day_capped: false,
  rules_verdict: null,
  selected: true,
  saved: true,
  recommended: false,
  reply_opportunities: 0,
  ...over,
});

const PAYLOAD = {
  connected: true,
  insights: {
    has_data: true,
    threshold: 60,
    kpis: {
      brand_mentions: { value: 0, previous: null, brand_terms: 0 },
      reply_opportunities: { value: 0, previous: null, on_google: null },
      relevant_posts: { value: 0, previous: null, scanned: 0 },
      relevant_comments: { value: 0, previous: null, scanned: 0 },
      subreddits: { value: 2, top: null },
    },
    communities: [community({}), community({ name: "r/Entrepreneur", saved: false, recommended: true })],
    opportunities: [],
    keyword_stats: {},
    competitors: [],
    lists: { brand_mentions: [], relevant_posts: [], relevant_comments: [] },
  },
  workspace: { keywords: [], competitors: [], communities: [] },
} as unknown as Parameters<typeof redditKpiTables>[0];

const subreddits = (onChanged?: () => void) =>
  redditKpiTables(PAYLOAD, onChanged).find((t) => t.id === "reddit_subreddits")!;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const setVerdict = (name: string, value: string) => {
  const row = screen.getByText(name).closest("tr")!;
  fireEvent.change(within(row).getByRole("combobox"), { target: { value } });
};

it("saves through the settings route the Settings tab uses, never a second one", async () => {
  apiFetch
    .mockResolvedValueOnce(
      ok({
        fields: {
          communities: [
            { id: "c1", item: "smallbusiness", item_type: null, status: "tracking", origin: "suggested", note: "Owners ask here" },
            { id: "c2", item: "sysadmin", item_type: "allowed", status: "paused", origin: "custom", note: null },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(ok({ fields: {} }));

  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/smallbusiness", "banned");
  await flush();

  expect(apiFetch.mock.calls[0][0]).toBe("/api/channels/reddit_organic/settings");
  const [url, init] = apiFetch.mock.calls[1];
  expect(url).toBe("/api/channels/reddit_organic/settings/communities");
  expect(init.method).toBe("PUT");
  const sent = JSON.parse(init.body as string) as { items: Array<Record<string, unknown>> };
  expect(sent.items).toEqual([
    { id: "c1", item: "smallbusiness", item_type: "banned", status: "tracking", origin: "suggested", note: "Owners ask here" },
    { id: "c2", item: "sysadmin", item_type: "allowed", status: "paused", origin: "custom", note: null },
  ]);
});

it("never writes through the reddit workspace route, which validates this column differently", async () => {
  apiFetch.mockResolvedValueOnce(ok({ fields: { communities: [] } })).mockResolvedValueOnce(ok({ fields: {} }));
  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/smallbusiness", "allowed");
  await flush();
  expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/reddit/workspace/communities"))).toBe(false);
});

it("adds a scored subreddit nobody had saved, and does not point Zavi at one that bans it", async () => {
  apiFetch.mockResolvedValueOnce(ok({ fields: { communities: [] } })).mockResolvedValueOnce(ok({ fields: {} }));
  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/Entrepreneur", "banned");
  await flush();
  const sent = JSON.parse(apiFetch.mock.calls[1][1].body as string) as { items: Array<Record<string, unknown>> };
  expect(sent.items).toEqual([
    { item: "Entrepreneur", item_type: "banned", status: "paused", origin: "custom" },
  ]);
});

it("matches an existing row however its name was typed, rather than adding a duplicate", async () => {
  apiFetch
    .mockResolvedValueOnce(ok({ fields: { communities: [{ id: "c1", item: "r/SmallBusiness", item_type: null }] } }))
    .mockResolvedValueOnce(ok({ fields: {} }));
  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/smallbusiness", "unclear");
  await flush();
  const sent = JSON.parse(apiFetch.mock.calls[1][1].body as string) as { items: Array<Record<string, unknown>> };
  expect(sent.items).toHaveLength(1);
  expect(sent.items[0]).toEqual({ id: "c1", item: "r/SmallBusiness", item_type: "unclear" });
});

it("sends null for a verdict taken back, not an empty string the route would refuse", async () => {
  apiFetch
    .mockResolvedValueOnce(ok({ fields: { communities: [{ id: "c1", item: "smallbusiness", item_type: "banned" }] } }))
    .mockResolvedValueOnce(ok({ fields: {} }));
  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/smallbusiness", "");
  await flush();
  const sent = JSON.parse(apiFetch.mock.calls[1][1].body as string) as { items: Array<Record<string, unknown>> };
  expect(sent.items[0].item_type).toBeNull();
});

it("says who can change it when the route refuses, instead of asking for a retry that cannot work", async () => {
  apiFetch
    .mockResolvedValueOnce(ok({ fields: { communities: [] } }))
    .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
  render(<ExtraTable data={subreddits()} />);
  setVerdict("r/smallbusiness", "allowed");
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("Only an owner or an admin can change this.");
  const row = screen.getByText("r/smallbusiness").closest("tr")!;
  expect((within(row).getByRole("combobox") as HTMLSelectElement).value).toBe("");
});

it("re-reads the page once the verdict lands, so the rest of it agrees", async () => {
  const onChanged = vi.fn();
  apiFetch.mockResolvedValueOnce(ok({ fields: { communities: [] } })).mockResolvedValueOnce(ok({ fields: {} }));
  render(<ExtraTable data={subreddits(onChanged)} />);
  setVerdict("r/smallbusiness", "allowed");
  await flush();
  expect(onChanged).toHaveBeenCalledTimes(1);
});
