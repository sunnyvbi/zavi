
import { describe, it, expect, vi } from "vitest";

vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: vi.fn(),
  startCardRpc: vi.fn(),
  tenantClient: vi.fn(),
  tenantRpc: vi.fn(),
  asTenantId: (s: string) => s,
}));
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: vi.fn(async () => 1) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { tenantClient } from "@/services/tenant-client";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import {
  ABANDONED_WAIT_MS,
  LATE_REFUND_TRIES,
  postSiteCheckResult,
  settleTenantCardFlow,
  type FlowStep,
} from "../site-check-settle";
import { SITE_CHECK_RESERVE_USD, siteCheckCostKey } from "../site-check-funding";
import { composeFounderResult } from "../site-check-result";
import type { StartCardRow } from "../store";

const SCORE = { total: 70, out_of: 100, by_check: { google: 16, ai: 12, seo: 18, design: 14, compare: null } };

function card(over: Partial<StartCardRow> = {}): StartCardRow {
  return {
    id: "card-1",
    public_id: "PUBLICID00000001",
    domain: "vercel.com",
    locale: "US",
    search_term: "deploy platform",
    status: "done",
    parts: {},
    score: SCORE as never,
    scorer_version: "1",
    evidence: {},
    ip_hash: null,
    referrer_card_id: null,
    budget_day: null,
    reserved_usd: SITE_CHECK_RESERVE_USD,
    spent_usd: 0.3,
    revoked_at: null,
    error: null,
    created_at: "2026-10-06T00:00:00Z",
    updated_at: "2026-10-06T00:02:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    funding_kind: "tenant_credits",
    funding_tenant_id: "t1",
    requested_by_run_id: "run-1",
    tool_call_id: "tu-1",
    delivery_state: "pending",
    delivery_target: { kind: "chat", thread_id: "th-1" },
    funding_settled_at: null,
    ...over,
  };
}

