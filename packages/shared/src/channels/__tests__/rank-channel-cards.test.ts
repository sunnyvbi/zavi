import { describe, expect, it } from "vitest";
import { DEFAULT_TOP_N, rankChannelCards, type RankableAction } from "../rank-actions";

const card = (over: Partial<RankableAction> & { id: string }): RankableAction => ({
  action_type: "check",
  blocking: false,
  position: 2,
  score: 40,
  proposed_at: "2026-09-21T03:33:00Z",
  status: "pending",
  snoozed_until: null,
  ...over,
});

const draft = (id: string, at: string) =>
  card({ id, action_type: "text_post", score: 0, proposed_at: at });

const isDraft = (ids: string[]) => (c: RankableAction) => ids.includes(c.id);

describe("rankChannelCards", () => {
  it("puts the newest staged draft above every scored chore", () => {
    const pool = [
      card({ id: "chore-45", score: 45 }),
      card({ id: "chore-43", score: 43 }),
      draft("draft-old", "2026-09-21T03:28:00Z"),
      draft("draft-new", "2026-09-22T11:03:00Z"),
    ];
    const out = rankChannelCards(pool, isDraft(["draft-old", "draft-new"]));
    expect(out.map((c) => c.id)).toEqual(["draft-new", "draft-old", "chore-45", "chore-43"]);
  });

  it("a blocking card still beats the newest draft", () => {
    const pool = [draft("draft-new", "2026-09-22T11:03:00Z"), card({ id: "blocker", blocking: true, score: 10 })];
    expect(rankChannelCards(pool, isDraft(["draft-new"])).map((c) => c.id)).toEqual(["blocker", "draft-new"]);
  });

  it("a check with no score ranks last, not level with a zero-scored chore", () => {
    const pool = [
      card({ id: "check:pinned", action_type: "fix", score: 0, proposed_at: "" }),
      card({ id: "chore", score: 30 }),
      draft("draft", "2026-09-22T11:03:00Z"),
    ];
    expect(rankChannelCards(pool, isDraft(["draft"])).map((c) => c.id)).toEqual(["draft", "chore", "check:pinned"]);
  });

  it("the prod shape lands five on screen and thirteen behind the button", () => {
    const drafts = Array.from({ length: 12 }, (_, i) =>
      draft(`d${i}`, new Date(Date.parse("2026-09-21T03:28:00Z") + i * 3_600_000).toISOString()),
    );
    const pool = rankChannelCards(
      [...drafts, ...Array.from({ length: 5 }, (_, i) => card({ id: `a${i}`, score: 45 - i })), card({ id: "check:pinned", action_type: "fix", score: 0, proposed_at: "" })],
      isDraft(drafts.map((d) => d.id)),
    );
    expect(pool).toHaveLength(18);
    expect(pool.slice(0, DEFAULT_TOP_N).map((c) => c.id)).toEqual(["d11", "d10", "d9", "d8", "d7"]);
    expect(pool.length - DEFAULT_TOP_N).toBe(13);
    expect(pool[pool.length - 1].id).toBe("check:pinned");
  });

  it("with no drafts it is compareActions and nothing else", () => {
    const pool = [card({ id: "b", score: 30 }), card({ id: "a", score: 45 }), card({ id: "c", blocking: true, score: 1 })];
    expect(rankChannelCards(pool, () => false).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });
});
