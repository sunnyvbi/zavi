import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import { bulkSendLine } from "../notices";
import { bulkSendOutcome } from "@/services/email-cards/outcome";
import type { BulkRefusalCode } from "../readiness";
import { DECISION, FROM, LIST, TENANT, harness, people } from "./harness";

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

function resumeEmail(h: ReturnType<typeof harness>): string[] {
  const resumed: string[] = [];
  for (const [id, s] of h.ledger.sends) {
    if (s.status === "held" && s.hold_reason === "email_paused") {
      s.status = "sending";
      s.hold_reason = null;
      s.next_run_at = null;
      resumed.push(id);
    }
  }
  return resumed;
}

const HOLDS: BulkRefusalCode[] = ["bulk_sending_paused", "bulk_abuse_hold", "bulk_outbound_disabled"];

describe("email resumed while a Zavi sender hold is active", () => {
  for (const code of HOLDS) {
    it(`${code}: the send settles held under ${code} for good, nobody is emailed, the approver is told, and later pause/resume cycles never restart it`, async () => {
      const h = harness({ emails: people(5) });
      let paused = true;
      h.deps.paused = async () => paused;
      const send = await frozen(h);
      expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "held", counts: { hold_reason: "email_paused" } });

      h.state.refusal = code;
      paused = false;
      expect(resumeEmail(h)).toEqual([send]);
      const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
      expect(r).toMatchObject({ state: "held", counts: { status: "held", hold_reason: code, sent: 0, pending: 5 } });
      expect(h.wire).not.toHaveBeenCalled();
      if (r.state === "missing") throw new Error("missing");
      expect(bulkSendOutcome(TENANT, DECISION, "held", r.counts, bulkSendLine("held", r.counts))).toMatchObject({ outcome: "failed", sent: 0 });

      h.state.refusal = null;
      paused = true;
      paused = false;
      expect(resumeEmail(h)).toEqual([]);
      expect(h.ledger.sends.get(send)).toMatchObject({ status: "held", hold_reason: code });
      expect(h.wire).not.toHaveBeenCalled();
    });
  }
});