function mk(row: StartCardRow, over: Record<string, unknown> = {}) {
  let state = row;
  const deps = {
    getCard: vi.fn(async () => state),
    transition: vi.fn(async (_id: string, from: string, to: string) => {
      if (state.delivery_state !== from) return false;
      state = { ...state, delivery_state: to as StartCardRow["delivery_state"] };
      return true;
    }),
    addSideCost: vi.fn(async () => "added" as const),
    settleLate: vi.fn(async () => ({ status: "refunded" as const, credits: 64 })),
    runBelongsToTenant: vi.fn(async () => true),
    sideCostBilled: vi.fn(async () => true),
    post: vi.fn(async () => undefined),
    markSettled: vi.fn(async () => {
      state = { ...state, funding_settled_at: "now" };
    }),
    now: vi.fn(() => new Date("2026-10-06T00:10:00Z").getTime()),
    ...over,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { deps: deps as any, get: () => state };
}

function fakeStep(): FlowStep & { sleeps: string[] } {
  const sleeps: string[] = [];
  return {
    sleeps,
    run: async (_id, fn) => fn(),
    sleep: async (id) => {
      sleeps.push(id);
    },
  };
}

describe("settleTenantCardFlow", () => {
  it("pending result: posts once, refunds reserve - actual, marks settled", async () => {
    const { deps, get } = mk(card());
    const r = await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(r).toMatchObject({ status: "settled", delivered: "posted", refund: "refunded" });
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(deps.settleLate).toHaveBeenCalledWith({ tenantId: "t1", runId: "run-1", toolCallId: "tu-1", actualUsd: 0.3 });
    expect(get().delivery_state).toBe("delivered");
    expect(deps.markSettled).toHaveBeenCalledWith("card-1");
    expect(deps.addSideCost).not.toHaveBeenCalled();
  });

  it("refund 'pending' (run not settled yet) is retried after a durable sleep", async () => {
    let n = 0;
    const { deps } = mk(card(), {
      settleLate: vi.fn(async () => (++n < 3 ? { status: "pending" as const, credits: 0 } : { status: "refunded" as const, credits: 64 })),
    });
    const step = fakeStep();
    const r = await settleTenantCardFlow("card-1", step, deps);
    expect(r.status).toBe("settled");
    expect(deps.settleLate).toHaveBeenCalledTimes(3);
    expect(step.sleeps.filter((s) => s.startsWith("late-refund-wait"))).toHaveLength(2);
  });

  it("gives up after the retry budget WITHOUT marking settled, so the sweep re-kicks it", async () => {
    const { deps } = mk(card(), { settleLate: vi.fn(async () => ({ status: "pending" as const, credits: 0 })) });
    const r = await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(r.status).toBe("refund_pending");
    expect(deps.settleLate).toHaveBeenCalledTimes(LATE_REFUND_TRIES);
    expect(deps.markSettled).not.toHaveBeenCalled();
  });

  it("a second kick never posts twice (only the claim winner posts)", async () => {
    const { deps } = mk(card());
    await settleTenantCardFlow("card-1", fakeStep(), deps);
    await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it("a failed post puts the claim back so a retry posts it", async () => {
    let fail = true;
    const { deps, get } = mk(card(), {
      post: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error("slack down");
        }
      }),
    });
    await expect(settleTenantCardFlow("card-1", fakeStep(), deps)).rejects.toThrow("slack down");
    expect(get().delivery_state).toBe("pending");
    const { logEvent } = await import("@/services/logging/logEvent");
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "site_check_deliver_failed", message: expect.stringContaining("slack down") }),
    );
    await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(get().delivery_state).toBe("delivered");
  });

  it("a card the tool already returned: no post, no late charge to refund", async () => {
    const { deps } = mk(card({ delivery_state: "returned" }), {
      settleLate: vi.fn(async () => ({ status: "not_found" as const, credits: 0 })),
    });
    const r = await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(r).toMatchObject({ status: "settled", delivered: "not_pending", refund: "no_charge" });
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("re-review F3: a `returned` card the tool never billed is billed here under the tool's own key", async () => {
    const { deps } = mk(card({ delivery_state: "returned" }), {
      sideCostBilled: vi.fn(async () => false),
      settleLate: vi.fn(async () => ({ status: "not_found" as const, credits: 0 })),
    });
    const r = await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(deps.sideCostBilled).toHaveBeenCalledWith("t1", "run-1", "tu-1");
    expect(deps.addSideCost).toHaveBeenCalledTimes(1);
    expect(deps.addSideCost).toHaveBeenCalledWith({ tenantId: "t1", runId: "run-1", usd: 0.3, source: "site_check", key: siteCheckCostKey("tu-1") });
    expect(r).toMatchObject({ status: "settled" });
  });

  it("re-review F3: an already-billed `returned` card, or one that cost nothing, is never charged again", async () => {
    const billed = mk(card({ delivery_state: "returned" }), { settleLate: vi.fn(async () => ({ status: "not_found" as const, credits: 0 })) });
    await settleTenantCardFlow("card-1", fakeStep(), billed.deps);
    expect(billed.deps.addSideCost).not.toHaveBeenCalled();
    const failed = mk(card({ delivery_state: "returned", status: "failed", score: null }), {
      sideCostBilled: vi.fn(async () => false),
      settleLate: vi.fn(async () => ({ status: "not_found" as const, credits: 0 })),
    });
    await settleTenantCardFlow("card-1", fakeStep(), failed.deps);
    expect(failed.deps.addSideCost).not.toHaveBeenCalled();
  });

  it("re-review F3: a run that already finished is logged and absorbed (no retry loop, no second path)", async () => {
    const { deps } = mk(card({ delivery_state: "returned" }), {
      sideCostBilled: vi.fn(async () => false),
      addSideCost: vi.fn(async () => "run_finished" as const),
      settleLate: vi.fn(async () => ({ status: "not_found" as const, credits: 0 })),
    });
    const r = await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(deps.addSideCost).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "settled" });
  });

  it("a failed card refunds the whole reserve (actual 0) and still tells the founder", async () => {
    const { deps } = mk(card({ status: "failed", score: null, spent_usd: SITE_CHECK_RESERVE_USD }));
    await settleTenantCardFlow("card-1", fakeStep(), deps);
    expect(deps.settleLate.mock.calls[0][0].actualUsd).toBe(0);
    expect(deps.post.mock.calls[0][1]).toContain("couldn't finish");
  });

  it("while the tool may still be waiting, it waits; an orphaned wait is billed at actual cost", async () => {
    const created = new Date("2026-10-06T00:00:00Z").getTime();
    let t = created + 60_000;
    const { deps, get } = mk(card({ delivery_state: "waiting" }), { now: vi.fn(() => t) });
    const step = fakeStep();
    step.sleep = async (id) => {
      step.sleeps.push(id);
      t += 60_000;
    };
    await settleTenantCardFlow("card-1", step, deps);
    expect(step.sleeps.filter((s) => s.startsWith("tool-wait")).length).toBeGreaterThan(0);
    expect(t - created).toBeGreaterThanOrEqual(ABANDONED_WAIT_MS);
    expect(get().delivery_state).toBe("returned");
    expect(deps.addSideCost).toHaveBeenCalledWith({ tenantId: "t1", runId: "run-1", usd: 0.3, source: "site_check", key: siteCheckCostKey("tu-1") });
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("C8: a card whose run is not its tenant's is never settled or posted", async () => {
    const { deps } = mk(card(), { runBelongsToTenant: vi.fn(async () => false) });
    await expect(settleTenantCardFlow("card-1", fakeStep(), deps)).rejects.toThrow(/C8/);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.settleLate).not.toHaveBeenCalled();
  });

  it("skips public cards and cards still running", async () => {
    const pub = mk(card({ funding_kind: "public_budget", funding_tenant_id: null, requested_by_run_id: null, tool_call_id: null, delivery_state: null }));
    expect(await settleTenantCardFlow("card-1", fakeStep(), pub.deps)).toEqual({ status: "skip", reason: "not_tenant" });
    const running = mk(card({ status: "running" }));
    expect(await settleTenantCardFlow("card-1", fakeStep(), running.deps)).toEqual({ status: "skip", reason: "running" });
    expect(running.deps.settleLate).not.toHaveBeenCalled();
  });
});

