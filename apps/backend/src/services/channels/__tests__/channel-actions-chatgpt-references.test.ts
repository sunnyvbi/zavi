import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ read: vi.fn(), filters: vi.fn(), tenant: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: (id: string) => {
    m.tenant(id);
    const q: Record<string, unknown> = {};
    for (const key of ["from", "select", "eq", "in", "not"]) {
      q[key] = (...args: unknown[]) => { m.filters(key, ...args); return q; };
    }
    q.then = (resolve: (value: unknown) => unknown) => m.read().then(resolve);
    return q;
  },
}));
import { asTenantId } from "@/services/tenant-client";
import { loadChatgptExecReferences } from "../channel-actions";

beforeEach(() => { vi.clearAllMocks(); });

it("looks up named pending and snoozed executable cards in this tenant without filtering execution status", async () => {
  m.read.mockResolvedValue({ data: [{ id: "snoozed-attempted-card" }], error: null });
  expect(await loadChatgptExecReferences(asTenantId("tenant-a"), ["snoozed-attempted-card"])).toEqual(["snoozed-attempted-card"]);
  expect(m.tenant).toHaveBeenCalledWith("tenant-a");
  expect(m.filters.mock.calls).toEqual([
    ["from", "channel_actions"], ["select", "id"], ["in", "id", ["snoozed-attempted-card"]],
    ["eq", "channel_slug", "chatgpt_ads"], ["in", "status", ["pending", "snoozed"]], ["not", "exec_class", "is", null],
  ]);
});

it("does not read when nothing was referenced", async () => {
  expect(await loadChatgptExecReferences(asTenantId("tenant-a"), [])).toEqual([]);
  expect(m.tenant).not.toHaveBeenCalled();
});

it("drops no reminder on a failed reference read", async () => {
  m.read.mockResolvedValue({ data: null, error: { message: "read unavailable" } });
  expect(await loadChatgptExecReferences(asTenantId("tenant-a"), ["card"])).toEqual([]);
});
