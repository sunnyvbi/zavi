
import { describe, it, expect, vi } from "vitest";

vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: vi.fn(),
  startCardRpc: vi.fn(),
  tenantClient: vi.fn(),
  tenantRpc: vi.fn(),
  asTenantId: (s: string) => s,
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => true), getNumberSetting: vi.fn(async () => 0) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/media-router/charge", () => ({ checkAffordMedia: vi.fn() }));

import { globalClient } from "@/services/tenant-client";
import {
  defaultTenantCardGateDeps,
  deliveryTargetFor,
  isSiteCheckToolEnabled,
  runSiteCheck,
  tenantCardStartBlock,
} from "../site-check-tool";
import { SITE_CHECK_RESERVE_USD, SITE_CHECK_RUN_CAP, siteCheckCostKey } from "../site-check-funding";
import type { StartCardRow } from "../store";

const CTX = { tenant_id: "t1", run_id: "run-1", tool_use_id: "tu-1", trigger: "chat", chat_thread_id: "th-1" };
const SCORE = {
  total: 70,
  out_of: 100,
  by_check: { google: 16, ai: 12, seo: 18, design: 14, compare: 10 },
};

function card(over: Partial<StartCardRow> = {}): StartCardRow {
  return {
    id: "card-1",
    public_id: "PUBLICID00000001",
    domain: "vercel.com",
    locale: "US",
    search_term: "deploy platform",
    status: "running",
    parts: {},
    score: null,
    scorer_version: "1",
    evidence: {},
    ip_hash: null,
    referrer_card_id: null,
    budget_day: null,
    reserved_usd: SITE_CHECK_RESERVE_USD,
    spent_usd: 0,
    revoked_at: null,
    error: null,
    created_at: "2026-10-06T00:00:00Z",
    updated_at: "2026-10-06T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    funding_kind: "tenant_credits",
    funding_tenant_id: "t1",
    requested_by_run_id: "run-1",
    tool_call_id: "tu-1",
    delivery_state: "waiting",
    delivery_target: { kind: "chat", thread_id: "th-1" },
    ...over,
  };
}

