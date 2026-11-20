import { describe, it, expect, vi } from "vitest";
import { discoveryEventId, sendConnectorDiscovery } from "../discovery-outbox";

describe("connector discovery outbox", () => {
  it("sends with a deterministic id per generation, then acknowledges that generation", async () => {
    const send = vi.fn(async () => undefined);
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(await sendConnectorDiscovery("t1", 4, { send, rpc: rpc as never, log: async () => undefined })).toBe(true);
    expect(send).toHaveBeenCalledWith({ id: discoveryEventId("t1", 4), name: "operator-db.discover.requested", data: { tenant_id: "t1" } });
    expect(rpc).toHaveBeenCalledWith("t1", "ack_db_connector_discovery", { p_generation: 4 });
  });
  it("a failed send is not acknowledged (the sweep resends)", async () => {
    const rpc = vi.fn();
    const log = vi.fn(async () => undefined);
    expect(await sendConnectorDiscovery("t1", 4, { send: async () => { throw new Error("down"); }, rpc: rpc as never, log })).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: "connector_discover_enqueue_failed" }));
  });
});
