import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/comms/safety-net", () => ({
  enforceCommsSafety: vi.fn(),
}));
vi.mock("../prospectStore", () => ({
  claimDueProspects: vi.fn(),
  advanceProspect: vi.fn(),
  stopProspect: vi.fn(),
}));

import { runSequenceTick } from "../sequenceEngine";
import { enforceCommsSafety } from "@/services/comms/safety-net";
import {
  claimDueProspects,
  advanceProspect,
  stopProspect,
} from "../prospectStore";

const gate = enforceCommsSafety as unknown as ReturnType<typeof vi.fn>;
const claim = claimDueProspects as unknown as ReturnType<typeof vi.fn>;
const advance = advanceProspect as unknown as ReturnType<typeof vi.fn>;
const stop = stopProspect as unknown as ReturnType<typeof vi.fn>;

function prospect(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    tenant_id: "t1",
    channel: "email",
    handle: "A@B.com",
    sequence_step: 0,
    sequence_state: "active",
    qualification_state: "qualified",
    ...over,
  } as never;
}

describe("runSequenceTick", () => {
  beforeEach(() => {
    gate.mockReset();
    claim.mockReset();
    advance.mockReset();
    stop.mockReset();
  });

  it("proposes an approval-gated send and advances a due prospect", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: true });
    advance.mockResolvedValue({ ok: true, completed: false, step: 1 });

    const proposeSend = vi.fn().mockResolvedValue(undefined);
    const res = await runSequenceTick({ proposeSend });

    expect(res.claimed).toBe(1);
    expect(res.proposed).toHaveLength(1);
    expect(res.proposed[0].decision_class).toBe("outbound.send");
    expect(res.proposed[0].step).toBe(0);
    expect(proposeSend).toHaveBeenCalledOnce();
    expect(res.advanced).toBe(1);
    expect(advance).toHaveBeenCalledWith("t1", "p1");
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", channel: "email", recipient: "a@b.com" }),
      undefined,
    );
  });

  it("stops the sequence on unsubscribe (stop-on-unsubscribe)", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: false, reason: "unsubscribed" });

    const proposeSend = vi.fn();
    const res = await runSequenceTick({ proposeSend });

    expect(stop).toHaveBeenCalledWith("t1", "p1", "unsubscribed");
    expect(res.stopped).toBe(1);
    expect(res.proposed).toHaveLength(0);
    expect(proposeSend).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("stops the sequence on suppression (do-not-contact) as manual", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: false, reason: "suppressed" });

    const res = await runSequenceTick({ proposeSend: vi.fn() });

    expect(stop).toHaveBeenCalledWith("t1", "p1", "manual");
    expect(res.stopped).toBe(1);
  });

  it("skips (no advance, no stop) on cap_exceeded — retried next tick", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: false, reason: "cap_exceeded" });

    const proposeSend = vi.fn();
    const res = await runSequenceTick({ proposeSend });

    expect(res.skipped).toEqual([{ prospectId: "p1", reason: "cap_exceeded" }]);
    expect(res.advanced).toBe(0);
    expect(res.stopped).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("skips on a transient store-unavailable block without stopping the prospect", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: false, reason: "cap_unavailable" });

    const res = await runSequenceTick({ proposeSend: vi.fn() });

    expect(res.skipped[0].reason).toBe("cap_unavailable");
    expect(stop).not.toHaveBeenCalled();
  });

  it("handles a mixed batch: one sends, one unsubscribed, one cap_exceeded", async () => {
    claim.mockResolvedValue([
      prospect({ id: "p1", handle: "a@b.com" }),
      prospect({ id: "p2", handle: "c@d.com" }),
      prospect({ id: "p3", handle: "e@f.com" }),
    ]);
    gate
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: "unsubscribed" })
      .mockResolvedValueOnce({ allowed: false, reason: "cap_exceeded" });
    advance.mockResolvedValue({ ok: true, completed: false, step: 1 });

    const res = await runSequenceTick({ proposeSend: vi.fn() });

    expect(res.claimed).toBe(3);
    expect(res.proposed).toHaveLength(1);
    expect(res.advanced).toBe(1);
    expect(res.stopped).toBe(1);
    expect(res.skipped).toHaveLength(1);
  });

  it("counts a completed sequence as advanced (last step)", async () => {
    claim.mockResolvedValue([prospect({ sequence_step: 2 })]);
    gate.mockResolvedValue({ allowed: true });
    advance.mockResolvedValue({ ok: true, completed: true, step: 3 });

    const res = await runSequenceTick({ proposeSend: vi.fn() });
    expect(res.advanced).toBe(1);
  });

  it("records a skip when advance fails after a send was proposed", async () => {
    claim.mockResolvedValue([prospect()]);
    gate.mockResolvedValue({ allowed: true });
    advance.mockResolvedValue({ ok: false, reason: "stopped:replied" });

    const res = await runSequenceTick({ proposeSend: vi.fn() });
    expect(res.advanced).toBe(0);
    expect(res.skipped[0].reason).toBe("stopped:replied");
  });

  it("empty due set is a no-op", async () => {
    claim.mockResolvedValue([]);
    const proposeSend = vi.fn();
    const res = await runSequenceTick({ proposeSend });
    expect(res).toEqual({ claimed: 0, proposed: [], advanced: 0, stopped: 0, skipped: [] });
    expect(proposeSend).not.toHaveBeenCalled();
  });
});
