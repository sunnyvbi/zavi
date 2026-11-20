import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn() }));

import {
  checkHandoffJoin,
  composeJoinedOutput,
  parkCustomHandoff,
  type HelperRun,
  type JoinSeams,
  type ParkSeams,
} from "../custom-agent-handoff";

const T = "t1";
const P = "parent-run";
const done = (id: string, agent_slug: string, output_text: string | null, status = "success"): HelperRun => ({ id, agent_slug, status, output_text });

describe("composeJoinedOutput: the Competitor Watcher message", () => {
  it("own summary, then what each helper found, in handoff order", () => {
    const text = composeJoinedOutput(
      "Brightly launched a free plan.",
      ["c1", "c2"],
      [done("c2", "c-abcdefghij", "Nook raised prices."), done("c1", "research", "Acme hired a VP Sales.")],
      { "c-abcdefghij": "Pricing Watch" },
    );
    expect(text).toBe(
      "Brightly launched a free plan.\n\nWhat Research found:\nAcme hired a VP Sales.\n\nWhat Pricing Watch found:\nNook raised prices.",
    );
  });

  it("a helper still running, missing, or failed is named, never dropped silently", () => {
    const text = composeJoinedOutput(
      "Summary.",
      ["run", "gone", "bad"],
      [done("run", "research", null, "running"), done("bad", "growth-lead", "partial", "failed")],
      {},
    );
    expect(text).toContain("Research did not finish in time. Its result will be in its run history.");
    expect(text).toContain("A helper did not finish in time.");
    expect(text).toContain("Growth lead could not finish this time.");
    expect(text).not.toContain("partial");
  });

  it("long findings are cut", () => {
    const text = composeJoinedOutput("S.", ["c1"], [done("c1", "research", "x".repeat(10_000))], {});
    expect(text.length).toBeLessThan(6100);
    expect(text.endsWith("…")).toBe(true);
  });
});

function joinWorld(
  over: Partial<JoinSeams> & { status?: string; deadline?: string; lease?: string | null; attempts?: number; helpers?: HelperRun[] } = {},
) {
  const delivered: string[] = [];
  const seams: JoinSeams = {
    readJoin: vi.fn(async () => ({
      status: over.status ?? "waiting",
      deadline_at: over.deadline ?? "2026-09-28T09:30:00Z",
      child_run_ids: ["c1"],
      lease_until: over.lease ?? null,
    })),
    readHelpers: vi.fn(async () => over.helpers ?? [done("c1", "research", "Acme hired.")]),
    claim: vi.fn(async () => ({ parent_output: "Brightly launched.", child_run_ids: ["c1"], attempts: over.attempts ?? 1 })),
    settle: vi.fn(async () => {}),
    alreadyDelivered: vi.fn(async () => false),
    helperNames: vi.fn(async () => ({})),
    deliver: vi.fn(async (_t, _p, combined: string) => {
      delivered.push(combined);
      return "delivered";
    }),
    ...over,
  };
  return { seams, delivered };
}

