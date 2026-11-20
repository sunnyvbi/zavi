import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => {
    throw new Error("tests inject sb");
  },
  asTenantId: (t: string) => t,
}));

import {
  isPlainBuildYes,
  startConfirmedHeavyBuild,
  maybeHandleBuildConfirmReply,
  readBuildConfirmCardForRun,
  startBuildNote,
  BUILD_CONFIRM_RETRY,
} from "../heavy-build-confirm";
import { armHeavyDispatchPending, readHeavyDispatchPending } from "../heavy-dispatch-pending";
import { fakeSb, type FakeSbOpts } from "./fake-sb";

const T = "t1";
const TH = "th1";
const U = "u1";

async function world(
  opts: {
    cardOnLastReply?: boolean;
    failUpdate?: FakeSbOpts["failUpdate"];
    failSelect?: FakeSbOpts["failSelect"];
  } = {},
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_threads: [{ id: TH, tenant_id: T, user_id: U, agent_slug: "operator", heavy_confirm_pending: null }],
    agent_thread_messages: [
      { id: "m-spec", tenant_id: T, thread_id: TH, sender_role: "user", body: "Build LifeLink ...", created_at: "2026-09-27T04:56:01Z" },
    ],
    agent_runs: [{ id: "run-1", tenant_id: T, payload: { thread_id: TH, user_message_id: "m-spec" } }],
  };
  const sb = fakeSb(tables, {
    failUpdate: (t, p) => opts.failUpdate?.(t, p) ?? false,
    failSelect: (t) => opts.failSelect?.(t) ?? false,
  });
  const pending = (await armHeavyDispatchPending(
    {
      tenant_id: T,
      thread_id: TH,
      armed_run_id: "run-1",
      user_id: U,
      target: "engineer",
      intent: "Build a complete production-ready Blood Donation Platform",
      context: { full_build: true },
      est_credits: 2000,
    },
    sb,
  ))!;
  if (opts.cardOnLastReply !== false) {
    const card = await readBuildConfirmCardForRun({ tenant_id: T, thread_id: TH, run_id: "run-1" }, sb);
    tables.agent_thread_messages.push({
      id: "m-card",
      tenant_id: T,
      thread_id: TH,
      sender_role: "assistant",
      body: "This is a large build, ~2,000 credits. Click Start.",
      meta: { build_confirm: card },
      created_at: "2026-09-27T04:56:33Z",
    });
  }
  const callHandoff = vi.fn(async (_ctx: unknown, _tool: string, _args: unknown) => ({
    ok: true,
    is_error: false,
    content: JSON.stringify({ ok: true, run_id: "child-1", target: "engineer" }),
  }));
  return { tables, sb, pending, callHandoff };
}

describe("isPlainBuildYes", () => {
  it("accepts every reply from the 2026-09-27 incident", () => {
    for (const m of ["Ok proceed", "Yes", "yes, start the build", "Yes!"]) {
      expect(isPlainBuildYes(m)).toBe(true);
    }
  });
  it("rejects a yes with a scope change or a question", () => {
    for (const m of [
      "yes but only the landing page",
      "yes, smaller",
      "yes, but use Postgres instead",
      "how much will it cost?",
      "no",
      "",
    ]) {
      expect(isPlainBuildYes(m)).toBe(false);
    }
  });
});

