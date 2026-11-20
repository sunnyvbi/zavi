import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: vi.fn(), asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn(), opsRpc: vi.fn() }));

import {
  applyClearHold,
  applyResumeSend,
  BULK_CLEAR_HOLD_KEY,
  BULK_RESUME_SEND_KEY,
  clearHoldConfirmPhrase,
  previewResumeSend,
  resumeConfirmPhrase,
  type BulkScriptDeps,
  type HeldSend,
} from "../bulk-email";
import { getScript } from "../registry";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND = "00000000-0000-4000-8000-000000000001";
const STAFF = { user_id: "staff-1", email: "ops@zaviagent.com" };

const held = (over: Partial<HeldSend> = {}): HeldSend => ({
  send_id: SEND, tenant_id: TENANT, status: "held", hold_reason: "list_archived", total: 300,
  counts: { sent: 100, unknown: 1, pending: 199 }, workspace_on_hold: false, ...over,
  ...(over.hold_reason === undefined ? { hold_reason: "provider_refused" } : {}),
});

function deps(over: Partial<BulkScriptDeps> = {}): BulkScriptDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    readHold: vi.fn().mockResolvedValue({ tenant_id: TENANT, send_id: SEND, reason: "abuse_complaints", created_at: "2026-10-07T00:00:00Z", cleared_at: null }),
    clearHold: vi.fn().mockResolvedValue({ ok: true, bulk_email_reenabled: true }),
    readSend: vi.fn().mockResolvedValue(held()),
    resumeSend: vi.fn().mockResolvedValue({ ok: true, pending: 199 }),
    startFanout: vi.fn().mockResolvedValue(undefined),
    readGlobalStop: vi.fn().mockResolvedValue("running"),
    readPaused: vi.fn().mockResolvedValue(false),
    ...over,
  } as never;
}