const DONE = card({ status: "done", score: SCORE, spent_usd: 0.3 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Deps = any;

function mkDeps(over: Record<string, unknown> = {}): Deps {
  let t = 1_000_000;
  let state: StartCardRow = card();
  const deps = {
    toolEnabled: vi.fn(async () => true),
    cardsEnabled: vi.fn(async () => true),
    admit: vi.fn(async () => ({ ok: true, site: { url: "https://vercel.com/", domain: "vercel.com" } })),
    findRecent: vi.fn(async () => null),
    afford: vi.fn(async () => "ok"),
    claim: vi.fn(async () => ({ outcome: "created", id: "card-1", public_id: "PUBLICID00000001", status: "running" })),
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    getCard: vi.fn(async () => state),
    transition: vi.fn(async (_id: string, from: string, to: string) => {
      if (state.delivery_state !== from) return false;
      state = { ...state, delivery_state: to as StartCardRow["delivery_state"] };
      return true;
    }),
    addSideCost: vi.fn(async () => "added"),
    recordLate: vi.fn(async () => "recorded"),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    now: vi.fn(() => t),
    ...over,
  };
  (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard = (r) => {
    state = r;
  };
  return deps;
}

describe("refusals before any card or charge", () => {
  const noSpend = (deps: Deps) => {
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.addSideCost).not.toHaveBeenCalled();
    expect(deps.recordLate).not.toHaveBeenCalled();
  };

  it("invalid URL", async () => {
    const deps = mkDeps({ admit: vi.fn(async () => ({ ok: false, code: "invalid_url" })) as never });
    const r = await runSiteCheck(CTX, { url: "not a site" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "invalid_url" });
    noSpend(deps);
  });

  it("SSRF / private address", async () => {
    const deps = mkDeps({ admit: vi.fn(async () => ({ ok: false, code: "unsafe_url" })) as never });
    expect(await runSiteCheck(CTX, { url: "internal.corp" }, deps)).toMatchObject({ status: "refused", reason: "unsafe_url" });
    noSpend(deps);
  });

  it("unreachable site", async () => {
    const deps = mkDeps({ admit: vi.fn(async () => ({ ok: false, code: "unreachable" })) as never });
    expect(await runSiteCheck(CTX, { url: "nope-nope.example" }, deps)).toMatchObject({ reason: "unreachable" });
    noSpend(deps);
  });

  it("missing url argument", async () => {
    const deps = mkDeps();
    expect(await runSiteCheck(CTX, {}, deps)).toMatchObject({ status: "refused", reason: "invalid_url" });
    noSpend(deps);
  });

  it("kill switch off (site_check_tool_enabled=false) → not available", async () => {
    const deps = mkDeps({ toolEnabled: vi.fn(async () => false) });
    expect(await runSiteCheck(CTX, { url: "vercel.com" }, deps)).toMatchObject({ status: "refused", reason: "not_available" });
    expect(deps.admit).not.toHaveBeenCalled();
    noSpend(deps);
  });

  it("public cards switched off → not available (the worker would cancel it)", async () => {
    const deps = mkDeps({ cardsEnabled: vi.fn(async () => false) });
    expect(await runSiteCheck(CTX, { url: "vercel.com" }, deps)).toMatchObject({ reason: "not_available" });
    noSpend(deps);
  });

  it("a shadow / draft run never spends; no tool call id cannot bill idempotently", async () => {
    const a = mkDeps();
    expect(await runSiteCheck({ ...CTX, writes_suppressed: true }, { url: "vercel.com" }, a)).toMatchObject({ reason: "not_available" });
    noSpend(a);
    const b = mkDeps();
    expect(await runSiteCheck({ ...CTX, tool_use_id: undefined }, { url: "vercel.com" }, b)).toMatchObject({ reason: "not_available" });
    noSpend(b);
  });

  it("insufficient credits → typed refusal, no card", async () => {
    const deps = mkDeps({ afford: vi.fn(async () => "short") as never });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "insufficient_credits" });
    expect(deps.afford).toHaveBeenCalledWith("t1", SITE_CHECK_RESERVE_USD);
    noSpend(deps);
  });

  it("an unreadable wallet refuses too (fail closed), and never claims the founder is short", async () => {
    const deps = mkDeps({ afford: vi.fn(async () => "unknown") as never });
    expect(await runSiteCheck(CTX, { url: "vercel.com" }, deps)).toMatchObject({ reason: "credits_unavailable" });
    noSpend(deps);
  });

  it("per-run cap: the claim refuses a second card (cap 1 until an atomic hold exists)", async () => {
    const deps = mkDeps({ claim: vi.fn(async () => ({ outcome: "run_cap" })) as never });
    expect(await runSiteCheck(CTX, { url: "vercel.com" }, deps)).toMatchObject({ status: "refused", reason: "run_cap" });
    expect(deps.claim.mock.calls[0][0].funding.run_cap).toBe(SITE_CHECK_RUN_CAP);
    expect(SITE_CHECK_RUN_CAP).toBe(1);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.addSideCost).not.toHaveBeenCalled();
  });
});

describe("dedupe", () => {
  it("a card for this domain from the last 24h is reused and charges nothing (no wallet check either)", async () => {
    const other = card({ id: "old", status: "done", score: SCORE, requested_by_run_id: null, tool_call_id: null, funding_kind: "public_budget", delivery_state: null });
    const deps = mkDeps({ findRecent: vi.fn(async () => other) as never, afford: vi.fn(async () => "short") as never });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "deduped", credits_charged: 0, total: 70, card_url: expect.stringContaining("/r/PUBLICID00000001") });
    expect(deps.afford).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.addSideCost).not.toHaveBeenCalled();
    expect(deps.recordLate).not.toHaveBeenCalled();
  });

  it("a claim that loses the domain race returns the winner's card at $0", async () => {
    const deps = mkDeps({ claim: vi.fn(async () => ({ outcome: "reused", id: "card-1", public_id: "PUBLICID00000001", status: "done" })) as never });
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard(DONE);
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "deduped", credits_charged: 0 });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.addSideCost).not.toHaveBeenCalled();
  });

  it("concurrent calls for one domain: one card, one charge (claim modelled on start_card_claim's lock)", async () => {
    let made: string | null = null;
    let row: StartCardRow = card();
    const shared = {
      claim: vi.fn(async (input: { funding: { tool_call_id?: string } }) => {
        if (made) return { outcome: "reused", id: "card-1", public_id: "PUBLICID00000001", status: row.status };
        made = input.funding.tool_call_id ?? "x";
        row = { ...DONE, tool_call_id: made };
        return { outcome: "created", id: "card-1", public_id: "PUBLICID00000001", status: "running" };
      }),
      getCard: vi.fn(async () => row),
      transition: vi.fn(async (_id: string, from: string, to: string) => {
        if (row.delivery_state !== from) return false;
        row = { ...row, delivery_state: to as StartCardRow["delivery_state"] };
        return true;
      }),
      addSideCost: vi.fn(async () => "added"),
    };
    const a = mkDeps(shared as never);
    const b = mkDeps(shared as never);
    const [ra, rb] = await Promise.all([
      runSiteCheck({ ...CTX, tool_use_id: "tu-a" }, { url: "vercel.com" }, a),
      runSiteCheck({ ...CTX, run_id: "run-2", tool_use_id: "tu-b" }, { url: "https://www.vercel.com" }, b),
    ]);
    expect([ra.status, rb.status].sort()).toEqual(["deduped", "done"]);
    expect(shared.addSideCost).toHaveBeenCalledTimes(1);
  });
});