describe("startConfirmedHeavyBuild", () => {
  it("dispatches the STORED handoff as the operator's run, gate pre-claimed, reading the spec turn", async () => {
    const w = await world();
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(r).toEqual({ status: "started", run_id: "child-1", est_credits: 2000 });
    const [ctx, tool, args] = w.callHandoff.mock.calls[0];
    expect(tool).toBe("handoff");
    expect(args).toEqual({
      target_agent_slug: "engineer",
      intent: "Build a complete production-ready Blood Donation Platform",
      context: { full_build: true },
    });
    expect(ctx).toMatchObject({
      tenant_id: T,
      run_id: "run-1",
      agent_slug: "operator",
      trigger: "chat",
      chat_thread_id: TH,
      user_id: U,
      heavy_confirm_preclaimed: true,
      user_turn_message_id: "m-spec",
    });
    const card = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status: string; run_id: string };
    };
    expect(card.build_confirm).toMatchObject({ status: "started", run_id: "child-1" });
  });

  it("a second start (double click) never dispatches twice", async () => {
    const w = await world();
    const args = { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce };
    const [a, b] = await Promise.all([
      startConfirmedHeavyBuild(args, { sb: w.sb, callHandoff: w.callHandoff }),
      startConfirmedHeavyBuild(args, { sb: w.sb, callHandoff: w.callHandoff }),
    ]);
    expect(w.callHandoff).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].sort()).toEqual(["expired", "started"]);
    const again = await startConfirmedHeavyBuild(args, { sb: w.sb, callHandoff: w.callHandoff });
    expect(again).toEqual({ status: "already_started", run_id: "child-1" });
  });

  it("insufficient credits: no build, token restored so Start works after a top-up", async () => {
    const w = await world();
    const err = Object.assign(new Error("no credits"), { name: "InsufficientCreditsError" });
    const callHandoff = vi.fn(async () => {
      throw err;
    });
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff },
    );
    expect(r).toEqual({ status: "insufficient_credits", est_credits: 2000 });
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb))?.nonce).toBe(w.pending.nonce);
  });

  it("insufficient credits but the restore FAILS: no 402 promise, the founder is told to ask again", async () => {
    let failRestore = false;
    const w = await world({
      failUpdate: (t, p) => failRestore && t === "agent_threads" && p.heavy_confirm_pending != null,
    });
    failRestore = true;
    const callHandoff = vi.fn(async () => {
      throw Object.assign(new Error("no credits"), { name: "InsufficientCreditsError" });
    });
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff },
    );
    expect(r.status).toBe("failed");
    expect(startBuildNote(r)).toMatch(/Ask me again/);
    expect(startBuildNote(r)).not.toMatch(/click Start/i);
  });

  it("when the held build cannot be put back, its card loses Start", async () => {
    let failRestore = false;
    const w = await world({
      failUpdate: (t, p) => failRestore && t === "agent_threads" && p.heavy_confirm_pending != null,
    });
    failRestore = true;
    const callHandoff = vi.fn(async () => {
      throw Object.assign(new Error("no credits"), { name: "InsufficientCreditsError" });
    });
    await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff },
    );
    const meta = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status?: string };
    };
    expect(meta.build_confirm.status).toBe("replaced");
  });

  it("a refused handoff whose restore FAILS does not say try Start again", async () => {
    let failRestore = false;
    const w = await world({
      failUpdate: (t, p) => failRestore && t === "agent_threads" && p.heavy_confirm_pending != null,
    });
    failRestore = true;
    const callHandoff = vi.fn(async () => ({
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "plan_upgrade_required", message: "Needs Pro." }),
    }));
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff },
    );
    expect(r).toEqual({ status: "failed", message: "The build did not start. Ask me again and I'll set it up.", retryable: false });
  });

  it("a refused handoff (plan wall etc.) reports its message and restores the token", async () => {
    const w = await world();
    const callHandoff = vi.fn(async () => ({
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "plan_upgrade_required", message: "Needs Pro." }),
    }));
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff },
    );
    expect(r).toEqual({ status: "failed", message: "Needs Pro.", retryable: true });
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).not.toBeNull();
  });
});

describe("startConfirmedHeavyBuild: result shapes (codex review)", () => {
  const start = (w: Awaited<ReturnType<typeof world>>, content: unknown, ok = true, is_error = false) =>
    startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff: vi.fn(async () => ({ ok, is_error, content: JSON.stringify(content) })) },
    );

  it("an ok:true refusal with no run id is NOT started (umbrella: build already in progress)", async () => {
    const w = await world();
    const r = await start(w, { ok: true, routed_to: "refine_product", message: "A change to your app is already in progress." });
    expect(r).toEqual({ status: "failed", message: "A change to your app is already in progress.", retryable: true });
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).not.toBeNull();
  });

  it("an umbrella refine that started carries its own message", async () => {
    const w = await world();
    const r = await start(w, { ok: true, routed_to: "refine_product", conductor_run_id: "cr-1", message: "I've started that change." });
    expect(r).toMatchObject({ status: "started", run_id: "cr-1", note: "I've started that change." });
  });

  it("a fan-out bookkeeping error after enqueue counts as started and never reopens the card", async () => {
    const w = await world();
    const r = await start(w, { error: "handoff_batch_persist_failed", message: "Enqueued 2 runs but..." }, false, true);
    expect(r.status).toBe("started");
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).toBeNull();
  });

  it("a partial fan-out names the parts that did not start", async () => {
    const w = await world();
    const r = await start(w, { ok: true, batch_id: "b-1", run_ids: ["c1"], failed_targets: ["ios-repo"] });
    expect(r.status).toBe("started");
    expect(startBuildNote(r)).toContain("ios-repo");
  });
});

