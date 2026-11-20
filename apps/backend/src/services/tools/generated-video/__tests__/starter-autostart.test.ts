import { describe, it, expect, vi } from "vitest";
import { autostartStarterVideo, autostartChatVideo, starterOf, STARTER_MAX_RENDERS } from "../starter-autostart";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const FOUNDER = "33333333-3333-3333-3333-333333333333";
const ACTION = "44444444-4444-4444-4444-444444444444";

const NEW_CARD = { actionId: ACTION, kept: false };
const starterRun = { trigger: "channel_recipe", payload: { starter_by: FOUNDER, starter_request: "ai-ugc-starters-1" } };

function deps(over: Record<string, unknown> = {}) {
  return {
    readRun: vi.fn(async () => starterRun),
    readRunCards: vi.fn(async () => [{ id: ACTION, position: 900 }]),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    readCard: vi.fn(async () => ({ status: "rejected", exec_status: null })),
    approve: vi.fn(async () => ({ ok: true as const, attempt: 1, alreadyQueued: false, stillQueued: false, replayed: false })),
    send: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
    ...over,
  };
}

describe("a Start the AI run starts each video itself", () => {
  it("approves as the founder who pressed Start the AI, never as staff or cgo, and queues exactly one render", async () => {
    const d = deps();
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("started");
    expect(d.approve).toHaveBeenCalledTimes(1);
    expect(d.approve).toHaveBeenCalledWith(TENANT, { actionId: ACTION, eventKey: `starter-${ACTION}`, actorUserId: FOUNDER, source: null });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith({ id: `approve:${ACTION}:1`, name: "channel-action.approved", data: { action_id: ACTION } });
  });

  it("does not send a second render when another approve already queued and dispatched it", async () => {
    const d = deps({ approve: vi.fn(async () => ({ ok: true, attempt: 1, alreadyQueued: true, stillQueued: false, replayed: true })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("started");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("re-sends the same event id when the first send was lost and the card is still queued", async () => {
    const d = deps({ approve: vi.fn(async () => ({ ok: true, attempt: 2, alreadyQueued: true, stillQueued: true, replayed: true })) });
    await autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never);
    expect(d.send).toHaveBeenCalledWith({ id: `approve:${ACTION}:2`, name: "channel-action.approved", data: { action_id: ACTION } });
  });

  it("a refused approve starts nothing and says so in the log", async () => {
    const d = deps({ approve: vi.fn(async () => ({ ok: false, code: "exec_blocked_no_retry" })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "starter.approve_refused" }));
  });

  it("an unreadable run approves nothing", async () => {
    const d = deps({ readRun: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe("only a real Start the AI run counts as one", () => {
  it.each([
    ["an ordinary channel run", { trigger: "channel_recipe", payload: {} }],
    ["a run with starter_by but no starter request", { trigger: "channel_recipe", payload: { starter_by: FOUNDER } }],
    ["a starter request id that is not ours", { trigger: "channel_recipe", payload: { starter_by: FOUNDER, starter_request: "something-else" } }],
    ["a chat turn", { trigger: "manual", payload: { starter_by: FOUNDER, starter_request: "ai-ugc-starters-1" } }],
    ["a starter_by that is not a user id", { trigger: "channel_recipe", payload: { starter_by: "everyone", starter_request: "ai-ugc-starters-1" } }],
    ["no run at all", null],
  ])("%s approves nothing", async (_label, run) => {
    const d = deps({ readRun: vi.fn(async () => run) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("not_starter");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("starterOf reads the founder from a genuine starter run", () => {
    expect(starterOf(starterRun)).toBe(FOUNDER);
  });
});

describe("a starter run auto-starts ONE render, the first card it wrote, and only cards it wrote", () => {
  it("seven proposals racing in one run approve exactly the first card written", async () => {
    const cards: Array<{ id: string; position: number }> = [];
    const approved: string[] = [];
    let next = 900;
    const d = deps({
      readRunCards: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 0));
        return cards.map((c) => ({ ...c }));
      }),
      approve: vi.fn(async (_t: string, a: { actionId: string }) => {
        approved.push(a.actionId);
        return { ok: true as const, attempt: 1, alreadyQueued: false, stillQueued: false, replayed: false };
      }),
    });
    const ids = Array.from({ length: 7 }, (_, i) => `card-${i}`);
    const outcomes = await Promise.all(
      ids.map(async (id) => {
        await new Promise((r) => setTimeout(r, 0));
        cards.push({ id, position: next++ });
        return autostartStarterVideo(TENANT, RUN, { actionId: id, kept: false }, d as never);
      }),
    );
    expect(STARTER_MAX_RENDERS).toBe(1);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "capped")).toHaveLength(6);
    expect(approved).toEqual([ids[0]]);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("the second card is left for the founder: no approve, no render", async () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({ id: `card-${i}`, position: 900 + i }));
    const d = deps({ readRunCards: vi.fn(async () => cards) });
    await expect(autostartStarterVideo(TENANT, RUN, { actionId: "card-1", kept: false }, d as never)).resolves.toBe("capped");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("an existing card the dedupe kept is never approved for the founder", async () => {
    const d = deps();
    await expect(autostartStarterVideo(TENANT, RUN, { actionId: ACTION, kept: true }, d as never)).resolves.toBe("not_new");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a card id that is not one of this run's cards is never approved", async () => {
    const d = deps({ readRunCards: vi.fn(async () => [{ id: "someone-elses-card", position: 900 }]) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("not_new");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a new starter run after a failed one makes no second video on its own", async () => {
    const d = deps({ claim: vi.fn(async () => false) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("capped");
    expect(d.claim).toHaveBeenCalledWith(TENANT, ACTION, RUN);
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("an unreadable claim approves nothing", async () => {
    const d = deps({ claim: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a stalled starter run and its retry resuming together pay for ONE video: the claim, not a history read, decides", async () => {
    const owner = new Map<string, string>();
    const claim = vi.fn(async (tenant: string, action: string) => {
      await new Promise((r) => setTimeout(r, 0));
      if (!owner.has(tenant)) owner.set(tenant, action);
      return owner.get(tenant) === action;
    });
    const approved: string[] = [];
    const runs = { "run-stalled": "card-stalled", "run-retry": "card-retry" } as Record<string, string>;
    const d = deps({
      claim,
      readRunCards: vi.fn(async (_t: string, run: string) => [{ id: runs[run], position: 900 }]),
      approve: vi.fn(async (_t: string, a: { actionId: string }) => {
        approved.push(a.actionId);
        return { ok: true as const, attempt: 1, alreadyQueued: false, stillQueued: false, replayed: false };
      }),
    });
    const out = await Promise.all(
      Object.entries(runs).map(([run, card]) => autostartStarterVideo(TENANT, run, { actionId: card, kept: false }, d as never)),
    );
    expect(out.filter((o) => o === "started")).toHaveLength(1);
    expect(out.filter((o) => o === "capped")).toHaveLength(1);
    expect(approved).toHaveLength(1);
    expect(d.send).toHaveBeenCalledTimes(1);
    const winner = approved[0];
    const loser = Object.values(runs).find((c) => c !== winner)!;
    expect(await claim(TENANT, winner)).toBe(true);
    expect(await claim(TENANT, loser)).toBe(false);
  });

  it("unreadable run cards approve nothing", async () => {
    const d = deps({ readRunCards: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(d.approve).not.toHaveBeenCalled();
  });
});

describe("a refused auto-approve does not use up the workspace's one starter video", () => {
  function claimTable() {
    const owner = new Map<string, string>();
    return {
      owner,
      claim: vi.fn(async (tenant: string, action: string) => {
        if (!owner.has(tenant)) owner.set(tenant, action);
        return owner.get(tenant) === action;
      }),
      release: vi.fn(async (tenant: string, action: string) => {
        if (owner.get(tenant) === action) owner.delete(tenant);
      }),
    };
  }

  it.each(["illegal_transition", "not_executable", "paired_move_unreadable", "not_found"])(
    "a %s refusal hands the claim back, so the next Start the AI run still makes its first video on its own",
    async (code) => {
      const t = claimTable();
      const first = deps({ ...t, approve: vi.fn(async () => ({ ok: false, code })) });
      await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, first as never)).resolves.toBe("failed");
      expect(t.release).toHaveBeenCalledWith(TENANT, ACTION);
      expect(t.owner.has(TENANT)).toBe(false);

      const NEXT = "55555555-5555-5555-5555-555555555555";
      const next = deps({ ...t, readRunCards: vi.fn(async () => [{ id: NEXT, position: 900 }]) });
      await expect(autostartStarterVideo(TENANT, "run-2", { actionId: NEXT, kept: false }, next as never)).resolves.toBe("started");
      expect(next.approve).toHaveBeenCalledTimes(1);
      expect(next.send).toHaveBeenCalledTimes(1);
      expect(t.owner.get(TENANT)).toBe(NEXT);
    },
  );

  it.each(["already_executed", "exec_partial_no_retry", "exec_blocked_no_retry"])(
    "a %s refusal keeps the claim: a render already ran for this card, so no second free one",
    async (code) => {
      const t = claimTable();
      const d = deps({ ...t, approve: vi.fn(async () => ({ ok: false, code })) });
      await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
      expect(t.release).not.toHaveBeenCalled();
      expect(t.owner.get(TENANT)).toBe(ACTION);
    },
  );

  it.each([
    ["acted", null],
    ["acted", "queued"],
    ["pending", "dispatching"],
    ["acted", "executed"],
    ["rejected", "queued"],
  ])("an illegal_transition on a card the founder already approved (%s, %s) keeps the claim", async (status, exec_status) => {
    const t = claimTable();
    const readCard = vi.fn(async () => ({ status, exec_status }));
    const d = deps({ ...t, readCard, approve: vi.fn(async () => ({ ok: false, code: "illegal_transition" })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(readCard).toHaveBeenCalledWith(TENANT, ACTION);
    expect(t.release).not.toHaveBeenCalled();
    expect(t.owner.get(TENANT)).toBe(ACTION);

    const NEXT = "55555555-5555-5555-5555-555555555555";
    const next = deps({ ...t, readRunCards: vi.fn(async () => [{ id: NEXT, position: 900 }]) });
    await expect(autostartStarterVideo(TENANT, "run-2", { actionId: NEXT, kept: false }, next as never)).resolves.toBe("capped");
    expect(next.approve).not.toHaveBeenCalled();
  });

  it.each(["rejected", "stale", "redone"])("an illegal_transition on a %s card releases the claim", async (status) => {
    const t = claimTable();
    const d = deps({ ...t, readCard: vi.fn(async () => ({ status, exec_status: null })), approve: vi.fn(async () => ({ ok: false, code: "illegal_transition" })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(t.release).toHaveBeenCalledWith(TENANT, ACTION);
    expect(t.owner.has(TENANT)).toBe(false);
  });

  it.each([
    ["a read error", vi.fn(async () => { throw new Error("db down"); })],
    ["a missing card", vi.fn(async () => null)],
  ])("an illegal_transition with %s keeps the claim", async (_label, readCard) => {
    const t = claimTable();
    const d = deps({ ...t, readCard, approve: vi.fn(async () => ({ ok: false, code: "illegal_transition" })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(t.release).not.toHaveBeenCalled();
    expect(t.owner.get(TENANT)).toBe(ACTION);
  });

  it("a card that lost the claim never releases the winner's", async () => {
    const t = claimTable();
    t.owner.set(TENANT, "winner-card");
    const d = deps({ ...t, approve: vi.fn(async () => ({ ok: false, code: "illegal_transition" })) });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("capped");
    expect(t.release).not.toHaveBeenCalled();
    expect(t.owner.get(TENANT)).toBe("winner-card");
  });

  it("a release that fails is logged and still reports the start as failed", async () => {
    const d = deps({
      approve: vi.fn(async () => ({ ok: false, code: "illegal_transition" })),
      release: vi.fn(async () => { throw new Error("db down"); }),
    });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("failed");
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "starter.release_failed" }));
  });

  it("a successful start keeps the claim", async () => {
    const t = claimTable();
    const d = deps({ ...t });
    await expect(autostartStarterVideo(TENANT, RUN, NEW_CARD, d as never)).resolves.toBe("started");
    expect(t.release).not.toHaveBeenCalled();
    expect(t.owner.get(TENANT)).toBe(ACTION);
  });
});

describe("a video the founder asks for in chat starts without Make video", () => {
  const ORDER = { founder: true, unverified: false, userId: FOUNDER };

  it("approves the first card as the founder who asked and queues exactly one render", async () => {
    const d = deps();
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("started");
    expect(d.approve).toHaveBeenCalledTimes(1);
    expect(d.approve).toHaveBeenCalledWith(TENANT, { actionId: ACTION, eventKey: `chat-${ACTION}`, actorUserId: FOUNDER, source: null });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith({ id: `approve:${ACTION}:1`, name: "channel-action.approved", data: { action_id: ACTION } });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.readRun).not.toHaveBeenCalled();
  });

  it.each([
    ["no order at all", undefined],
    ["a run that is not a founder order", { founder: false, unverified: false, userId: FOUNDER }],
    ["an unverified founder order", { founder: true, unverified: true, userId: FOUNDER }],
    ["a founder order with no user", { founder: true, unverified: false, userId: null }],
    ["a founder order whose user is not a user id", { founder: true, unverified: false, userId: "slack:U123" }],
  ])("%s spends nothing", async (_label, order) => {
    const d = deps();
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, order as never, d as never)).resolves.toBe("not_chat");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("only the first card of the run starts; a second card in the same turn waits for Make video", async () => {
    const d = deps({ readRunCards: vi.fn(async () => [{ id: "00000000-0000-0000-0000-000000000001", position: 100 }, { id: ACTION, position: 900 }]) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("not_first");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a card the run kept from before is not started again", async () => {
    const d = deps();
    await expect(autostartChatVideo(TENANT, RUN, { actionId: ACTION, kept: true }, ORDER, d as never)).resolves.toBe("not_first");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a card missing from the run's cards is not started", async () => {
    const d = deps({ readRunCards: vi.fn(async () => []) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("not_first");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("unreadable cards start nothing", async () => {
    const d = deps({ readRunCards: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("failed");
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "chat_video.cards_unreadable" }));
  });

  it("a refused approve (plan, channel or wallet) sends no render", async () => {
    const d = deps({ approve: vi.fn(async () => ({ ok: false, code: "insufficient_credits" })) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("failed");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "chat_video.approve_refused" }));
  });

  it("a replayed tool call does not send a second render", async () => {
    const d = deps({ approve: vi.fn(async () => ({ ok: true, attempt: 1, alreadyQueued: true, stillQueued: false, replayed: true })) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("started");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a send that throws reports failed instead of claiming the video is coming", async () => {
    const d = deps({ send: vi.fn(async () => { throw new Error("inngest down"); }) });
    await expect(autostartChatVideo(TENANT, RUN, NEW_CARD, ORDER, d as never)).resolves.toBe("failed");
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "chat_video.autostart_failed" }));
  });
});