describe("done inside the 90s wait", () => {
  it("bills the real cost once, as a run side cost keyed on the tool call", async () => {
    const deps = mkDeps();
    let polls = 0;
    deps.getCard.mockImplementation(async () => (++polls >= 3 ? { ...DONE, delivery_state: polls > 3 ? "returned" : "waiting" } : card()));
    deps.transition.mockImplementation(async () => true);
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "done", total: 70, out_of: 100, search_term: "deploy platform", credits_charged: 120 });
    expect(r.status === "done" && r.scores.map((x) => x.points)).toEqual([16, 12, 18, 14, 10]);
    expect(deps.addSideCost).toHaveBeenCalledTimes(1);
    expect(deps.addSideCost).toHaveBeenCalledWith({ tenantId: "t1", runId: "run-1", usd: 0.3, source: "site_check", key: siteCheckCostKey("tu-1") });
    expect(deps.recordLate).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledWith("card-1");
  });

  it("never bills more than the reserve", async () => {
    const deps = mkDeps();
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard({ ...DONE, spent_usd: 0.9 });
    await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(deps.addSideCost.mock.calls[0][0].usd).toBe(SITE_CHECK_RESERVE_USD);
  });

  it("a card that failed charges nothing", async () => {
    const deps = mkDeps();
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard(card({ status: "failed", spent_usd: SITE_CHECK_RESERVE_USD }));
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "check_failed" });
    const usd = deps.addSideCost.mock.calls[0]?.[0]?.usd ?? 0;
    expect(usd).toBe(0);
  });

  it("a replay of the same tool call re-records under the same key (no second charge) and makes no new card", async () => {
    const deps = mkDeps({ claim: vi.fn(async () => ({ outcome: "same_call", id: "card-1", public_id: "PUBLICID00000001", status: "done" })) as never });
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard({ ...DONE, delivery_state: "returned" });
    deps.addSideCost.mockImplementation(async () => "already");
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "done" });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.addSideCost.mock.calls[0][0].key).toBe(siteCheckCostKey("tu-1"));
  });

  it("a failed enqueue cancels the card and refuses; nothing billed", async () => {
    const deps = mkDeps({ enqueue: vi.fn(async () => { throw new Error("inngest down"); }) });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "check_failed" });
    expect(deps.cancel).toHaveBeenCalledWith("card-1", "enqueue_failed");
    expect(deps.addSideCost).not.toHaveBeenCalled();
    expect(deps.recordLate).not.toHaveBeenCalled();
  });
});

