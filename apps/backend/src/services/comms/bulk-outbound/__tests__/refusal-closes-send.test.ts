import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { executeBulkOutboundDispatch } from "../dispatch";
import { DECISION, TENANT, harness, people } from "./harness";

const dispatch = (h: ReturnType<typeof harness>) => executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });

describe("a send held before anyone was emailed is reported as refused AND closed for good", () => {
  it("the provider refused every email on the first try: refused, and the frozen send can no longer be resumed", async () => {
    const h = harness({ emails: people(4) });
    h.wire.mockResolvedValueOnce({ kind: "stop_all", status: 401 });
    const r = await dispatch(h);
    expect(r).toMatchObject({ ok: false, status: "refused", code: "provider_refused" });
    const send = [...h.ledger.sends.values()][0];
    expect(send.status).toBe("failed");
    expect(await h.ledger.closeHeldSend(TENANT, send.id)).toBe(false);
  });

  it("an unknown outcome on the first try: refused but left held, never closed (it may have gone out)", async () => {
    const h = harness({ emails: people(3) });
    h.wire.mockResolvedValueOnce({ kind: "unknown" }).mockResolvedValueOnce({ kind: "stop_all", status: 401 });
    await dispatch(h);
    expect([...h.ledger.sends.values()][0].status).toBe("held");
  });

  it("paused between the handler's check and the first chunk: the send stays held to resume, the decision is not refused", async () => {
    const h = harness({ emails: people(3) });
    h.deps.paused = async () => true;
    const r = await dispatch(h);
    expect(r).toMatchObject({ ok: true, state: "held", counts: { hold_reason: "email_paused" } });
    expect([...h.ledger.sends.values()][0].status).toBe("held");
  });
});
