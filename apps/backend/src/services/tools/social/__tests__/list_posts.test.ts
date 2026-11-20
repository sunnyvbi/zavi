
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  rows: vi.fn(),
  eqs: [] as unknown[][],
  limit: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

function field(row: Record<string, unknown>, key: string): unknown {
  return key.split(/->>?/).reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), row);
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let cap = Infinity;
      const q = {
        select: () => q,
        eq: (...a: unknown[]) => {
          m.eqs.push([table, ...a]);
          filters.push([a[0] as string, a[1]]);
          return q;
        },
        order: () => q,
        limit: (n: number, options?: unknown) => {
          if (table === "social_posts") m.limit(n, options);
          else cap = n;
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === "social_posts") return resolve({ data: m.rows(), error: null });
          const seeded = m.tables[table] ?? [];
          return resolve({ data: seeded.filter((r) => filters.every(([k, v]) => field(r, k) === v)).slice(0, cap), error: null });
        },
      };
      return q;
    },
  }),
}));

const prior = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/core/token", () => ({ priorConnectorTeamId: prior }));

import { socialListPostsTool, shapeLedgerRow } from "../list_posts";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, log: vi.fn() } as never;
const ledgerEqs = () => m.eqs.filter((e) => e[0] === "social_posts");

beforeEach(() => {
  m.rows.mockReset().mockReturnValue([]);
  m.limit.mockReset();
  prior.mockReset().mockResolvedValue(null);
  m.eqs.length = 0;
  m.tables = {};
});