describe("still running at 90s → pending", () => {
  it("records the late charge at the reserve BEFORE moving to pending, and returns the link", async () => {
    const deps = mkDeps();
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "pending", card_url: expect.stringContaining("/r/PUBLICID00000001"), credits_reserved: 195 });
    expect(deps.recordLate).toHaveBeenCalledWith({ tenantId: "t1", runId: "run-1", toolCallId: "tu-1", cardId: "card-1", reservedUsd: SITE_CHECK_RESERVE_USD });
    const lateAt = deps.recordLate.mock.invocationCallOrder[0];
    const pendAt = deps.transition.mock.calls.findIndex((c: unknown[]) => c[1] === "waiting" && c[2] === "pending");
    expect(lateAt).toBeLessThan(deps.transition.mock.invocationCallOrder[pendAt]);
    expect(deps.addSideCost).not.toHaveBeenCalled();
    expect(deps.sleep.mock.calls.reduce((a: number, c: unknown[]) => a + (c[0] as number), 0)).toBe(90_000);
  });

  it("a card that finishes right as the tool gives up is returned now (the late charge's refund still settles it)", async () => {
    const deps = mkDeps();
    let n = 0;
    deps.getCard.mockImplementation(async () => {
      n++;
      const pendingNow = deps.transition.mock.calls.some((c: unknown[]) => c[2] === "pending");
      return pendingNow ? { ...DONE, delivery_state: "pending" } : card();
    });
    deps.transition.mockImplementation(async () => true);
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(n).toBeGreaterThan(1);
    expect(r).toMatchObject({ status: "done" });
    expect(deps.recordLate).toHaveBeenCalledTimes(1);
    expect(deps.addSideCost).not.toHaveBeenCalled();
    expect(deps.transition).toHaveBeenCalledWith("card-1", "pending", "delivered");
    expect(deps.transition).not.toHaveBeenCalledWith("card-1", "pending", "returned");
  });

  it("F1+F7: a replay after that late finish bills nothing more and reports the actual cost", async () => {
    const deps = mkDeps();
    deps.getCard.mockImplementation(async () => (deps.transition.mock.calls.some((c: unknown[]) => c[2] === "pending") ? { ...DONE, delivery_state: "pending" } : card()));
    await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    const moved = deps.transition.mock.calls.find((c: unknown[]) => c[1] === "pending");
    expect(moved?.[2]).toBe("delivered");
    const replay = mkDeps({ claim: vi.fn(async () => ({ outcome: "same_call", id: "card-1", public_id: "PUBLICID00000001", status: "done" })) as never });
    (replay as unknown as { setCard: (r: StartCardRow) => void }).setCard({ ...DONE, delivery_state: "delivered" });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, replay);
    expect(r).toMatchObject({ status: "done", credits_charged: 120 });
    expect(replay.addSideCost).not.toHaveBeenCalled();
    expect(replay.recordLate).not.toHaveBeenCalled();
  });

  it("F7: a replay of a settled late check that failed says so and reports nothing charged", async () => {
    const replay = mkDeps({ claim: vi.fn(async () => ({ outcome: "same_call", id: "card-1", public_id: "PUBLICID00000001", status: "failed" })) as never });
    (replay as unknown as { setCard: (r: StartCardRow) => void }).setCard(card({ status: "failed", delivery_state: "delivered" }));
    expect(await runSiteCheck(CTX, { url: "vercel.com" }, replay)).toMatchObject({ status: "refused", reason: "check_failed" });
    expect(replay.addSideCost).not.toHaveBeenCalled();
  });
});

describe("billing failures and replays", () => {
  it("F2: a side-cost write that throws hands the card back to `waiting` so the settle worker bills it", async () => {
    const deps = mkDeps({ addSideCost: vi.fn(async () => { throw new Error("db down"); }) });
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard(DONE);
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "billing_uncertain" });
    expect((r as { message: string }).message).toBe("The check ran; the charge is being confirmed and will show in Usage shortly.");
    expect((r as { message: string }).message).not.toMatch(/nothing was charged/i);
    expect(deps.transition).toHaveBeenCalledWith("card-1", "waiting", "returned");
    expect(deps.transition).toHaveBeenCalledWith("card-1", "returned", "waiting");
    expect((await deps.getCard("card-1")).delivery_state).toBe("waiting");
  });

  it("re-review F1: a late charge that throws is billing-uncertain too (the settle worker may still bill it)", async () => {
    const deps = mkDeps({ recordLate: vi.fn(async () => { throw new Error("lost reply"); }) });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "billing_uncertain" });
  });

  it("re-review F1: a failure before any card exists still says nothing was charged", async () => {
    const deps = mkDeps({ claim: vi.fn(async () => { throw new Error("db down"); }) });
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(r).toMatchObject({ status: "refused", reason: "server_error" });
    expect((r as { message: string }).message).toMatch(/Nothing was charged/);
    expect(deps.addSideCost).not.toHaveBeenCalled();
  });

  it("F6: this call's own card skips the wallet check (a short wallet cannot refuse a paid-for replay)", async () => {
    const own = { ...DONE, delivery_state: "waiting" as const };
    const deps = mkDeps({
      findRecent: vi.fn(async () => own) as never,
      afford: vi.fn(async () => "short") as never,
      claim: vi.fn(async () => ({ outcome: "same_call", id: "card-1", public_id: "PUBLICID00000001", status: "done" })) as never,
    });
    (deps as unknown as { setCard: (r: StartCardRow) => void }).setCard(own);
    const r = await runSiteCheck(CTX, { url: "vercel.com" }, deps);
    expect(deps.afford).not.toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "done", credits_charged: 120 });
    expect(deps.addSideCost).toHaveBeenCalledTimes(1);
  });
});

