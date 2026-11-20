
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CHANNEL = "meta_ads";
const ESTIMATE = 160;

type ClaimRow = {
  id: string;
  tenant_id: string;
  channel_slug: string;
  request_id: string;
  estimate: number;
  run_id: string | null;
  settled_at: string | null;
};

const claims: ClaimRow[] = [];
const runs = new Map<string, { tenant_id: string; estimate: number }>();
const stampedRuns = new Set<string>();
let cap = 2000;
let claimSeq = 0;
let runSeq = 0;
let stampWorks = true;
const tenantLock = new Map<string, Promise<unknown>>();

const tick = () => new Promise((r) => setTimeout(r, 0));

function withTenantLock<T>(tid: string, fn: () => Promise<T>): Promise<T> {
  const prior = tenantLock.get(tid) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  tenantLock.set(tid, next.then(() => undefined, () => undefined));
  return next;
}

function ledgerSpend(tid: string): number {
  let sum = 0;
  for (const [id, run] of runs) {
    if (run.tenant_id === tid && stampedRuns.has(id)) sum += run.estimate;
  }
  return sum;
}

function pendingSpend(tid: string): number {
  return claims
    .filter((c) => c.tenant_id === tid && c.settled_at === null)
    .reduce((sum, c) => sum + c.estimate, 0);
}

const rpc = vi.fn(async (tid: string, name: string, args: Record<string, unknown>) => {
  if (name === "claim_channel_run") {
    return withTenantLock(tid, async () => {
      const slug = args.p_channel_slug as string;
      const key = args.p_request_id as string;
      await tick();
      const existing = claims.find(
        (c) => c.tenant_id === tid && c.channel_slug === slug && c.request_id === key,
      );
      if (existing) {
        return {
          data: { ok: true, duplicate: true, claim_id: existing.id, run_id: existing.run_id },
          error: null,
        };
      }
      const spent = ledgerSpend(tid);
      const pending = pendingSpend(tid);
      if (spent + pending + (args.p_estimate as number) > cap) {
        return {
          data: { ok: false, reason: "cap_reached", spent_30d: spent + pending },
          error: null,
        };
      }
      const row: ClaimRow = {
        id: `claim-${++claimSeq}`,
        tenant_id: tid,
        channel_slug: slug,
        request_id: key,
        estimate: args.p_estimate as number,
        run_id: null,
        settled_at: null,
      };
      claims.push(row);
      return { data: { ok: true, duplicate: false, claim_id: row.id }, error: null };
    });
  }
  if (name === "settle_channel_run_claim") {
    const row = claims.find((c) => c.id === args.p_claim_id && c.tenant_id === tid);
    if (row) {
      row.run_id = row.run_id ?? (args.p_run_id as string);
      if (args.p_visible_to_ledger !== false) row.settled_at = row.settled_at ?? "now";
    }
    return { data: Boolean(row), error: null };
  }
  if (name === "release_channel_run_claim") {
    const i = claims.findIndex(
      (c) => c.id === args.p_claim_id && c.tenant_id === tid && c.run_id === null,
    );
    if (i >= 0) claims.splice(i, 1);
    return { data: i >= 0, error: null };
  }
  if (name === "channel_budget_allows") {
    return { data: ledgerSpend(tid) + (args.p_estimate as number) <= cap, error: null };
  }
  if (name === "channel_credits_30d") {
    return { data: ledgerSpend(tid), error: null };
  }
  if (name === "stamp_channel_run") {
    if (!stampWorks) return { data: false, error: { message: "no such run" } };
    stampedRuns.add(args.p_run_id as string);
    return { data: true, error: null };
  }
  return { data: true, error: null };
});

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (t: string, n: string, a: Record<string, unknown>) => rpc(t, n, a),
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async () => false,
  comingSoonMessage: (name: string) => `${name} is coming soon.`,
}));
vi.mock("@/services/agents/credits", () => ({
  reserveEstimateFor: () => ESTIMATE,
}));

import { runChannelRecipe } from "@/services/channels/engine";

const enqueue = vi.fn(async ({ tenant_id }: { tenant_id: string }) => {
  await tick();
  const run_id = `run-${++runSeq}`;
  runs.set(run_id, { tenant_id, estimate: ESTIMATE });
  return { run_id };
});
const deps = { enqueue };

beforeEach(() => {
  claims.length = 0;
  runs.clear();
  stampedRuns.clear();
  tenantLock.clear();
  cap = 2000;
  claimSeq = 0;
  runSeq = 0;
  stampWorks = true;
  rpc.mockClear();
  enqueue.mockClear();
});

