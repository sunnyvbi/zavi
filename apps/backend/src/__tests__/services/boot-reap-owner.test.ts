import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import { reapOrphanedRunsOnBoot } from "@/services/agents/boot-reap";
import { BOOT_REQUEUE_SETTLE_MS } from "@/services/agents/infra-retry";

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

function orPredicate(filter: string): Pred {
  const parts = filter.split(",").map((p) => {
    const [col, op, ...rest] = p.split(".");
    const val = rest.join(".");
    if (op === "is" && val === "null") return (r: Row) => r[col] === null || r[col] === undefined;
    if (op === "eq") return (r: Row) => r[col] === val;
    if (op === "not" && rest[0] === "like") {
      const prefix = rest.slice(1).join(".").replace(/^"|"$/g, "").replace(/\*$/, "");
      return (r: Row) => typeof r[col] === "string" && !(r[col] as string).startsWith(prefix);
    }
    throw new Error(`fake db: unsupported or() term ${p}`);
  });
  return (r) => parts.some((p) => p(r));
}

function fakeDb(rows: Row[]) {
  function from(table: string) {
    const preds: Pred[] = [];
    let patch: Row | null = null;
    let returning = false;
    const target = () => (table === "agent_runs" ? rows : []).filter((r) => preds.every((p) => p(r)));
    const run = () => {
      const hit = target();
      if (patch) {
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select() {
        if (patch) returning = true;
        return b;
      },
      update(p: Row) {
        patch = p;
        return b;
      },
      insert() {
        return b;
      },
      eq(c: string, v: unknown) {
        preds.push((r) => r[c] === v);
        return b;
      },
      neq(c: string, v: unknown) {
        preds.push((r) => r[c] !== v);
        return b;
      },
      or(f: string) {
        preds.push(orPredicate(f));
        return b;
      },
      lt(c: string, v: string) {
        preds.push((r) => typeof r[c] === "string" && (r[c] as string) < v);
        return b;
      },
      gte(c: string, v: string | number) {
        preds.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string | number) >= v);
        return b;
      },
      lte(c: string, v: string | number) {
        preds.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string | number) <= v);
        return b;
      },
      in(c: string, vs: unknown[]) {
        preds.push((r) => vs.includes(r[c]));
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle() {
        const { data } = run();
        return Promise.resolve({ data: (data as Row[] | null)?.[0] ?? null, error: null });
      },
      then(resolve: (r: unknown) => void, reject?: (e: unknown) => void) {
        try {
          resolve(run());
        } catch (e) {
          reject?.(e);
        }
      },
    };
    return b;
  }
  return { from, rpc: async () => ({ data: null, error: null }) } as never;
}

const BOOT = "2026-10-02T08:20:17.000Z";

const engineerRun = (over: Row): Row => ({
  tenant_id: "38910993-96c3-41c5-9f50-45cd6051757c",
  agent_slug: "engineer",
  agent_definition_hash: "eeb5ee00508002af",
  trigger: "a2a",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: null,
  started_at: "2026-10-02T08:16:02.000Z",
  enqueued_at: "2026-10-02T08:16:02.000Z",
  finished_at: null,
  batch_id: null,
  payload: {},
  ...over,
});

const prevRole = process.env.PRAXIS_CONTAINER_ROLE;
beforeEach(() => {
  vi.useFakeTimers();
  process.env.PRAXIS_CONTAINER_ROLE = "canonical";
});
afterEach(() => {
  vi.useRealTimers();
  if (prevRole === undefined) delete process.env.PRAXIS_CONTAINER_ROLE;
  else process.env.PRAXIS_CONTAINER_ROLE = prevRole;
});

