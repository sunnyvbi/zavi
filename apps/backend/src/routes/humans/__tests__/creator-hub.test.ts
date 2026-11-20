import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  globalClient: vi.fn(),
  tenantClient: vi.fn(),
}));
vi.mock("@/services/humans/creatorReviews", () => ({ loadCreatorReputation: vi.fn() }));

import { globalClient, tenantClient } from "@/services/tenant-client";
import { makeFakeDb } from "@/services/creators/__tests__/fake-supabase";
import { buildCreatorCard, listBusinessCreatorThreads, realCreatorCardDeps, socialUrl, SELF_REPORTED_LABEL, type CreatorCardDeps } from "../creator-hub";

const MEMBER = "11111111-1111-4111-8111-111111111111";

function deps(over: Partial<CreatorCardDeps> = {}): CreatorCardDeps {
  return {
    loadMember: async () => ({
      id: MEMBER,
      slug: "maya-films",
      display_name: "Maya Films",
      city: "Austin",
      country_code: "US",
      bio: "Morning routines.",
      lanes: ["ugc_video"],
      skills: ["Food and drink"],
      intro_video_path: null,
      vetting_state: "approved",
    }),
    loadHandles: async () => [
      { platform: "tiktok", handle: "@mayafilms", followers: 12400 },
      { platform: "other", handle: "maya" },
    ],
    loadPackages: async () => [
      {
        id: "p1",
        kind: "ugc_video",
        title: "1 video for your ads",
        price_cents: 15000,
        delivery_days: 7,
        video_count: 1,
        video_length_seconds: 30,
        ad_rights_days: 90,
      },
    ],
    loadRating: async () => ({ average: 4.667, count: 3 }),
    ...over,
  };
}

describe("buildCreatorCard", () => {
  it("labels follower numbers as self-reported and prices packages with the fee function", async () => {
    const card = await buildCreatorCard(MEMBER, deps());
    expect(card?.socials[0]).toEqual({
      platform: "tiktok",
      handle: "mayafilms",
      url: "https://www.tiktok.com/@mayafilms",
      followers: 12400,
      label: SELF_REPORTED_LABEL,
    });
    expect(card?.socials[1]).toMatchObject({ url: null, followers: null });
    expect(card?.packages[0].business_total_cents).toBe(16500);
    expect(card?.rating).toEqual({ average: 4.7, count: 3 });
    expect(card?.bookable).toBe(true);
  });

  it("serves nobody who is not an approved creator", async () => {
    const card = await buildCreatorCard(
      MEMBER,
      deps({ loadMember: async () => ({ ...(await deps().loadMember(MEMBER))!, vetting_state: "removed" }) }),
    );
    expect(card).toBeNull();
  });

  it("shows no average with no reviews, and survives a failed reputation read", async () => {
    const card = await buildCreatorCard(MEMBER, deps({ loadRating: async () => Promise.reject(new Error("x")) }));
    expect(card?.rating).toEqual({ average: null, count: 0 });
  });
});

describe("socialUrl", () => {
  it("never builds a link out of something that is not a handle", () => {
    expect(socialUrl("instagram", "javascript:alert(1)")).toBeNull();
    expect(socialUrl("x", "a/b")).toBeNull();
    expect(socialUrl("youtube", "@chan")).toBe("https://www.youtube.com/@chan");
  });
});

describe("card audience and packages (grok C)", () => {
  it("reads followers only from the handle row setup writes, never public_metrics", async () => {
    const card = await buildCreatorCard(
      MEMBER,
      deps({
        loadHandles: async () => [
          { platform: "tiktok", handle: "mayafilms", followers: 48000 },
          { platform: "instagram", handle: "maya.films", followers: null },
        ],
        loadMember: async () =>
          ({
            ...(await deps().loadMember(MEMBER))!,
            public_metrics: { audience: [{ platform: "tiktok", followers: 1 }, { platform: "instagram", followers: 900 }] },
          }) as never,
      }),
    );
    expect(card?.socials.map((s) => s.followers)).toEqual([48000, null]);
  });

  it("real deps read only active UGC video packages and retry handles without followers before their migration (42703)", async () => {
    const selects: string[] = [];
    const filters: string[] = [];
    const chain = (table: string) => {
      let cols = "";
      const b: Record<string, unknown> = {};
      b.select = (c: string) => ((cols = c), selects.push(`${table}:${c}`), b);
      b.eq = (k: string, v: unknown) => (filters.push(`${table}:${k}=${String(v)}`), b);
      b.order = () => b;
      b.limit = () =>
        Promise.resolve(
          /followers/.test(cols)
            ? { data: null, error: { code: "42703", message: "column does not exist" } }
            : { data: table === "creator_packages" ? [{ id: "p1", kind: "ugc_video" }] : [{ platform: "tiktok", handle: "m" }], error: null },
        );
      return b;
    };
    vi.mocked(globalClient).mockReturnValue({ from: chain } as never);
    expect(await realCreatorCardDeps.loadHandles(MEMBER)).toEqual([{ platform: "tiktok", handle: "m" }]);
    expect(await realCreatorCardDeps.loadPackages(MEMBER)).toEqual([{ id: "p1", kind: "ugc_video" }]);
    expect(selects).toEqual([
      "human_member_handles:platform,handle,followers",
      "human_member_handles:platform,handle",
      "creator_packages:id,kind,title,price_cents,delivery_days,video_count,video_length_seconds,ad_rights_days",
    ]);
    expect(filters).toEqual(
      expect.arrayContaining(["creator_packages:kind=ugc_video", "creator_packages:active=true", `creator_packages:human_member_id=${MEMBER}`]),
    );
  });
});