describe("social__list_posts", () => {
  it("reports the published root as partial when a later thread part failed", async () => {
    m.rows.mockReturnValue([{ id: "partial", status: "published", approved_payload_snapshot: { payload: { text: "root", thread: ["two", "three"] } }, social_publish_attempts: [{ response: { id: "root-id", thread_ids: ["second-id"], thread_error: { index: 1, status: 403 } } }] }]);
    const out = await socialListPostsTool.execute(ctx, { channel: "x", limit: 5 }) as { posts: Array<Record<string, unknown>> };
    expect(out.posts[0]).toMatchObject({ status: "published", partial_thread: { publishedParts: 2, totalParts: 3 } });
    expect(m.eqs).toContainEqual(["social_posts", "tenant_id", TENANT]);
    expect(m.limit).toHaveBeenCalledWith(1, { referencedTable: "social_publish_attempts" });
  });
  it("filters by the ctx tenant and the channel, newest first, capped", async () => {
    m.rows.mockReturnValue([
      {
        id: "p1",
        status: "published",
        external_url: "https://x.com/i/web/status/1",
        external_post_id: "1",
        approved_payload_snapshot: { payload: { text: "root", thread: ["tail"] } },
        metrics: { public: { like_count: 2 } },
        metrics_read_at: "2026-09-10T00:00:00Z",
        last_error: null,
        scheduled_at: null,
        created_at: "2026-09-09T00:00:00Z",
        updated_at: "2026-09-09T00:00:00Z",
      },
    ]);
    const out = (await socialListPostsTool.execute(ctx, { channel: "x", limit: 5 })) as {
      count: number;
      posts: Array<Record<string, unknown>>;
    };
    expect(ledgerEqs()).toEqual([
      ["social_posts", "tenant_id", TENANT],
      ["social_posts", "channel", "x"],
    ]);
    expect(m.limit).toHaveBeenCalledWith(5, undefined);
    expect(out.count).toBe(1);
    expect(out.posts[0]).toMatchObject({
      id: "p1",
      text: "root",
      thread: ["tail"],
      external_url: "https://x.com/i/web/status/1",
      metrics: { public: { like_count: 2 } },
    });
  });

  it("returns only this tenant's pins still waiting for approval, with what a reuse needs", async () => {
    const OTHER = "11c9df69-0000-4000-8000-000000000002";
    const pin = (id: string, tenant_id: string, image_path: string, extra: Record<string, unknown> = {}) => ({
      id,
      tenant_id,
      status: "proposed",
      decision_class: "social.publish.v2",
      emitted_at: "2026-10-23T10:00:00Z",
      body: {
        channel: "pinterest_pin",
        scheduled_at: null,
        payload: { image_path, title: `Pin ${id}`, text: "desc", board_id: "998877", board_name: "Spring looks", link: "https://shop.example/p", alt_text: "alt" },
      },
      ...extra,
    });
    m.tables.customer_visible_pending_decisions = [
      pin("a1", TENANT, `${TENANT}/chat/pin-a.png`),
      pin("b1", OTHER, `${OTHER}/chat/pin-b.png`),
      pin("a2", TENANT, `${TENANT}/chat/x.png`, { body: { channel: "x_image", payload: { text: "x", image_path: `${TENANT}/chat/x.png` } } }),
      pin("a3", TENANT, `${TENANT}/chat/ad.png`, { decision_class: "meta_ads.launch" }),
    ];
    const out = (await socialListPostsTool.execute(ctx, { channel: "pinterest_pin" })) as {
      posts: unknown[];
      staged: Array<Record<string, unknown>>;
      note: string;
    };
    expect(out.posts).toEqual([]);
    expect(out.staged).toEqual([
      {
        id: "a1",
        status: "awaiting_approval",
        text: "desc",
        title: "Pin a1",
        image_path: `${TENANT}/chat/pin-a.png`,
        board_id: "998877",
        board_name: "Spring looks",
        link: "https://shop.example/p",
        alt_text: "alt",
        scheduled_at: null,
        created_at: "2026-10-23T10:00:00Z",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain(OTHER);
    expect(m.eqs).toContainEqual(["customer_visible_pending_decisions", "tenant_id", TENANT]);
    expect(out.note).not.toMatch(/Nothing has been staged/);
  });

  it("does not read the tenant from model input", async () => {
    const OTHER = "11c9df69-0000-4000-8000-000000000002";
    m.tables.customer_visible_pending_decisions = [
      { id: "b1", tenant_id: OTHER, decision_class: "social.publish.v2", emitted_at: "e", body: { channel: "pinterest_pin", payload: { image_path: `${OTHER}/chat/b.png` } } },
    ];
    const out = (await socialListPostsTool.execute(ctx, { channel: "pinterest_pin", tenant_id: OTHER } as never)) as { staged: unknown[] };
    expect(out.staged).toEqual([]);
  });

  it("distinguishes a changed login from an unknown destination account", async () => {
    prior.mockResolvedValue("ca_TF-OdxXiBvcF");
    const row = (id: string, account_id: string) => ({ id, account_id, transport: "composio", status: "published", external_url: null, external_post_id: null, approved_payload_snapshot: null, metrics: null, metrics_read_at: null, last_error: null, scheduled_at: null, created_at: "c", updated_at: "u" });
    m.rows.mockReturnValue([row("today", "ca_TF-OdxXiBvcF"), row("oct2", "ca_tJsCgKzbZW4C")]);
    const out = (await socialListPostsTool.execute(ctx, { channel: "instagram_image" })) as { posts: Array<{ id: string; to_connected_account: boolean | null; to_current_connection: boolean | null }> };
    expect(prior).toHaveBeenCalledWith(TENANT, "composio.instagram");
    expect(out.posts.map((p) => [p.id, p.to_connected_account])).toEqual([["today", true], ["oct2", null]]);
    expect(out.posts.map((p) => p.to_current_connection)).toEqual([true, false]);
  });

  it.each(["scheduled", "failed", "cancelled"])("does not describe a %s post as delivered to the current account", (status) => {
    const out = shapeLedgerRow({ id: "p", account_id: "legacy-uuid", transport: "composio", status, external_url: null, external_post_id: null, approved_payload_snapshot: null, metrics: null, metrics_read_at: null, last_error: null, scheduled_at: null, created_at: "c", updated_at: "u" }, "legacy-uuid");
    expect(out.to_current_connection).toBe(true);
    expect(out.to_connected_account).toBeNull();
  });

  it("leaves a native-rail post's account unknown", () => {
    expect(shapeLedgerRow({ id: "x", account_id: "native", status: "published", external_url: null, external_post_id: null, approved_payload_snapshot: null, metrics: null, metrics_read_at: null, last_error: null, scheduled_at: null, created_at: "c", updated_at: "u" }, "ca_1").to_connected_account).toBeNull();
  });

  it("defaults to 20 and says so when the ledger is empty", async () => {
    const out = (await socialListPostsTool.execute(ctx, { channel: "x" })) as { note: string };
    expect(m.limit).toHaveBeenCalledWith(20, undefined);
    expect(out.note).toMatch(/No approved posts/);
    expect(out.note).toMatch(/pending approval cards/);
  });

  it("shapeLedgerRow tolerates a missing snapshot", () => {
    const r = shapeLedgerRow({
      id: "p",
      status: "failed",
      external_url: null,
      external_post_id: null,
      approved_payload_snapshot: null,
      metrics: null,
      metrics_read_at: null,
      last_error: "vendor_rejected",
      scheduled_at: null,
      created_at: "c",
      updated_at: "u",
    });
    expect(r).toMatchObject({ text: null, thread: undefined, last_error: "vendor_rejected" });
  });
});

it.each(["x_image", "x_video", "tiktok_video", "reddit_comment"])("reads the approved %s ledger with the same tenant boundary", async channel => {
  const out = await socialListPostsTool.execute(ctx, { channel }) as { channel: string; posts: unknown[] };
  expect(out.channel).toBe(channel);
  expect(out.posts).toEqual([]);
  expect(ledgerEqs()).toEqual([["social_posts", "tenant_id", TENANT], ["social_posts", "channel", channel]]);
});
