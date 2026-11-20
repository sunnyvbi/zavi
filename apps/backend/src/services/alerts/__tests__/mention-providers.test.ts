import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { rows: Array<Record<string, unknown>>; error: { message: string } | null }>,
  calls: [] as Array<{ table: string; columns: string; filters: Array<{ op: string; col: string; val: unknown }> }>,
}));

function tableState(table: string) {
  h.tables[table] ??= { rows: [], error: null };
  return h.tables[table];
}

function fakeBuilder(table: string, columns: string) {
  const record = { table, columns, filters: [] as Array<{ op: string; col: string; val: unknown }> };
  h.calls.push(record);
  const chain: Record<string, unknown> = {};
  for (const op of ["eq", "in", "gte", "lte", "order", "limit"]) {
    chain[op] = vi.fn((col: unknown, val: unknown) => {
      record.filters.push({ op, col: String(col), val });
      return chain;
    });
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    const state = tableState(table);
    return resolve({ data: state.error ? null : state.rows, error: state.error });
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => fakeBuilder(table, columns),
    }),
  }),
}));

import { __testing } from "@/services/tenant-client";
import {
  redditMentionProvider,
  collectPendingMentions,
  type MentionProvider,
} from "../mention-providers";

const TENANT = "22222222-2222-4222-8222-222222222222";

function callFor(table: string) {
  return h.calls.find((c) => c.table === table);
}

function filtersFor(table: string) {
  return callFor(table)?.filters ?? [];
}

function mentionRow(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    term: "upcar",
    subreddit: "carrental",
    sentiment: "negative",
    observed_at: "2026-09-22T10:00:00.000Z",
    thread_id: "t1",
    comment_id: "c1",
    ...over,
  };
}

function threadRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    url: "https://reddit.com/r/carrental/x",
    title: "Anyone used Upcar?",
    removed: false,
    ...over,
  };
}

function commentRow(over: Record<string, unknown> = {}) {
  return { id: "c1", body_excerpt: "I tried Upcar last week", author: "someone", ...over };
}

beforeEach(() => {
  h.tables = {};
  h.calls = [];
});

describe("the scope registry the provider depends on", () => {
  it("classifies every table this provider reads, or the read throws at runtime", () => {
    for (const table of [
      "reddit_mentions",
      "reddit_threads",
      "reddit_comments",
      "channel_mention_alerts_sent",
    ]) {
      expect(__testing.scopeKind(table)).toBe("tenant_id");
    }
  });

  it("is what makes the read work — unregister it and the provider throws", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    __testing.unregisterForTest("reddit_mentions");
    try {
      await expect(redditMentionProvider.fetchPending(TENANT)).rejects.toThrow(
        /not classified in the scope registry/,
      );
    } finally {
      __testing.registerForTest("reddit_mentions", "tenant_id");
    }
  });
});

