
import { describe, it, expect, vi, beforeEach } from "vitest";

const refund = vi.hoisted(() => vi.fn(async (_run_id: string) => ({ granted: 0 })));

vi.mock("../../../workers/client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, fn: unknown) => fn },
}));
vi.mock("@/services/growth/setup-draft-refund", () => ({ refundSetupDraftRun: refund }));

import { setupDraftRefundOnCompleteFn, setupDraftRefundOnFailFn } from "../../../workers/functions/setup-draft-refund";

type Handler = (ctx: unknown) => Promise<unknown>;
const step = { run: (_: string, f: () => unknown) => f() };
const handlers: Array<[string, Handler]> = [
  ["on-complete", setupDraftRefundOnCompleteFn as unknown as Handler],
  ["on-fail", setupDraftRefundOnFailFn as unknown as Handler],
];

beforeEach(() => {
  refund.mockClear();
});

describe.each(handlers)("setup draft refund listener (%s)", (_name, fn) => {
  it("skips any agent but cgo, without a refund", async () => {
    const out = await fn({ event: { data: { agent_slug: "growth-lead", run_id: "run-1", tenant_id: "evil" } }, step });
    expect(out).toEqual({ skipped: "not_cgo" });
    expect(refund).not.toHaveBeenCalled();
  });
  it("refunds a cgo run by run_id ONLY, never with the payload tenant", async () => {
    await fn({ event: { data: { agent_slug: "cgo", run_id: "run-1", tenant_id: "evil" } }, step });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]).toEqual(["run-1"]);
  });
});