describe("boot-reap on a database another backend also drains", () => {
  it("a deployed server owns every build: its boot recovers a laptop's orphan too (laptop deference is laptop-only)", async () => {
    const laptopRun = engineerRun({ id: "laptop-run", worker_id: "dev:unknown" });
    const canonicalOrphan = engineerRun({ id: "canonical-orphan", worker_id: "canonical" });
    const send = vi.fn().mockResolvedValue(undefined);
    const { requeued } = await reapOrphanedRunsOnBoot(BOOT, fakeDb([laptopRun, canonicalOrphan]), { send } as never, { ownRunsOnly: false });
    expect(requeued).toBe(2);
    expect(laptopRun).toMatchObject({ status: "queued", infra_retry_count: 1 });
  });

  it("a laptop's boot leaves another backend's live run alone and re-queues only its own orphan", async () => {
    const laptopLive = engineerRun({ id: "laptop-live", worker_id: "canonical" });
    const canonicalOrphan = engineerRun({ id: "canonical-orphan", worker_id: "dev:me" });
    const laptopParked = engineerRun({
      id: "laptop-parked",
      worker_id: "canonical",
      status: "queued",
      infra_retry_count: 1,
      started_at: null,
      enqueued_at: "2026-10-02T08:10:00.000Z",
    });
    const rows = [laptopLive, canonicalOrphan, laptopParked];
    const send = vi.fn().mockResolvedValue(undefined);

    const { requeued, reaped } = await reapOrphanedRunsOnBoot(BOOT, fakeDb(rows), { send } as never, { ownRunsOnly: true, workerId: "dev:me" });
    await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);

    expect(laptopLive).toMatchObject({ status: "running", infra_retry_count: 0, started_at: "2026-10-02T08:16:02.000Z" });
    expect(laptopParked).toMatchObject({ status: "queued", infra_retry_count: 1 });
    expect(canonicalOrphan).toMatchObject({ status: "queued", infra_retry_count: 1 });
    expect(requeued).toBe(1);
    expect(reaped).toBe(0);
    const sentRunIds = send.mock.calls.map(([e]) => (e as { data: { run_id: string } }).data.run_id);
    expect(sentRunIds).toEqual(["canonical-orphan"]);
  });

  it("an unclaimed legacy row (no worker_id) is still recovered on a laptop", async () => {
    const legacy = engineerRun({ id: "legacy", worker_id: null });
    const send = vi.fn().mockResolvedValue(undefined);
    const { requeued } = await reapOrphanedRunsOnBoot(BOOT, fakeDb([legacy]), { send } as never, { ownRunsOnly: true, workerId: "dev:me" });
    expect(requeued).toBe(1);
    expect(legacy).toMatchObject({ status: "queued", infra_retry_count: 1 });
  });

  it("a single host that restarts during the cutover leaves the split worker's live runs alone", async () => {
    const workerLive = engineerRun({ id: "worker-live", worker_id: "canonical:worker" });
    const ownOrphan = engineerRun({ id: "own-orphan", worker_id: "canonical" });
    const unclaimed = engineerRun({ id: "unclaimed", worker_id: null });
    const send = vi.fn().mockResolvedValue(undefined);
    const { requeued } = await reapOrphanedRunsOnBoot(
      BOOT,
      fakeDb([workerLive, ownOrphan, unclaimed]),
      { send } as never,
      { ownRunsOnly: false },
    );
    expect(requeued).toBe(2);
    expect(workerLive).toMatchObject({ status: "running", infra_retry_count: 0 });
    expect(ownOrphan).toMatchObject({ status: "queued" });
    expect(unclaimed).toMatchObject({ status: "queued" });
  });

  it("the split worker reaps only its own runs", async () => {
    process.env.PRAXIS_ROLE = "worker";
    try {
      const oldHost = engineerRun({ id: "old-host", worker_id: "canonical" });
      const mine = engineerRun({ id: "mine", worker_id: "canonical:worker" });
      const send = vi.fn().mockResolvedValue(undefined);
      const { requeued } = await reapOrphanedRunsOnBoot(BOOT, fakeDb([oldHost, mine]), { send } as never, { ownRunsOnly: true });
      expect(requeued).toBe(1);
      expect(oldHost).toMatchObject({ status: "running" });
      expect(mine).toMatchObject({ status: "queued" });
    } finally {
      delete process.env.PRAXIS_ROLE;
    }
  });
});