describe("bulk-email admin scripts", () => {
  it("are registered, apply, and need the exact confirmation phrase", async () => {
    const clear = getScript(BULK_CLEAR_HOLD_KEY)!;
    const resume = getScript(BULK_RESUME_SEND_KEY)!;
    expect(clear.applies && resume.applies).toBe(true);
    await expect(clear.prepareApply!({ tenant_id: TENANT }, { staff: STAFF, env: {} }, "CLEAR HOLD nope")).rejects.toMatchObject({ code: "confirm_mismatch" });
    await expect(resume.prepareApply!({ send_id: SEND }, { staff: STAFF, env: {} }, "RESUME")).rejects.toMatchObject({ code: "confirm_mismatch" });
    expect(clearHoldConfirmPhrase(TENANT)).toBe(`CLEAR HOLD ${TENANT}`);
    expect(resumeConfirmPhrase(SEND)).toBe(`RESUME ${SEND}`);
  });

  it("clearing a hold says whether bulk email was switched back on (only when the shutoff switched it off)", async () => {
    const d = deps();
    const out = await applyClearHold({ tenant_id: TENANT }, STAFF, d);
    expect(d.clearHold).toHaveBeenCalledWith(TENANT, "staff-1");
    expect(out).toMatchObject({ tenant_id: TENANT, cleared: true, bulk_email_reenabled: true });

    const off = deps({ clearHold: vi.fn().mockResolvedValue({ ok: true, bulk_email_reenabled: false }) });
    const out2 = await applyClearHold({ tenant_id: TENANT }, STAFF, off);
    expect(out2).toMatchObject({ bulk_email_reenabled: false });
    expect(out2.note).toMatch(/NOT switched back on: it was switched off by staff or the founder/);
  });

  it("no open hold, or a caller who is not active staff, is refused", async () => {
    const d = deps({ readHold: vi.fn().mockResolvedValue({ tenant_id: TENANT, send_id: null, reason: "abuse_bounces", created_at: "x", cleared_at: "y" }) });
    await expect(applyClearHold({ tenant_id: TENANT }, STAFF, d)).rejects.toMatchObject({ code: "no_open_hold" });
    expect(d.clearHold).not.toHaveBeenCalled();
    const ns = deps({ clearHold: vi.fn().mockResolvedValue({ ok: false, reason: "not_staff" }) });
    await expect(applyClearHold({ tenant_id: TENANT }, STAFF, ns)).rejects.toMatchObject({ code: "not_staff", status: 403 });
  });

  it("resume continues the SAME send in its own workspace and starts the worker", async () => {
    const d = deps();
    const out = await applyResumeSend({ send_id: SEND }, d);
    expect(d.resumeSend).toHaveBeenCalledWith(TENANT, SEND);
    expect(d.startFanout).toHaveBeenCalledWith(SEND);
    expect(out).toEqual({ send_id: SEND, tenant_id: TENANT, resumed: true, pending: 199 });
  });

  it("resume is refused while the global stop is off or unreadable, and the held send stays held and resumable", async () => {
    const ledger = (): { row: HeldSend; d: ReturnType<typeof deps> } => {
      const row = held({ hold_reason: "bulk_check_failed" });
      const d = deps({
        readSend: vi.fn(async () => ({ ...row, counts: { ...row.counts } })),
        resumeSend: vi.fn(async () => {
          row.status = "sending";
          row.hold_reason = null;
          return { ok: true, pending: 199 };
        }),
      });
      return { row, d };
    };
    for (const stop of ["stopped", "unreadable"] as const) {
      const { row, d } = ledger();
      vi.mocked(d.readGlobalStop).mockResolvedValue(stop);
      await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toMatchObject({
        code: "bulk_sending_paused",
        message: "Bulk email is paused for everyone (the global stop). Turn it back on before resuming a send.",
      });
      expect(d.readGlobalStop).toHaveBeenCalledTimes(1);
      expect(d.resumeSend).not.toHaveBeenCalled();
      expect(d.startFanout).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: "held", hold_reason: "bulk_check_failed" });
      const p = await previewResumeSend({ send_id: SEND }, d);
      expect(p.refusal).toBe("bulk_sending_paused");
    }
    const { row, d } = ledger();
    const out = await applyResumeSend({ send_id: SEND }, d);
    expect(out).toEqual({ send_id: SEND, tenant_id: TENANT, resumed: true, pending: 199 });
    expect(d.resumeSend).toHaveBeenCalledWith(TENANT, SEND);
    expect(d.startFanout).toHaveBeenCalledWith(SEND);
    expect(row.status).toBe("sending");
  });

  it("resume is refused while the founder has email paused: the dry run and apply both say so, the send stays held and no worker starts", async () => {
    const row = held({ hold_reason: "provider_refused" });
    const d = deps({
      readSend: vi.fn(async () => ({ ...row, counts: { ...row.counts } })),
      resumeSend: vi.fn(async () => {
        row.status = "sending";
        row.hold_reason = null;
        return { ok: true, pending: 199 };
      }),
      readPaused: vi.fn().mockResolvedValue(true),
    });
    const p = await previewResumeSend({ send_id: SEND }, d);
    expect(p.refusal).toBe("email_paused");
    await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toMatchObject({
      code: "email_paused",
      message: "The founder has paused email for that workspace, so nobody would be emailed. The send stays held; resume it after they resume email.",
    });
    expect(d.readPaused).toHaveBeenCalledWith(TENANT);
    expect(d.resumeSend).not.toHaveBeenCalled();
    expect(d.startFanout).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "held", hold_reason: "provider_refused" });
    vi.mocked(d.readPaused).mockRejectedValue(new Error("email_send_paused failed"));
    await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toThrow("email_send_paused failed");
    expect(d.resumeSend).not.toHaveBeenCalled();
  });

  it("resume is refused, and no worker starts, while the workspace is on hold", async () => {
    const d = deps({ resumeSend: vi.fn().mockResolvedValue({ ok: false, reason: "abuse_hold" }) });
    await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toMatchObject({ code: "abuse_hold" });
    expect(d.startFanout).not.toHaveBeenCalled();
  });

  it("a send held for a reason only the founder can fix is not resumable", async () => {
    for (const hold_reason of ["sending_domain_not_verified", "list_archived", "list_not_consented", "bulk_outbound_disabled", "bulk_sending_paused"]) {
      const p = await previewResumeSend({ send_id: SEND }, deps({ readSend: vi.fn().mockResolvedValue(held({ hold_reason })) }));
      expect(p.refusal).toBe("not_resumable");
    }
    const d = deps({ resumeSend: vi.fn().mockResolvedValue({ ok: false, reason: "not_resumable" }) });
    await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toMatchObject({ code: "not_resumable" });
    expect(d.startFanout).not.toHaveBeenCalled();
  });

  it("the dry run refuses with bulk_sending_paused whenever apply would, and never touches the send", async () => {
    for (const stop of ["stopped", "unreadable"] as const) {
      for (const send of [held({ hold_reason: "bulk_check_failed" }), held({ status: "sending" }), held({ workspace_on_hold: true })]) {
        const d = deps({ readSend: vi.fn().mockResolvedValue(send), readGlobalStop: vi.fn().mockResolvedValue(stop) });
        const p = await previewResumeSend({ send_id: SEND }, d);
        expect(p.refusal).toBe("bulk_sending_paused");
        await expect(applyResumeSend({ send_id: SEND }, d)).rejects.toMatchObject({ code: p.refusal });
        expect(d.resumeSend).not.toHaveBeenCalled();
        expect(d.startFanout).not.toHaveBeenCalled();
      }
    }
    const ok = await previewResumeSend({ send_id: SEND }, deps({ readSend: vi.fn().mockResolvedValue(held({ hold_reason: "bulk_check_failed" })) }));
    expect(ok).toMatchObject({ refusal: null, would_email: 199 });
  });

  it("the dry run says who would be emailed: only people still waiting", async () => {
    const p = await previewResumeSend({ send_id: SEND }, deps());
    expect(p).toMatchObject({ would_email: 199, refusal: null });
    const p2 = await previewResumeSend({ send_id: SEND }, deps({ readSend: vi.fn().mockResolvedValue(held({ workspace_on_hold: true })) }));
    expect(p2.refusal).toBe("workspace_on_abuse_hold");
    expect(JSON.stringify(p)).not.toContain("@");
  });
});
