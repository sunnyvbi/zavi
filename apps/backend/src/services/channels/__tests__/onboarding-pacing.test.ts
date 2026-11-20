
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { paceSignupCards, planPacing, releasePacedChannels, signupRunIds, type PacingCard } from "../onboarding-pacing";

const T = "11111111-1111-4111-8111-111111111111";
let n = 0;
const card = (channel_slug: string, over: Partial<PacingCard> = {}): PacingCard => ({
  id: `c${++n}`,
  channel_slug,
  status: "pending",
  held_reason: null,
  touched: false,
  ...over,
});
const ids = (cs: PacingCard[]) => cs.map((c) => c.id);

describe("planPacing", () => {
  it("keeps the highest channel in the order visible and holds every other pending card", () => {
    const li = [card("linkedin_organic"), card("linkedin_organic")];
    const rest = [card("seo"), card("reddit_organic"), card("instagram_organic")];
    const p = planPacing([...rest, ...li]);
    expect(p.focus).toBe("linkedin_organic");
    expect(p.hold.sort()).toEqual(ids(rest).sort());
    expect(p.release).toEqual([]);
  });

  const focusOf = (...slugs: string[]) => planPacing(slugs.map((s) => card(s))).focus;

  it("leads with the channels founders act on most and leaves X, then Instagram, for last", () => {
    expect(focusOf("instagram_organic", "x_organic", "seo", "geo", "reddit_organic", "linkedin_organic")).toBe("linkedin_organic");
    expect(focusOf("instagram_organic", "x_organic", "seo", "geo", "reddit_organic")).toBe("reddit_organic");
    expect(focusOf("instagram_organic", "x_organic", "seo", "geo")).toBe("geo");
    expect(focusOf("instagram_organic", "x_organic", "seo")).toBe("seo");
    expect(focusOf("instagram_organic", "x_organic")).toBe("x_organic");
    expect(focusOf("instagram_organic")).toBe("instagram_organic");
  });

  it("puts a channel outside the order after the counted ones but ahead of X and Instagram, by name", () => {
    expect(focusOf("ugc", "seo")).toBe("seo");
    expect(focusOf("ugc", "x_organic", "instagram_organic")).toBe("ugc");
    expect(focusOf("ugc", "blog", "x_organic")).toBe("blog");
  });

  it("re-evaluates: a higher channel that finishes later takes the focus, the old focus is held", () => {
    const x = [card("x_organic"), card("x_organic")];
    const seo = [card("seo")];
    const p = planPacing([...x, ...seo]);
    expect(p.focus).toBe("seo");
    expect(p.hold.sort()).toEqual(ids(x).sort());
  });

  it("lets the focus channel's held cards out when the focus falls back to it", () => {
    const heldGeo = [card("geo", { status: "snoozed", held_reason: "pacing" })];
    const p = planPacing([...heldGeo, card("seo", { status: "snoozed", held_reason: "pacing" })]);
    expect(p.focus).toBe("geo");
    expect(p.release).toEqual(ids(heldGeo));
    expect(p.hold).toEqual([]);
  });

  it("never holds again a card already released, nor one that is not pending", () => {
    const released = card("seo", { held_reason: "released" });
    const acted = card("seo", { status: "acted" });
    const founderSnooze = card("reddit_organic", { status: "snoozed", held_reason: null });
    const p = planPacing([card("linkedin_organic"), released, acted, founderSnooze]);
    expect(p.hold).toEqual([]);
  });

  it("freezes once the founder touched any card: no holds, no releases", () => {
    const touched = planPacing([card("linkedin_organic"), card("seo", { touched: true })]);
    expect(touched.hold).toEqual([]);
    expect(touched.release).toEqual([]);
    const elsewhere = planPacing([card("linkedin_organic"), card("seo")], undefined, { frozen: true });
    expect(elsewhere.hold).toEqual([]);
  });
});

describe("signupRunIds", () => {
  const run = (id: string, key: string, slug: string, over: Record<string, unknown> = {}) => ({
    id,
    agent_slug: slug,
    trigger: "channel_recipe",
    enqueued_by: null,
    cron_dedupe_key: key,
    ...over,
  });

  it("counts the signup preview runs and the first run, not the post-upgrade re-run", () => {
    const got = signupRunIds(T, [
      run("p-seo", `first-run-preview:${T}:seo`, "seo"),
      run("first", `first-run:${T}`, "geo"),
      run("dry-x", `first-run-preview-done:${T}:x_organic`, "x_organic"),
      run("rerun-x", `first-run-preview:${T}:x_organic`, "x_organic"),
    ]);
    expect([...got].sort()).toEqual(["dry-x", "first", "p-seo"]);
  });

  it("ignores a run a person enqueued, another tenant's key, or another trigger", () => {
    const got = signupRunIds(T, [
      run("user", `first-run-preview:${T}:seo`, "seo", { enqueued_by: "u1" }),
      run("other", "first-run-preview:22222222-2222-4222-8222-222222222222:seo", "seo"),
      run("chat", `first-run:${T}`, "seo", { trigger: "chat" }),
    ]);
    expect(got.size).toBe(0);
  });
});