describe("maybeHandleBuildConfirmReply (typed yes)", () => {
  it("incident replay: 'Ok proceed' starts the build with no operator turn", async () => {
    const w = await world();
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "Ok proceed" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBe("build_started");
    expect(w.callHandoff).toHaveBeenCalledTimes(1);
    const bodies = w.tables.agent_thread_messages.map((m) => `${m.sender_role}:${m.body}`);
    expect(bodies).toContain("user:Ok proceed");
    expect(bodies.some((b) => b.startsWith("assistant:Started your build"))).toBe(true);
  });

  it("a scope change drops the pending build and falls through to the operator", async () => {
    const w = await world();
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "yes but only the landing page" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBeNull();
    expect(w.callHandoff).not.toHaveBeenCalled();
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).toBeNull();
  });

  it("a scope change marks the old card replaced, so it no longer offers Start", async () => {
    const w = await world();
    await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "only the landing page please" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    const meta = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status?: string; nonce: string };
    };
    expect(meta.build_confirm).toMatchObject({ status: "replaced", nonce: w.pending.nonce });
  });

  it("a scope change whose drop FAILS does not reach the operator and leaves no card marked replaced", async () => {
    let failClear = false;
    const w = await world({
      failUpdate: (t, p) => failClear && t === "agent_threads" && p.heavy_confirm_pending === null,
    });
    failClear = true;
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "yes but only the landing page" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBe(BUILD_CONFIRM_RETRY);
    expect(w.callHandoff).not.toHaveBeenCalled();
    const meta = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status?: string };
    };
    expect(meta.build_confirm.status).toBeUndefined();
    failClear = false;
    const again = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "yes but only the landing page" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(again).toBeNull();
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).toBeNull();
  });

  it("a failed read of the thread is a retry, never a pass to the operator", async () => {
    let failRead = false;
    const w = await world({ failSelect: (t) => failRead && t === "agent_threads" });
    failRead = true;
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "make it smaller" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBe(BUILD_CONFIRM_RETRY);
    expect(w.callHandoff).not.toHaveBeenCalled();
  });

  it("a scope change racing a Start in another tab: zero rows cleared is a retry, and the card is not marked replaced", async () => {
    let raced = false;
    const w = await world({
      failUpdate: (t, p) => {
        if (!raced && t === "agent_threads" && p.heavy_confirm_pending === null) {
          raced = true;
          w.tables.agent_threads[0].heavy_confirm_pending = null;
          const card = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!;
          card.meta = { build_confirm: { ...(card.meta as { build_confirm: object }).build_confirm, status: "started" } };
        }
        return false;
      },
    });
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "only the landing page" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBe(BUILD_CONFIRM_RETRY);
    const meta = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status?: string };
    };
    expect(meta.build_confirm.status).toBe("started");
  });

  it("a NEW Start card armed on the same thread marks the previous card replaced", async () => {
    const w = await world();
    const next = (await armHeavyDispatchPending(
      {
        tenant_id: T,
        thread_id: TH,
        armed_run_id: "run-2",
        user_id: U,
        target: "engineer",
        intent: "Build only the landing page",
        context: { full_build: true },
        est_credits: 2000,
      },
      w.sb,
    ))!;
    expect(next.nonce).not.toBe(w.pending.nonce);
    const meta = w.tables.agent_thread_messages.find((m) => m.id === "m-card")!.meta as {
      build_confirm: { status?: string; nonce: string };
    };
    expect(meta.build_confirm).toMatchObject({ status: "replaced", nonce: w.pending.nonce });
    const r = await startConfirmedHeavyBuild(
      { tenant_id: T, thread_id: TH, user_id: U, nonce: w.pending.nonce },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(r).toEqual({ status: "expired" });
    expect(startBuildNote(r)).toBe("This build request was replaced or expired. Ask me again to start it.");
    expect(w.callHandoff).not.toHaveBeenCalled();
  });

  it("a yes to a DIFFERENT reply (no card on the last message) is not a build confirm", async () => {
    const w = await world({ cardOnLastReply: false });
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: U, thread_id: TH, message: "yes" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBeNull();
    expect(w.callHandoff).not.toHaveBeenCalled();
  });

  it("another user's thread is never touched", async () => {
    const w = await world();
    const action = await maybeHandleBuildConfirmReply(
      { tenant_id: T, user_id: "someone-else", thread_id: TH, message: "yes" },
      { sb: w.sb, callHandoff: w.callHandoff },
    );
    expect(action).toBeNull();
    expect(w.callHandoff).not.toHaveBeenCalled();
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, w.sb)).not.toBeNull();
  });
});
