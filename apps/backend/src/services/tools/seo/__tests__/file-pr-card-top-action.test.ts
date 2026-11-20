import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/services/channels/exec-emit", () => ({
  resolveChannelExecEmit: async (_set: unknown, ctx: unknown) => {
    seen.ctx = ctx;
    return async () => "a1";
  },
}));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: vi.fn() }));

import { prCardEmitter } from "../file-pr-card";

describe("prCardEmitter", () => {
  it("passes top_action_run to exec-emit", async () => {
    await prCardEmitter({ tenant_id: "T1", run_id: "R1", top_action_run: true }, { channel: "seo", execClass: "seo.create_pr.v1" } as never, {} as never, { title: "t", body: {} });
    expect(seen.ctx).toMatchObject({ tenant_id: "T1", run_id: "R1", top_action_run: true });
  });
});
