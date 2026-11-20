import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const hireRead = vi.hoisted(() => ({
  result: { data: [] as Array<{ id: string }>, error: null as { message: string } | null },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "in"]) {
      b[m] = (...args: unknown[]) => {
        hireRead.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(hireRead.result).then(ok, bad);
    return b;
  };
  return { ...real, tenantClient: vi.fn(() => builder()) };
});

import { displaceOverCap } from "../channel-actions";
import { asTenantId } from "@/services/tenant-client";

const TID = asTenantId("t-1");

const ranked = (...ids: string[]) =>
  vi.fn(async () => ({ actions: ids.map((id) => ({ id })), more: 0, store: "channel_actions" })) as never;

const rankedTyped = (...rows: Array<[string, string]>) =>
  vi.fn(async () => ({
    actions: rows.map(([id, action_type]) => ({ id, action_type })),
    more: 0,
    store: "channel_actions",
  })) as never;

type RpcCall = [unknown, string, Record<string, unknown>];

const okRpc = (displaced: number, skipped = 0) =>
  vi.fn(async (..._args: RpcCall) => ({ data: { ok: true, displaced, skipped }, error: null }));

describe("displaceOverCap", () => {
  it("does not let legacy recommendations or operator notes retire a managed customer action", async () => {
    const rpc = okRpc(1);
    const actions = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `legacy-${i}`, body: { step: {} } })),
      { id: "operator", body: { step: { responsibility: "zavi" } } },
      { id: "new-customer", body: { step: { responsibility: "client" } } },
    ];
    expect(await displaceOverCap(TID, "chatgpt_ads", "run-current", null, {
      rpc: rpc as never,
      listOpen: vi.fn(async () => ({ actions, more: 0, store: "channel_actions" })) as never,
    })).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("retains managed customer actions beyond five for the collapsed overflow", async () => {
    const rpc = okRpc(1);
    const actions = [
      { id: "operator", body: { step: { responsibility: "zavi" } } },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `client-${i}`, body: { step: { responsibility: "client" } } })),
    ];
    await displaceOverCap(TID, "chatgpt_ads", "run-current", null, {
      rpc: rpc as never,
      listOpen: vi.fn(async () => ({ actions, more: 0, store: "channel_actions" })) as never,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps the top five and displaces the rest, in the panel's own order", async () => {
    const rpc = okRpc(2);
    const n = await displaceOverCap(TID, "x_organic", "run-1", "New blocker", {
      rpc: rpc as never,
      listOpen: ranked("a", "b", "c", "d", "e", "f", "g"),
    });

    expect(n).toBe(2);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [tid, name, args] = rpc.mock.calls[0];
    expect(tid).toBe(TID);
    expect(name).toBe("displace_channel_actions");
    expect(args.p_loser_ids).toEqual(["f", "g"]);
    expect(args.p_channel_slug).toBe("x_organic");
    expect(args.p_winner_title).toBe("New blocker");
    expect(args).not.toHaveProperty("p_tenant_id");
  });

  it("does nothing at all when the channel is at or under the cap", async () => {
    const rpc = okRpc(0);
    for (const ids of [[], ["a"], ["a", "b", "c", "d", "e"]]) {
      expect(await displaceOverCap(TID, "seo", "run-2", null, {
        rpc: rpc as never,
        listOpen: ranked(...ids),
      })).toBe(0);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never decides by age: the survivors are whatever the ranker returned", async () => {
    const rpc = okRpc(1);
    await displaceOverCap(TID, "google_ads", "run-3", "fresh weak card", {
      rpc: rpc as never,
      listOpen: ranked("old-blocker", "b", "c", "d", "e", "fresh-weak"),
    });
    const args = rpc.mock.calls[0][2];
    expect(args.p_loser_ids).toEqual(["fresh-weak"]);
    expect(args.p_loser_ids).not.toContain("old-blocker");
  });

  it("an RPC error costs the run nothing: the insert already succeeded", async () => {
    const rpc = vi.fn(async (..._args: RpcCall) => ({ data: null, error: { message: "boom" } }));
    expect(await displaceOverCap(TID, "seo", "run-4", null, {
      rpc: rpc as never,
      listOpen: ranked("a", "b", "c", "d", "e", "f"),
    })).toBe(0);
  });

  it("a thrown read costs the run nothing either", async () => {
    const rpc = okRpc(1);
    const boom = vi.fn(async () => {
      throw new Error("no supabase");
    }) as never;
    expect(await displaceOverCap(TID, "seo", "run-5", null, { rpc: rpc as never, listOpen: boom })).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never retires a post because a chore outranks it", async () => {
    const rpc = okRpc(0);
    expect(
      await displaceOverCap(TID, "x_organic", "run-6", "Clear your approval cards", {
        rpc: rpc as never,
        listOpen: rankedTyped(
          ["c1", "check"], ["c2", "setup"], ["c3", "check"], ["c4", "fix"], ["c5", "check"],
          ["p1", "text_post"], ["p2", "text_post"], ["p3", "image_post"],
        ),
      }),
    ).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still caps each side: the sixth chore and the sixth post both go", async () => {
    const rpc = okRpc(2);
    await displaceOverCap(TID, "x_organic", "run-7", null, {
      rpc: rpc as never,
      listOpen: rankedTyped(
        ["c1", "check"], ["c2", "check"], ["c3", "check"], ["c4", "check"], ["c5", "check"], ["c6", "check"],
        ["p1", "text_post"], ["p2", "text_post"], ["p3", "text_post"], ["p4", "video_post"],
        ["p5", "text_post"], ["p6", "text_post"],
      ),
    });
    expect(rpc.mock.calls[0][2].p_loser_ids).toEqual(["c6", "p6"]);
  });

  describe("generated_video approval cards", () => {
    const card = (id: string, run_id: string, exec_status: string | null, blocking = false) =>
      ({ id, run_id, action_type: "video_post", executable: true, exec_status, blocking });
    const fresh = ["n1", "n2", "n3", "n4", "n5"].map((id) => card(id, "run-new", null));
    const run = async (slug: string, actions: unknown[]) => {
      const rpc = okRpc(5);
      await displaceOverCap(TID, slug, "run-new", null, {
        rpc: rpc as never,
        listOpen: vi.fn(async () => ({ actions, more: 0, store: "channel_actions" })) as never,
      });
      return rpc.mock.calls[0]?.[2].p_loser_ids;
    };

    it("keeps the cards this run just wrote and retires older made videos instead", async () => {
      const old = ["o1", "o2", "o3", "o4", "o5"].map((id) => card(id, "run-old", "executed"));
      expect(await run("generated_video", [...old, ...fresh])).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    });

    it("a video still rendering holds no slot, so no new card is retired for it", async () => {
      const old = [card("o1", "run-old", "dispatching"), ...["o2", "o3", "o4", "o5"].map((id) => card(id, "run-old", "executed"))];
      expect(await run("generated_video", [...old, ...fresh])).toEqual(["o2", "o3", "o4", "o5"]);
    });

    it("a blocker still outranks the new cards", async () => {
      const blocker = card("b1", "run-old", null, true);
      const old = ["o1", "o2", "o3", "o4"].map((id) => card(id, "run-old", "executed"));
      expect(await run("generated_video", [blocker, ...old, ...fresh])).toEqual(["n5", "o1", "o2", "o3", "o4"]);
    });

    it("on YouTube, the video cards a run handed off for YouTube wrote are kept too", async () => {
      const old = ["o1", "o2", "o3", "o4", "o5"].map((id) => ({ ...card(id, "run-old", null), action_type: "text_post", executable: false }));
      expect(await run("youtube_organic", [...old, ...fresh])).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    });

    it("on YouTube, cards that are not this run's videos keep the ranker's order", async () => {
      const old = ["o1", "o2", "o3", "o4", "o5"].map((id) => ({ ...card(id, "run-old", null), action_type: "text_post", executable: false }));
      const mine = ["n1", "n2", "n3", "n4", "n5"].map((id) => ({ ...card(id, "run-new", null), action_type: "text_post", executable: false }));
      expect(await run("youtube_organic", [...old, ...mine])).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    });

    it("other channels keep the ranker's order", async () => {
      const old = ["o1", "o2", "o3", "o4", "o5"].map((id) => card(id, "run-old", null));
      expect(await run("google_ads", [...old, ...fresh])).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    });
  });

  it("never displaces an approved card waiting on a founder fix when a run files six new cards", async () => {
    const rpc = okRpc(1);
    const fresh = Array.from({ length: 6 }, (_, i) => ({ id: `new-${i}`, run_id: "run-2" }));
    const waiting = { id: "approved-waiting", run_id: "run-1", exec_status: "failed", exec_bucket: "needs_founder" };
    await displaceOverCap(TID, "meta_ads", "run-2", "New card", {
      rpc: rpc as never,
      listOpen: vi.fn(async () => ({ actions: [...fresh, waiting], more: 0, store: "channel_actions" })) as never,
    });
    const losers = rpc.mock.calls[0][2].p_loser_ids as string[];
    expect(losers).not.toContain("approved-waiting");
    expect(losers).toEqual(["new-4", "new-5"]);
  });

  it("a card that failed for any other reason still ranks where the ranker put it", async () => {
    const rpc = okRpc(1);
    const fresh = Array.from({ length: 5 }, (_, i) => ({ id: `new-${i}` }));
    const blocked = { id: "refused", exec_status: "failed", exec_bucket: "blocked_on_us" };
    await displaceOverCap(TID, "meta_ads", "run-2", null, {
      rpc: rpc as never,
      listOpen: vi.fn(async () => ({ actions: [...fresh, blocked], more: 0, store: "channel_actions" })) as never,
    });
    expect(rpc.mock.calls[0][2].p_loser_ids).toEqual(["refused"]);
  });

  describe("a LinkedIn campaign draft the founder started", () => {
    const draftBody = { step: { responsibility: "client", deliverable: { presentation: { type: "campaign_draft", channel: "linkedin_ads" } } } };
    const fresh = () => Array.from({ length: 5 }, (_, i) => ({ id: `new-${i}`, run_id: "run-new", body: { step: { responsibility: "client" } } }));
    const open = (...rows: unknown[]) => vi.fn(async () => ({ actions: rows, more: 0, store: "channel_actions" })) as never;
    const noHires = vi.fn(async () => new Set<string>());

    it("keeps a draft the founder filled and prepared on the review sheet, and retires the next card instead", async () => {
      const rpc = okRpc(1);
      const prepared = { id: "prepared", run_id: "run-old", executable: true, exec_status: null, body: draftBody };
      const other = { id: "old-idea", run_id: "run-old", body: { step: { responsibility: "client" } } };
      await displaceOverCap(TID, "linkedin_ads", "run-new", "New idea", {
        rpc: rpc as never,
        listOpen: open(...fresh(), prepared, other),
        creatorHireIds: noHires,
      });
      const losers = rpc.mock.calls[0][2].p_loser_ids as string[];
      expect(losers).not.toContain("prepared");
      expect(losers).toEqual(["old-idea"]);
    });

    it("keeps a draft the founder started from the LinkedIn Ads page, read by its founder run", async () => {
      hireRead.calls.length = 0;
      hireRead.result = { data: [{ id: "run-founder" }], error: null };
      const rpc = okRpc(1);
      const started = { id: "started", run_id: "run-founder", executable: false, body: draftBody };
      const zaviDraft = { id: "zavi-draft", run_id: "run-old", executable: false, body: draftBody };
      await displaceOverCap(TID, "linkedin_ads", "run-new", null, {
        rpc: rpc as never,
        listOpen: open(...fresh(), started, zaviDraft),
        creatorHireIds: noHires,
      });
      expect(hireRead.calls).toEqual([
        ["from", "agent_runs"],
        ["select", "id"],
        ["in", "id", ["run-founder", "run-old"]],
        ["eq", "agent_definition_hash", "linkedin_ads_founder_campaign_draft"],
      ]);
      expect(rpc.mock.calls[0][2].p_loser_ids).toEqual(["zavi-draft"]);
      hireRead.result = { data: [], error: null };
    });

    it("fails closed: when the founder-run read errors, nothing is displaced", async () => {
      hireRead.result = { data: [], error: { message: "boom" } };
      const rpc = okRpc(1);
      expect(await displaceOverCap(TID, "linkedin_ads", "run-new", null, {
        rpc: rpc as never,
        listOpen: open(...fresh(), { id: "d", run_id: "run-old", executable: false, body: draftBody }),
        creatorHireIds: noHires,
      })).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
      hireRead.result = { data: [], error: null };
    });

    it("another channel's executable card is not protected by this rule", async () => {
      const rpc = okRpc(1);
      const founderDraftIds = vi.fn(async () => new Set(["x"]));
      await displaceOverCap(TID, "google_ads", "run-new", null, {
        rpc: rpc as never,
        listOpen: open(...fresh(), { id: "x", run_id: "run-old", executable: true, body: draftBody }),
        founderDraftIds,
      });
      expect(founderDraftIds).not.toHaveBeenCalled();
      expect(rpc.mock.calls[0][2].p_loser_ids).toEqual(["x"]);
    });
  });

  describe("a pending creator hire", () => {
    const ugcCards = () => [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `idea-${i}`, run_id: "run-9" })),
      { id: "hire", run_id: "run-1", executable: true, exec_status: null },
      { id: "old-1", run_id: "run-1" },
      { id: "old-2", run_id: "run-1" },
    ];

    it("is never displaced on ugc, and the other over-cap cards still go", async () => {
      const rpc = okRpc(2);
      const creatorHireIds = vi.fn(async () => new Set(["hire"]));
      const n = await displaceOverCap(TID, "ugc", "run-9", "New idea", {
        rpc: rpc as never,
        listOpen: vi.fn(async () => ({ actions: ugcCards(), more: 0, store: "channel_actions" })) as never,
        creatorHireIds,
      });
      expect(n).toBe(2);
      expect(creatorHireIds).toHaveBeenCalledWith(TID, "ugc");
      expect(rpc).toHaveBeenCalledTimes(1);
      const losers = rpc.mock.calls[0][2].p_loser_ids as string[];
      expect(losers).not.toContain("hire");
      expect(losers).toEqual(["old-1", "old-2"]);
    });

    it("on ugc, a hire that alone is over the cap retires nothing", async () => {
      const rpc = okRpc(0);
      const cards = [...Array.from({ length: 5 }, (_, i) => ({ id: `idea-${i}` })), { id: "hire" }];
      expect(await displaceOverCap(TID, "ugc", "run-9", null, {
        rpc: rpc as never,
        listOpen: vi.fn(async () => ({ actions: cards, more: 0, store: "channel_actions" })) as never,
        creatorHireIds: vi.fn(async () => new Set(["hire"])),
      })).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it("reads open creator.hire rows of this channel only, through the tenant client", async () => {
      hireRead.calls.length = 0;
      hireRead.result = { data: [{ id: "hire" }], error: null };
      const rpc = okRpc(2);
      await displaceOverCap(TID, "ugc", "run-9", null, {
        rpc: rpc as never,
        listOpen: vi.fn(async () => ({ actions: ugcCards(), more: 0, store: "channel_actions" })) as never,
      });
      expect(hireRead.calls).toEqual([
        ["from", "channel_actions"],
        ["select", "id"],
        ["eq", "channel_slug", "ugc"],
        ["eq", "exec_class", "creator.hire"],
        ["in", "status", ["pending", "snoozed"]],
      ]);
      expect(rpc.mock.calls[0][2].p_loser_ids).toEqual(["old-1", "old-2"]);
    });

    it("fails closed: when the hire read errors, nothing is displaced", async () => {
      hireRead.result = { data: [], error: { message: "boom" } };
      const rpc = okRpc(3);
      expect(await displaceOverCap(TID, "ugc", "run-9", null, {
        rpc: rpc as never,
        listOpen: vi.fn(async () => ({ actions: ugcCards(), more: 0, store: "channel_actions" })) as never,
      })).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
      hireRead.result = { data: [], error: null };
    });

    it("does not read hires when the channel is under the cap", async () => {
      const creatorHireIds = vi.fn(async () => new Set(["hire"]));
      const rpc = okRpc(0);
      await displaceOverCap(TID, "ugc", "run-9", null, {
        rpc: rpc as never,
        listOpen: ranked("a", "hire"),
        creatorHireIds,
      });
      expect(creatorHireIds).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