function fakeDb(tables: Record<string, unknown>) {
  const reads: string[] = [];
  const client = {
    from: (table: string) => {
      reads.push(table);
      let single = false;
      let touched = false;
      const p: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "like", "limit"]) p[m] = () => p;
      p.not = () => ((touched = true), p);
      p.maybeSingle = () => ((single = true), p);
      p.then = (res: (v: unknown) => unknown) => {
        const data = single ? (tables[`${table}:single`] ?? null) : touched ? (tables[`${table}:touched`] ?? []) : (tables[table] ?? []);
        return Promise.resolve({ data, error: null }).then(res);
      };
      return p;
    },
  };
  return { reads, db: () => client as never };
}

describe("paceSignupCards", () => {
  const NOW = Date.parse("2026-10-30T10:00:00Z");
  const CREATED = "2026-10-30T09:40:00.000Z";

  it("does nothing past one read for a run that is not a signup run", async () => {
    const f = fakeDb({ "agent_runs:single": { cron_dedupe_key: `channel:${T}:seo:2026-10-30` } });
    const rpc = vi.fn();
    expect(await paceSignupCards(T, "r1", { db: f.db, rpc: rpc as never, nowMs: NOW })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(f.reads).toEqual(["agent_runs"]);
  });

  it("holds the other channels until signup + 10 days, through the tenant-scoped RPC", async () => {
    const f = fakeDb({
      "agent_runs:single": { cron_dedupe_key: `first-run-preview:${T}:seo` },
      agent_runs: [
        { id: "r-seo", agent_slug: "seo", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: `first-run-preview:${T}:seo` },
        { id: "r-li", agent_slug: "linkedin_organic", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: `first-run-preview:${T}:linkedin_organic` },
      ],
      channel_actions: [
        { id: "s1", channel_slug: "seo", status: "pending", held_reason: null, founder_touched_at: null },
        { id: "l1", channel_slug: "linkedin_organic", status: "pending", held_reason: null, founder_touched_at: null },
      ],
      channel_action_events: [],
      "tenants:single": { created_at: CREATED },
    });
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const plan = await paceSignupCards(T, "r-seo", { db: f.db, rpc: rpc as never, nowMs: NOW });
    expect(plan?.focus).toBe("linkedin_organic");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(T, "hold_paced_channel_actions", {
      p_ids: ["s1"],
      p_until: "2026-11-09T09:40:00.000Z",
    });
  });

  it("holds nothing once a founder answered any card", async () => {
    const f = fakeDb({
      "agent_runs:single": { cron_dedupe_key: `first-run-preview:${T}:seo` },
      agent_runs: [{ id: "r-seo", agent_slug: "seo", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: `first-run-preview:${T}:seo` }],
      channel_actions: [
        { id: "s1", channel_slug: "seo", status: "pending", held_reason: null, founder_touched_at: null },
        { id: "g1", channel_slug: "geo", status: "pending", held_reason: null, founder_touched_at: null },
      ],
      channel_action_events: [{ action_id: "some-other-card" }],
      "tenants:single": { created_at: CREATED },
    });
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    await paceSignupCards(T, "r-seo", { db: f.db, rpc: rpc as never, nowMs: NOW });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never throws: a failed write leaves the cards as they are and reports null", async () => {
    const f = fakeDb({
      "agent_runs:single": { cron_dedupe_key: `first-run-preview:${T}:seo` },
      agent_runs: [{ id: "r-seo", agent_slug: "seo", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: `first-run-preview:${T}:seo` }],
      channel_actions: [
        { id: "s1", channel_slug: "seo", status: "pending", held_reason: null, founder_touched_at: null },
        { id: "g1", channel_slug: "geo", status: "pending", held_reason: null, founder_touched_at: null },
      ],
      "tenants:single": { created_at: CREATED },
    });
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(paceSignupCards(T, "r-seo", { db: f.db, rpc: rpc as never, nowMs: NOW })).resolves.toBeNull();
  });
});

describe("releasePacedChannels", () => {
  it("releases the named channels for the given tenant only", async () => {
    const rpc = vi.fn(async () => ({ data: 4, error: null }));
    expect(await releasePacedChannels(T, ["reddit_organic"], { rpc: rpc as never })).toBe(4);
    expect(rpc).toHaveBeenCalledWith(T, "release_paced_channel_actions", { p_channels: ["reddit_organic"], p_ids: null });
  });
});