describe("checkHandoffJoin", () => {
  const before = new Date("2026-09-28T09:05:00Z");
  const after = new Date("2026-09-28T09:31:00Z");

  it("helper done: claims, delivers ONE combined message, THEN settles delivered", async () => {
    const w = joinWorld();
    expect(await checkHandoffJoin(T, P, before, w.seams)).toEqual({ state: "done", outcome: "delivered" });
    expect(w.delivered).toEqual(["Brightly launched.\n\nWhat Research found:\nAcme hired."]);
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "delivered");
  });

  it("a send that did not go out (transient, or a throw) goes back to waiting and is retried", async () => {
    for (const deliver of [vi.fn(async () => "transient_delivery"), vi.fn(async () => { throw new Error("db"); })]) {
      const w = joinWorld({ deliver });
      expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("wait");
      expect(w.seams.settle).toHaveBeenCalledWith(T, P, "waiting");
    }
  });

  it("after the last attempt it gives up (settled), never loops forever", async () => {
    const w = joinWorld({ attempts: 10, deliver: vi.fn(async () => "transient_delivery") });
    expect((await checkHandoffJoin(T, P, after, w.seams)).state).toBe("done");
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "delivered");
  });

  it("a real delivery failure is settled (the finish hook already counted it)", async () => {
    const w = joinWorld({ deliver: vi.fn(async () => "failed_delivery") });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("done");
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "delivered");
  });

  it("the agent or schedule is gone: cancelled", async () => {
    const w = joinWorld({ deliver: vi.fn(async () => "skipped_missing") });
    await checkHandoffJoin(T, P, before, w.seams);
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "cancelled");
  });

  it("another call holds a live lease: wait, do not claim", async () => {
    const w = joinWorld({ status: "delivering", lease: "2026-09-28T09:10:00Z" });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("wait");
    expect(w.seams.claim).not.toHaveBeenCalled();
  });

  it("a sender that sent and died before settling (lease lapsed, outcome recorded): NOT sent again", async () => {
    const w = joinWorld({ status: "delivering", lease: "2026-09-28T09:00:00Z", alreadyDelivered: vi.fn(async () => true) });
    expect(await checkHandoffJoin(T, P, before, w.seams)).toEqual({ state: "done", outcome: "already_delivered" });
    expect(w.delivered).toEqual([]);
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "delivered");
  });

  it("lease lapsed and the outcome cannot be read: waits, never sends blind", async () => {
    const w = joinWorld({ status: "delivering", lease: "2026-09-28T09:00:00Z", alreadyDelivered: vi.fn(async () => { throw new Error("db"); }) });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("wait");
    expect(w.delivered).toEqual([]);
    expect(w.seams.settle).toHaveBeenCalledWith(T, P, "waiting");
  });

  it("a retake after a waiting reset (attempts > 1) still reads the outcome and does not re-send", async () => {
    const w = joinWorld({ attempts: 2, alreadyDelivered: vi.fn(async () => true) });
    expect(await checkHandoffJoin(T, P, before, w.seams)).toEqual({ state: "done", outcome: "already_delivered" });
    expect(w.delivered).toEqual([]);
  });

  it("a sender that died mid-send (lease lapsed): taken again and sent", async () => {
    const w = joinWorld({ status: "delivering", lease: "2026-09-28T09:00:00Z", helpers: [done("c1", "research", null, "running")] });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("done");
    expect(w.seams.claim).toHaveBeenCalled();
  });

  it("helper still running and time left: waits, delivers nothing", async () => {
    const w = joinWorld({ helpers: [done("c1", "research", null, "running")] });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("wait");
    expect(w.seams.claim).not.toHaveBeenCalled();
    expect(w.delivered).toEqual([]);
  });

  it("deadline passed with the helper still running: sends anyway, naming it unfinished", async () => {
    const w = joinWorld({ helpers: [done("c1", "research", null, "running")] });
    expect((await checkHandoffJoin(T, P, after, w.seams)).state).toBe("done");
    expect(w.delivered[0]).toContain("Research did not finish in time.");
  });

  it("claim lost (another check won): delivers nothing", async () => {
    const w = joinWorld({ claim: vi.fn(async () => null) });
    expect((await checkHandoffJoin(T, P, before, w.seams)).state).toBe("skip");
    expect(w.delivered).toEqual([]);
  });

  it("already delivered or cancelled: nothing", async () => {
    for (const status of ["delivered", "cancelled", "open"]) {
      const w = joinWorld({ status });
      expect((await checkHandoffJoin(T, P, after, w.seams)).state).toBe("skip");
      expect(w.seams.claim).not.toHaveBeenCalled();
    }
  });
});

describe("parkCustomHandoff", () => {
  const seams = (over: Partial<ParkSeams> = {}): ParkSeams => ({
    park: vi.fn(async () => true),
    sendJoinEvent: vi.fn(async () => {}),
    cancel: vi.fn(async () => true),
    warn: vi.fn(),
    ...over,
  });
  const p = { tenant_id: T, run_id: P, output: "Summary." };

  it("no handoff out: not parked, deliver now", async () => {
    const s = seams({ park: vi.fn(async () => false) });
    expect(await parkCustomHandoff(p, s)).toBe(false);
    expect(s.sendJoinEvent).not.toHaveBeenCalled();
  });

  it("handoff out: parked and the join started", async () => {
    const s = seams();
    expect(await parkCustomHandoff(p, s)).toBe(true);
    expect(s.sendJoinEvent).toHaveBeenCalledWith(T, P);
  });

  it("the join cannot start: tried twice, then cancelled, deliver now (never waits forever)", async () => {
    const s = seams({ sendJoinEvent: vi.fn(async () => { throw new Error("inngest down"); }) });
    expect(await parkCustomHandoff(p, s)).toBe(false);
    expect(s.sendJoinEvent).toHaveBeenCalledTimes(2);
    expect(s.cancel).toHaveBeenCalledWith(T, P);
  });

  it("a second try of the event succeeds: parked", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(undefined);
    const s = seams({ sendJoinEvent: send });
    expect(await parkCustomHandoff(p, s)).toBe(true);
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it("event unknown, cancel found the row already taken by a started join: stay parked (no double send)", async () => {
    const s = seams({ sendJoinEvent: vi.fn(async () => { throw new Error("timeout"); }), cancel: vi.fn(async () => false) });
    expect(await parkCustomHandoff(p, s)).toBe(true);
  });

  it("event unknown AND cancel failed: stay parked, never send now (no double send)", async () => {
    const s = seams({
      sendJoinEvent: vi.fn(async () => { throw new Error("timeout"); }),
      cancel: vi.fn(async () => { throw new Error("db"); }),
    });
    expect(await parkCustomHandoff(p, s)).toBe(true);
  });

  it("park itself fails: deliver now", async () => {
    const s = seams({ park: vi.fn(async () => { throw new Error("db"); }) });
    expect(await parkCustomHandoff(p, s)).toBe(false);
  });
});

describe("the real seams reach the join table through the tenant facade", () => {
  it("every table the join reads is tenant-scoped (an unclassified table throws at runtime)", async () => {
    const { scopeKind } = await vi.importActual<typeof import("@/services/tenant-client")>("@/services/tenant-client");
    for (const t of ["custom_agent_handoff_joins", "agent_runs", "custom_agents"]) {
      expect(scopeKind(t), t).toBe("tenant_id");
    }
  });
});