describe("listBusinessCreatorThreads", () => {
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "order", "limit", "in", "eq"]) q[k] = () => q;
    (q as { then: unknown }).then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
    return q;
  };

  it("fails loudly when the names read fails, instead of returning nameless threads", async () => {
    let call = 0;
    vi.mocked(tenantClient).mockImplementation(
      () =>
        chain(
          call++ === 0
            ? { data: [{ id: "t1", human_member_id: "m1", last_message_at: null, created_at: "2026-09-01" }], error: null }
            : { data: [], error: null },
        ) as never,
    );
    vi.mocked(globalClient).mockImplementation(() => chain({ data: null, error: { message: "boom" } }) as never);
    await expect(listBusinessCreatorThreads("tenant-1")).rejects.toThrow(/human_members read failed/);
  });

  it("counts creator messages since the workspace's last reply as unread", async () => {
    const threads = [
      { id: "t1", human_member_id: "m1", last_message_at: "2026-09-03", created_at: "2026-09-01" },
      { id: "t2", human_member_id: "m2", last_message_at: "2026-09-02", created_at: "2026-09-01" },
    ];
    const messages = [
      { thread_id: "t1", body: "c3", sender_kind: "creator", created_at: "2026-09-03T03" },
      { thread_id: "t1", body: "c2", sender_kind: "creator", created_at: "2026-09-03T02" },
      { thread_id: "t2", body: "b1", sender_kind: "tenant", created_at: "2026-09-02T02" },
      { thread_id: "t1", body: "b1", sender_kind: "tenant", created_at: "2026-09-03T01" },
      { thread_id: "t1", body: "c1", sender_kind: "creator", created_at: "2026-09-03T00" },
      { thread_id: "t2", body: "c1", sender_kind: "creator", created_at: "2026-09-02T01" },
    ];
    const db = makeFakeDb({ creator_threads: threads, creator_thread_messages: messages });
    vi.mocked(tenantClient).mockImplementation(() => db.client as never);
    vi.mocked(globalClient).mockImplementation(() => chain({ data: [], error: null }) as never);
    const out = await listBusinessCreatorThreads("tenant-1");
    expect(out.map((t) => [t.thread_id, t.unread_count])).toEqual([
      ["t1", 2],
      ["t2", 0],
    ]);
  });

  it("a busy thread with 600 newer messages does not blank a quiet thread's last message or unread count", async () => {
    const threads = [
      { id: "busy", human_member_id: "m1", last_message_at: "2026-09-10T00:00:00.000Z", created_at: "2026-09-01" },
      { id: "quiet", human_member_id: "m2", last_message_at: "2026-09-02T00:00:03.000Z", created_at: "2026-09-01" },
    ];
    const base = Date.parse("2026-09-05T00:00:00.000Z");
    const busy = Array.from({ length: 600 }, (_, i) => ({
      thread_id: "busy",
      body: `busy ${i}`,
      sender_kind: i === 599 ? "tenant" : "creator",
      created_at: new Date(base + i * 1000).toISOString(),
    }));
    const quiet = [
      { thread_id: "quiet", body: "we sent the brief", sender_kind: "tenant", created_at: "2026-09-02T00:00:00.000Z" },
      { thread_id: "quiet", body: "got it", sender_kind: "creator", created_at: "2026-09-02T00:00:01.000Z" },
      { thread_id: "quiet", body: "question on the hook", sender_kind: "creator", created_at: "2026-09-02T00:00:02.000Z" },
      { thread_id: "quiet", body: "draft is up", sender_kind: "creator", created_at: "2026-09-02T00:00:03.000Z" },
    ];
    const db = makeFakeDb({ creator_threads: threads, creator_thread_messages: [...quiet, ...busy] });
    vi.mocked(tenantClient).mockImplementation(() => db.client as never);
    vi.mocked(globalClient).mockImplementation(() => chain({ data: [], error: null }) as never);
    const out = await listBusinessCreatorThreads("tenant-1");
    const byId = new Map(out.map((t) => [t.thread_id, t]));
    expect(byId.get("quiet")?.last_message).toEqual({
      body: "draft is up",
      sender_kind: "creator",
      created_at: "2026-09-02T00:00:03.000Z",
    });
    expect(byId.get("quiet")?.unread_count).toBe(3);
    expect(byId.get("busy")?.last_message?.body).toBe("busy 599");
    expect(byId.get("busy")?.unread_count).toBe(0);
  });

  it("fails loudly when one thread's message read fails", async () => {
    const threads = [
      { id: "t1", human_member_id: "m1", last_message_at: null, created_at: "2026-09-01" },
      { id: "t2", human_member_id: "m2", last_message_at: null, created_at: "2026-09-01" },
    ];
    let messageReads = 0;
    vi.mocked(tenantClient).mockImplementation(
      () =>
        ({
          from: (table: string) =>
            chain(
              table === "creator_threads"
                ? { data: threads, error: null }
                : messageReads++ === 1
                  ? { data: null, error: { message: "boom" } }
                  : { data: [], error: null },
            ),
        }) as never,
    );
    vi.mocked(globalClient).mockImplementation(() => chain({ data: [], error: null }) as never);
    await expect(listBusinessCreatorThreads("tenant-1")).rejects.toThrow(/creator_thread_messages read failed/);
  });
});