describe("POST /api/channels/:slug/run is idempotent", () => {
  it("two presses with the SAME request_id enqueue ONE run, and the second answers with the first's run id", async () => {
    const first = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0001");
    const second = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0001");

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect((second as { run_id: string }).run_id).toBe((first as { run_id: string }).run_id);
    expect(claims).toHaveLength(1);
  });

  it("two CONCURRENT presses with the same request_id still enqueue ONE run", async () => {
    const [a, b] = await Promise.all([
      runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0002"),
      runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0002"),
    ]);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(claims).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const dupes = [a, b].filter((r) => (r as { duplicate?: boolean }).duplicate === true);
    expect(dupes).toHaveLength(1);
    const ids = [a, b].map((r) => (r as { run_id: string | null }).run_id).filter(Boolean);
    expect(new Set(ids).size).toBe(1);
  });

  it("a duplicate is a SUCCESS, never a refusal the founder would read as a failure", async () => {
    await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0003");
    const again = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "press-0003");
    expect(again.ok).toBe(true);
    expect(again).not.toHaveProperty("message");
  });

  it("a press with no request_id still runs — an older client is not broken", async () => {
    await runChannelRecipe(TENANT_A, CHANNEL, deps);
    await runChannelRecipe(TENANT_A, CHANNEL, deps);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("a request_id is scoped by the tenant the SERVER derived", () => {
  it("the same request_id from two tenants does not collide and does not leak either run", async () => {
    const a = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "shared-id-01");
    const b = await runChannelRecipe(TENANT_B, CHANNEL, deps, undefined, undefined, "shared-id-01");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(b).toMatchObject({ ok: true, duplicate: false });
    expect((b as { run_id: string }).run_id).not.toBe((a as { run_id: string }).run_id);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it("a replay of tenant A's id under tenant A returns A's run, and under tenant B returns B's own", async () => {
    const a = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "shared-id-02");
    const b = await runChannelRecipe(TENANT_B, CHANNEL, deps, undefined, undefined, "shared-id-02");
    const aAgain = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "shared-id-02");
    const bAgain = await runChannelRecipe(TENANT_B, CHANNEL, deps, undefined, undefined, "shared-id-02");

    expect((aAgain as { run_id: string }).run_id).toBe((a as { run_id: string }).run_id);
    expect((bAgain as { run_id: string }).run_id).toBe((b as { run_id: string }).run_id);
    expect((aAgain as { run_id: string }).run_id).not.toBe((bAgain as { run_id: string }).run_id);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("a tenant with no budget left cannot be unblocked by another tenant's spare room", async () => {
    cap = ESTIMATE;
    await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "tenant-a-001");
    const aBlocked = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "tenant-a-002");
    const bAllowed = await runChannelRecipe(TENANT_B, CHANNEL, deps, undefined, undefined, "tenant-b-001");

    expect(aBlocked).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(bAllowed).toMatchObject({ ok: true });
  });
});

describe("the cap still bounds spend, and now it bounds it under concurrency", () => {
  it("refuses when the run would take the tenant past the cap", async () => {
    cap = ESTIMATE - 1;
    const r = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "over-cap-01");
    expect(r).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses the run that would exceed the cap once earlier runs are on the ledger", async () => {
    cap = ESTIMATE * 2;
    await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "seq-cap-001");
    await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "seq-cap-002");
    const third = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "seq-cap-003");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ ok: false, reason: "cap_reached" });
  });

  it("two CONCURRENT presses with DIFFERENT request_ids cannot both spend the last slot", async () => {
    cap = ESTIMATE;
    const [a, b] = await Promise.all([
      runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "race-id-0001"),
      runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "race-id-0002"),
    ]);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const accepted = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: "cap_reached" });
  });

  it("five CONCURRENT presses with different ids admit exactly as many as the cap allows", async () => {
    cap = ESTIMATE * 2;
    const results = await Promise.all(
      ["r-00000001", "r-00000002", "r-00000003", "r-00000004", "r-00000005"].map((id) =>
        runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, id),
      ),
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });
});

describe("a claim never holds budget it did not spend", () => {
  it("hands the budget back when the enqueue throws", async () => {
    cap = ESTIMATE;
    const boom = vi.fn(async () => {
      await tick();
      throw new Error("fleet halted");
    });
    await expect(
      runChannelRecipe(TENANT_A, CHANNEL, { enqueue: boom }, undefined, undefined, "throws-0001"),
    ).rejects.toThrow("fleet halted");
    expect(claims).toHaveLength(0);

    const after = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "after-0001");
    expect(after).toMatchObject({ ok: true });
  });

  it("keeps holding when the run enqueued but never got its channel stamp", async () => {
    stampWorks = false;
    const r = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "unstamped-01");
    expect(r).toMatchObject({ ok: true, stamped: false });
    expect(claims).toHaveLength(1);
    expect(claims[0].settled_at).toBeNull();
    expect(claims[0].run_id).toBe((r as { run_id: string }).run_id);

    const replay = await runChannelRecipe(TENANT_A, CHANNEL, deps, undefined, undefined, "unstamped-01");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((replay as { run_id: string }).run_id).toBe((r as { run_id: string }).run_id);
  });
});