describe("the founder's post", () => {
  it("is the score, the search term, one line per check and the link; no internal words", () => {
    const text = composeFounderResult(card());
    expect(text).toContain("Your site check for vercel.com is done: 70 out of 100.");
    expect(text).toContain('Search term we checked: "deploy platform".');
    expect(text).toContain("• Found on Google: 16/20");
    expect(text).toContain("• Vs your competitors: couldn't measure");
    expect(text).toMatch(/Full card: .*\/r\/PUBLICID00000001$/);
    expect(text).not.toMatch(/run_id|tool|credits_|tenant|card_id/i);
  });
});

describe("chat post dedupe (F8)", () => {
  function fakeDb(existing: Array<Record<string, unknown>>) {
    const inserts: Array<Record<string, unknown>> = [];
    const client = {
      from: (table: string) => {
        const filters: Array<[string, unknown]> = [];
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return q;
          },
          limit: async () => ({
            data: existing.filter((m) =>
              filters.every(([k, v]) => (k === "meta->>site_check_card" ? (m.meta as Record<string, unknown>)?.site_check_card === v : m[k] === v)),
            ),
            error: null,
          }),
          maybeSingle: async () => ({ data: table === "agent_threads" ? { id: "th-1" } : null, error: null }),
          insert: async (row: Record<string, unknown>) => {
            inserts.push(row);
            existing.push(row);
            return { error: null };
          },
          update: () => q,
        };
        return q;
      },
    };
    vi.mocked(tenantClient).mockReturnValue(client as never);
    return inserts;
  }

  it("posts once with the card's public id in meta", async () => {
    const inserts = fakeDb([]);
    await postSiteCheckResult(card(), "body");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ thread_id: "th-1", meta: { site_check_card: "PUBLICID00000001" } });
  });

  it("does not bind the late post to the run (the run already has its one assistant reply)", async () => {
    const inserts = fakeDb([]);
    await postSiteCheckResult(card(), "body");
    expect(inserts[0].agent_run_id).toBeNull();
    expect(inserts[0].meta).toMatchObject({ site_check_run_id: card().requested_by_run_id });
  });

  it("a retry after an insert that landed but reported an error does not post again", async () => {
    const inserts = fakeDb([{ thread_id: "th-1", meta: { site_check_card: "PUBLICID00000001" } }]);
    await postSiteCheckResult(card(), "body");
    expect(inserts).toHaveLength(0);
  });
});

describe("slack post escaping (F4)", () => {
  it("escapes &, < and > in the Slack body so a term like <!channel> stays text", async () => {
    vi.mocked(enqueueSlackOutbox).mockClear();
    const row = card({ delivery_target: { kind: "slack", channel_id: "C1", thread_ts: "1.2", team_id: "T1" } as never });
    await postSiteCheckResult(row, 'We checked "<!channel> tools & more" on Google.');
    expect(vi.mocked(enqueueSlackOutbox).mock.calls[0][0].body).toBe(
      'We checked "&lt;!channel&gt; tools &amp; more" on Google.',
    );
  });
});
