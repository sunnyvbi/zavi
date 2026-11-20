
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ["evt"] })),
  rpcResult: { duplicate: false, ingested_event_id: "ie1", work_item_id: "wi1" } as Record<string, unknown>,
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: async () => ({ data: m.rpcResult, error: null }) }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: async () => false,
  FleetHaltedError: class FleetHaltedError extends Error {},
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: async () => {
    throw new Error("no registry in test");
  },
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import { ingestAndEnqueueWorkItem } from "@/services/agents/work-queue";

const input = {
  tenant_id: "t-1",
  provider: "whatsapp" as const,
  external_event_id: "wamid.1",
  event_type: "message",
  ingest_payload: {},
  agent_slug: "operator",
  source: "webhook_whatsapp" as const,
  dedupe_key: "whatsapp:wamid.1",
  payload: { whatsapp: { wa_id: "1", phone_number_id: "PN1", message_id: "wamid.1", text: "hi" } },
};

beforeEach(() => {
  m.send.mockClear();
  m.send.mockResolvedValue({ ids: ["evt"] });
  m.rpcResult = { duplicate: false, ingested_event_id: "ie1", work_item_id: "wi1" };
  m.logEvent.mockClear();
});

describe("ingestAndEnqueueWorkItem → drainer wake-up", () => {
  it("fires agent.work_item.enqueued for a NEW item (tracing payload only)", async () => {
    const res = await ingestAndEnqueueWorkItem(input as never);
    expect(res).toEqual({ duplicate: false, ingested_event_id: "ie1", work_item_id: "wi1" });
    await Promise.resolve();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledWith({
      name: "agent.work_item.enqueued",
      data: { work_item_id: "wi1", tenant_id: "t-1", source: "webhook_whatsapp" },
    });
  });

  it("does NOT fire on a duplicate redelivery (nothing new to drain)", async () => {
    m.rpcResult = { duplicate: true };
    expect(await ingestAndEnqueueWorkItem(input as never)).toEqual({ duplicate: true });
    await Promise.resolve();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("is best-effort — a failed send never fails the ingest (the cron is the floor)", async () => {
    m.send.mockRejectedValueOnce(new Error("inngest down"));
    await expect(ingestAndEnqueueWorkItem(input as never)).resolves.toMatchObject({ duplicate: false });
  });

  it("records a failed send instead of swallowing it (a silent revert to ~40s replies has no signal)", async () => {
    m.send.mockRejectedValueOnce(new Error("inngest down"));
    await ingestAndEnqueueWorkItem(input as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", code: "work_item.wake_send_failed", tenant_id: "t-1" }),
    );
  });
});
