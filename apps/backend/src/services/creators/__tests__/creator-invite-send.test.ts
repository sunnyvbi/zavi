import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  eligibleRows: vi.fn(),
  reconcileLinks: vi.fn(),
  stampInvite: vi.fn(),
  markSendFailed: vi.fn(),
  recordSendAmbiguous: vi.fn(),
  sgSend: vi.fn(),
}));

vi.mock("@/email/sendAuthEmail", () => ({ sgSend: m.sgSend }));
vi.mock("../creator-invites", async (orig) => {
  const real = await orig<typeof import("../creator-invites")>();
  return {
    ...real,
    eligibleRows: m.eligibleRows,
    reconcileLinks: m.reconcileLinks,
    stampInvite: m.stampInvite,
    markSendFailed: m.markSendFailed,
    recordSendAmbiguous: m.recordSendAmbiguous,
  };
});

import { runInviteSend } from "../creator-invite-send";
import type { InviteRow } from "../creator-invites";

const env = {
  PRAXIS_PUBLIC_BASE: "https://www.zaviagent.com",
  BACKEND_PUBLIC_URL: "https://api.zaviagent.com",
  SYSTEM_SENDGRID_API_KEY: "SG.test",
};

function row(n: number): InviteRow {
  return {
    id: `id-${n}`,
    source_key: `k${n}`,
    email: `c${n}@example.com`,
    display_name: `Creator ${n}`,
    hold_reason: null,
    in_conversation: false,
    batch: "b1",
    unsub_token: `tok-${n}`,
    signup_token: `sig-${n}`,
    invited_at: null,
    send_failed_at: null,
    unsubscribed_at: null,
    bounced_at: null,
    human_member_id: null,
    claimed_at: null,
    member_deleted_at: null,
    source_meta: { sheet_row: n },
  };
}

const base = { batch: "b1", max: 100, retry: false, includeInConversation: false, acknowledgedNoGeo: true, env, sleep: async () => {} };

beforeEach(() => {
  vi.resetAllMocks();
  m.eligibleRows.mockResolvedValue({ candidates: [row(2), row(3)], skipped: [] });
  m.reconcileLinks.mockResolvedValue(0);
  m.stampInvite.mockResolvedValue(true);
  m.sgSend.mockResolvedValue(undefined);
});

describe("runInviteSend", () => {
  it("dry run stamps and sends nothing, and does not repair links", async () => {
    const res = await runInviteSend({ ...base, apply: false });
    expect(res.toSend.map((r) => r.id)).toEqual(["id-2", "id-3"]);
    expect(res.problems).toEqual([]);
    expect(m.stampInvite).not.toHaveBeenCalled();
    expect(m.sgSend).not.toHaveBeenCalled();
    expect(m.reconcileLinks).not.toHaveBeenCalled();
  });

  it("apply stamps each row before sending it, and reports progress per row", async () => {
    const order: string[] = [];
    m.stampInvite.mockImplementation(async (id: string) => (order.push(`stamp ${id}`), true));
    m.sgSend.mockImplementation(async (to: string) => void order.push(`send ${to}`));
    const progress = vi.fn();
    const res = await runInviteSend({ ...base, apply: true, onProgress: progress });
    expect(order).toEqual(["stamp id-2", "send c2@example.com", "stamp id-3", "send c3@example.com"]);
    expect(res.tally).toMatchObject({ total: 2, attempted: 2, sent: 2 });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("a row whose stamp is refused is skipped, never sent, and still counted", async () => {
    m.stampInvite.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await runInviteSend({ ...base, apply: true });
    expect(m.sgSend).toHaveBeenCalledTimes(1);
    expect(res.tally).toMatchObject({ attempted: 2, changed: 1, sent: 1 });
  });

  it("preselected sends exactly that list without reselecting", async () => {
    const res = await runInviteSend({ ...base, apply: true, preselected: [row(9)] });
    expect(m.eligibleRows).not.toHaveBeenCalled();
    expect(m.reconcileLinks).not.toHaveBeenCalled();
    expect(m.sgSend).toHaveBeenCalledTimes(1);
    expect(m.sgSend.mock.calls[0][0]).toBe("c9@example.com");
    expect(res.tally.sent).toBe(1);
  });

  it("a 4xx rejection is marked send_failed; a 5xx is recorded ambiguous and stops the run", async () => {
    const rejected = Object.assign(new Error("bad request"), { code: 400, response: {} });
    const unknown = Object.assign(new Error("server error"), { code: 500, response: {} });
    m.eligibleRows.mockResolvedValue({ candidates: [row(2), row(3), row(4)], skipped: [] });
    m.sgSend.mockRejectedValueOnce(rejected).mockRejectedValueOnce(unknown);
    const res = await runInviteSend({ ...base, apply: true });
    expect(m.markSendFailed).toHaveBeenCalledWith("id-2", expect.any(String));
    expect(m.recordSendAmbiguous).toHaveBeenCalledWith("id-3", expect.any(String));
    expect(m.stampInvite).toHaveBeenCalledTimes(2);
    expect(res.stoppedReason).toMatch(/every row/);
    expect(res.tally).toMatchObject({ attempted: 2, rejected: 1, unknown: 1, sent: 0 });
  });

  it("apply with a missing setting throws before any row is stamped", async () => {
    await expect(runInviteSend({ ...base, apply: true, env: { ...env, SYSTEM_SENDGRID_API_KEY: "" } })).rejects.toThrow(
      /SYSTEM_SENDGRID_API_KEY/,
    );
    expect(m.stampInvite).not.toHaveBeenCalled();
  });

  it("the email links carry the unsubscribe token and the public bases", async () => {
    await runInviteSend({ ...base, apply: true, preselected: [row(5)] });
    const [, , html, , sender, extra] = m.sgSend.mock.calls[0];
    expect(html).toContain("https://www.zaviagent.com/creators/apply?src=invite&amp;invite=sig-5");
    expect(extra.headers["List-Unsubscribe"]).toBe("<https://api.zaviagent.com/api/creators/invite/unsubscribe?t=tok-5>");
    expect(extra.customArgs).toEqual({ creator_invite_id: "id-5" });
    expect(sender).toEqual({ email: "support@zaviagent.com", name: "Zavi" });
  });
});