describe("redditMentionProvider", () => {
  it("filters every read to the caller's tenant, on all four tables", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    tableState("reddit_threads").rows = [threadRow()];
    tableState("reddit_comments").rows = [commentRow()];
    await redditMentionProvider.fetchPending(TENANT);
    for (const table of [
      "reddit_mentions",
      "channel_mention_alerts_sent",
      "reddit_threads",
      "reddit_comments",
    ]) {
      expect(filtersFor(table)).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT });
    }
  });

  it("never sends an embedded join, which the facade cannot tenant-verify", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    tableState("reddit_threads").rows = [threadRow()];
    tableState("reddit_comments").rows = [commentRow()];
    await redditMentionProvider.fetchPending(TENANT);
    for (const call of h.calls) expect(call.columns).not.toMatch(/[A-Za-z0-9_]\s*\(/);
  });

  it("only asks for brand-kind mentions", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    tableState("reddit_threads").rows = [threadRow()];
    await redditMentionProvider.fetchPending(TENANT);
    expect(filtersFor("reddit_mentions")).toContainEqual({ op: "eq", col: "kind", val: "brand" });
  });

  it("drops a mention that was already alerted", async () => {
    tableState("reddit_mentions").rows = [mentionRow({ id: "m1" }), mentionRow({ id: "m2" })];
    tableState("channel_mention_alerts_sent").rows = [{ mention_key: "m1" }];
    tableState("reddit_threads").rows = [threadRow()];
    tableState("reddit_comments").rows = [commentRow()];
    const out = await redditMentionProvider.fetchPending(TENANT);
    expect(out.map((m) => m.key)).toEqual(["m2"]);
  });

  it("scopes the already-alerted lookup to this channel and only these ids", async () => {
    tableState("reddit_mentions").rows = [mentionRow({ id: "m1" }), mentionRow({ id: "m2" })];
    tableState("reddit_threads").rows = [threadRow()];
    await redditMentionProvider.fetchPending(TENANT);
    expect(filtersFor("channel_mention_alerts_sent")).toContainEqual({
      op: "eq",
      col: "channel",
      val: "reddit_organic",
    });
    expect(filtersFor("channel_mention_alerts_sent")).toContainEqual({
      op: "in",
      col: "mention_key",
      val: ["m1", "m2"],
    });
  });

  it("looks the bodies up by id, and asks for each id once", async () => {
    tableState("reddit_mentions").rows = [
      mentionRow({ id: "m1", thread_id: "t1", comment_id: "c1" }),
      mentionRow({ id: "m2", thread_id: "t1", comment_id: null }),
    ];
    tableState("reddit_threads").rows = [threadRow()];
    tableState("reddit_comments").rows = [commentRow()];
    await redditMentionProvider.fetchPending(TENANT);
    expect(filtersFor("reddit_threads")).toContainEqual({ op: "in", col: "id", val: ["t1"] });
    expect(filtersFor("reddit_comments")).toContainEqual({ op: "in", col: "id", val: ["c1"] });
  });

  it("does not go looking for comments when no mention has one", async () => {
    tableState("reddit_mentions").rows = [mentionRow({ comment_id: null })];
    tableState("reddit_threads").rows = [threadRow()];
    const out = await redditMentionProvider.fetchPending(TENANT);
    expect(callFor("reddit_comments")).toBeUndefined();
    expect(out[0].context).toBe("r/carrental");
  });

  it("never emails a removed thread, one with no url, or one it could not read", async () => {
    tableState("reddit_mentions").rows = [
      mentionRow({ id: "gone", thread_id: "t-gone" }),
      mentionRow({ id: "nourl", thread_id: "t-nourl" }),
      mentionRow({ id: "missing", thread_id: "t-missing" }),
      mentionRow({ id: "ok", thread_id: "t1" }),
    ];
    tableState("reddit_threads").rows = [
      threadRow({ id: "t-gone", removed: true }),
      threadRow({ id: "t-nourl", url: "" }),
      threadRow(),
    ];
    tableState("reddit_comments").rows = [commentRow()];
    const out = await redditMentionProvider.fetchPending(TENANT);
    expect(out.map((m) => m.key)).toEqual(["ok"]);
  });

  it("stops before the body reads when every candidate was already alerted", async () => {
    tableState("reddit_mentions").rows = [mentionRow({ id: "m1" })];
    tableState("channel_mention_alerts_sent").rows = [{ mention_key: "m1" }];
    const out = await redditMentionProvider.fetchPending(TENANT);
    expect(out).toEqual([]);
    expect(callFor("reddit_threads")).toBeUndefined();
  });

  it("throws rather than reporting zero mentions when the read fails", async () => {
    tableState("reddit_mentions").error = { message: "boom" };
    await expect(redditMentionProvider.fetchPending(TENANT)).rejects.toThrow(/boom/);
  });

  it("throws rather than re-alerting when the already-alerted read fails", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    tableState("channel_mention_alerts_sent").error = { message: "seen-read down" };
    await expect(redditMentionProvider.fetchPending(TENANT)).rejects.toThrow(/seen-read down/);
  });

  it("throws rather than emailing a mention whose thread it could not read", async () => {
    tableState("reddit_mentions").rows = [mentionRow()];
    tableState("reddit_threads").error = { message: "threads down" };
    await expect(redditMentionProvider.fetchPending(TENANT)).rejects.toThrow(/threads down/);
  });
});

describe("collectPendingMentions", () => {
  const ok = (channel: string, key: string, observed_at: string): MentionProvider => ({
    channel,
    label: channel,
    fetchPending: async () => [
      {
        channel,
        key,
        title: key,
        excerpt: "",
        url: `https://x/${key}`,
        context: channel,
        sentiment: null,
        observed_at,
      },
    ],
  });

  it("one channel failing never hides another channel's mentions", async () => {
    const boom: MentionProvider = {
      channel: "x_organic",
      label: "X",
      fetchPending: async () => {
        throw new Error("x api down");
      },
    };
    const res = await collectPendingMentions(TENANT, [
      boom,
      ok("reddit_organic", "r1", "2026-09-22T10:00:00.000Z"),
    ]);
    expect(res.mentions.map((m) => m.key)).toEqual(["r1"]);
    expect(res.failures).toEqual([{ channel: "x_organic", error: "x api down" }]);
  });

  it("orders newest first across channels", async () => {
    const res = await collectPendingMentions(TENANT, [
      ok("reddit_organic", "old", "2026-09-20T10:00:00.000Z"),
      ok("linkedin_organic", "new", "2026-09-22T10:00:00.000Z"),
    ]);
    expect(res.mentions.map((m) => m.key)).toEqual(["new", "old"]);
  });
});