describe("buildCreatorCard images (photo + illustration, 2026-09-28)", () => {
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const base = async () => (await deps().loadMember(MEMBER))!;
  const signMedia = vi.fn(async (path: string) => `https://signed.test/${encodeURIComponent(path)}?token=t`);

  it("returns a signed photo_url when a photo exists, and no illustration_url", async () => {
    signMedia.mockClear();
    const card = await buildCreatorCard(
      MEMBER,
      deps({
        signMedia,
        loadMember: async () => ({
          ...(await base()),
          photo_path: `${OWNER}/p.jpg`,
          illustration_path: `${OWNER}/i.png`,
        }),
      }),
    );
    expect(card?.photo_url).toMatch(/^https:\/\/signed\.test\//);
    expect(card?.illustration_url).toBeNull();
    expect(signMedia).toHaveBeenCalledTimes(1);
  });

  it("returns a signed illustration_url when there is no photo", async () => {
    const card = await buildCreatorCard(
      MEMBER,
      deps({ signMedia, loadMember: async () => ({ ...(await base()), photo_path: null, illustration_path: `${OWNER}/i.png` }) }),
    );
    expect(card?.photo_url).toBeNull();
    expect(card?.illustration_url).toMatch(/^https:\/\/signed\.test\//);
  });

  it("never returns a storage path anywhere on the card", async () => {
    const card = await buildCreatorCard(
      MEMBER,
      deps({
        signMedia: async () => "https://signed.test/x?token=t",
        loadMember: async () => ({
          ...(await base()),
          intro_video_path: `${OWNER}/v.mp4`,
          photo_path: `${OWNER}/p.jpg`,
          illustration_path: `${OWNER}/i.png`,
        }),
      }),
    );
    const json = JSON.stringify(card);
    expect(json).not.toContain(OWNER);
    expect(json).not.toMatch(/photo_path|illustration_path|intro_video_path/);
  });

  it("a signing failure leaves the card with no image, not a 500", async () => {
    const card = await buildCreatorCard(
      MEMBER,
      deps({
        signMedia: async () => {
          throw new Error("storage down");
        },
        loadMember: async () => ({ ...(await base()), photo_path: `${OWNER}/p.jpg` }),
      }),
    );
    expect(card?.photo_url).toBeNull();
  });

  it("no images: both null", async () => {
    const card = await buildCreatorCard(MEMBER, deps({ signMedia }));
    expect(card?.photo_url).toBeNull();
    expect(card?.illustration_url).toBeNull();
  });
});

describe("buildCreatorCard never exposes the creator's auth user id (F1)", () => {
  it("signs with the member's own auth id but never puts it on the card", async () => {
    const AUTH = "99999999-0000-4000-8000-000000000099";
    const signMedia = vi.fn(async () => "https://signed.test/media/abc.jpg?token=t");
    const card = await buildCreatorCard(
      MEMBER,
      deps({
        signMedia,
        loadMember: async () => ({
          ...(await deps().loadMember(MEMBER))!,
          auth_user_id: AUTH,
          photo_path: "media/0b8f5c1e-1111-4111-8111-111111111111.jpg",
        }),
      }),
    );
    expect(signMedia).toHaveBeenCalledWith("media/0b8f5c1e-1111-4111-8111-111111111111.jpg", AUTH);
    expect(JSON.stringify(card)).not.toContain(AUTH);
  });
});
