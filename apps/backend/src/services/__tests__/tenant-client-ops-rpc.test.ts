import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn(() => "called"));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));
import { opsRpc } from "../tenant-client";

describe("opsRpc", () => {
  it.each(["claim_ops_alerts", "finish_ops_alert", "list_failed_open_channel_actions"])("passes %s through", (name) => {
    expect(opsRpc(name, { a: 1 })).toBe("called");
    expect(rpc).toHaveBeenLastCalledWith(name, { a: 1 });
  });
  it.each(["settle_channel_action_exec", "stamp_channel_action_exec_verdict", "apply_exec_failure_verdict", "enqueue_ops_alert"])("refuses %s", (name) => {
    expect(() => opsRpc(name)).toThrow(/not an ops RPC/);
  });
});