describe("tenantCardStartBlock (card worker gate, F3 + F5)", () => {
  const row = { funding_kind: "tenant_credits" as const, funding_tenant_id: "t1", requested_by_run_id: "run-1" };
  const gate = (enabled: boolean, run: { status: string; stop_requested: boolean } | null) => ({
    toolEnabled: vi.fn(async () => enabled),
    readRun: vi.fn(async () => run),
  });

  it("a public card is never blocked", async () => {
    const d = gate(false, null);
    expect(await tenantCardStartBlock({ funding_kind: "public_budget", funding_tenant_id: null, requested_by_run_id: null }, d)).toBeNull();
    expect(d.readRun).not.toHaveBeenCalled();
  });

  it("the tool kill switch blocks a queued tenant card", async () => {
    expect(await tenantCardStartBlock(row, gate(false, { status: "running", stop_requested: false }))).toBe("tool_disabled");
  });

  it("a stopped, cancelled or missing run blocks it; a live run does not", async () => {
    expect(await tenantCardStartBlock(row, gate(true, { status: "running", stop_requested: true }))).toBe("run_stopped");
    expect(await tenantCardStartBlock(row, gate(true, { status: "cancelled", stop_requested: false }))).toBe("run_stopped");
    expect(await tenantCardStartBlock(row, gate(true, null))).toBe("run_stopped");
    const live = gate(true, { status: "running", stop_requested: false });
    expect(await tenantCardStartBlock(row, live)).toBeNull();
    expect(live.readRun).toHaveBeenCalledWith("t1", "run-1");
  });
});

describe("isSiteCheckToolEnabled (re-review F4)", () => {
  const read = (impl: () => unknown) =>
    vi.mocked(globalClient).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: impl }) }) }),
    } as never);

  it("a read error keeps the tool's own admission open but blocks the strict (worker) gate", async () => {
    read(async () => ({ data: null, error: { message: "down" } }));
    expect(await isSiteCheckToolEnabled()).toBe(true);
    expect(await isSiteCheckToolEnabled({ strict: true })).toBe(false);
    read(() => {
      throw new Error("boom");
    });
    expect(await isSiteCheckToolEnabled()).toBe(true);
    expect(await isSiteCheckToolEnabled({ strict: true })).toBe(false);
  });

  it("strict still follows the switch when it reads", async () => {
    read(async () => ({ data: { blob: {} }, error: null }));
    expect(await isSiteCheckToolEnabled({ strict: true })).toBe(true);
    read(async () => ({ data: { blob: { site_check_tool_enabled: false } }, error: null }));
    expect(await isSiteCheckToolEnabled({ strict: true })).toBe(false);
  });

  it("the worker gate's default deps read the switch strictly", async () => {
    read(async () => ({ data: null, error: { message: "down" } }));
    expect(await defaultTenantCardGateDeps.toolEnabled()).toBe(false);
  });
});

describe("delivery target", () => {
  it("comes from the run's own context, never the model", () => {
    expect(deliveryTargetFor({ tenant_id: "t", trigger: "chat", chat_thread_id: "th" })).toEqual({ kind: "chat", thread_id: "th" });
    expect(
      deliveryTargetFor({ tenant_id: "t", trigger: "slack", slack_routing: { channel_id: "C1", thread_ts: "1.2", team_id: "T1" } }),
    ).toEqual({ kind: "slack", channel_id: "C1", thread_ts: "1.2", team_id: "T1" });
    expect(deliveryTargetFor({ tenant_id: "t", trigger: "email" })).toEqual({ kind: "none" });
  });
});
