
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  telegram: vi.fn(async () => ({ ok: true })),
  discord: vi.fn(async () => ({ ok: true })),
  whatsapp: vi.fn(async () => ({ ok: true, chunks: 1 })),
  imessage: vi.fn(async (_a: unknown) => ({ ok: true, chunks: 1 })),
  binding: { window_expires_at: "2099-01-01T00:00:00Z" } as { window_expires_at: string | null } | null,
  filters: [] as Array<[string, unknown]>,
}));

vi.mock("@/services/tools/telegram/_client", () => ({ postTelegramReply: m.telegram }));
vi.mock("@/services/tools/discord/_client", () => ({ postDiscordReply: m.discord }));
vi.mock("@/services/tools/whatsapp/_client", () => ({ postWhatsAppReply: m.whatsapp }));
vi.mock("@/services/tools/imessage/_client", () => ({ postIMessageReply: m.imessage }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        m.filters.push([col, val]);
        return b;
      };
      b.maybeSingle = async () => ({ data: m.binding, error: null });
      return b;
    },
  }),
}));

import { notifyChatApprovalPending } from "@/services/connectors/chat-approval-notify";
import { APPROVAL_PENDING_TEXT, approvalPendingText } from "@/services/connectors/chat-copy";

const WA = {
  whatsapp: { phone_number_id: "PN1", wa_id: "16690000000", message_id: "wamid.1", text: "hi" },
};

beforeEach(() => {
  m.telegram.mockClear();
  m.discord.mockClear();
  m.whatsapp.mockClear();
  m.imessage.mockClear();
  m.filters.length = 0;
  m.binding = { window_expires_at: "2099-01-01T00:00:00Z" };
});

describe("whatsapp", () => {
  it("posts the notice to the thread with the LIVE window deadline, scoped to the run's tenant", async () => {
    const r = await notifyChatApprovalPending({ trigger: "whatsapp", payload: WA, tenant_id: "t-1" });
    expect(r).toEqual({ posted: true });
    expect(m.whatsapp).toHaveBeenCalledWith({
      wa_id: "16690000000",
      text: approvalPendingText("t-1"),
      windowExpiresAt: "2099-01-01T00:00:00Z",
    });
    expect(m.filters).toEqual(
      expect.arrayContaining([
        ["phone_number_id", "PN1"],
        ["wa_id", "16690000000"],
        ["tenant_id", "t-1"],
        ["status", "enabled"],
      ]),
    );
  });

  it("sends nothing when the thread is no longer this tenant's enabled binding", async () => {
    m.binding = null;
    const r = await notifyChatApprovalPending({ trigger: "whatsapp", payload: WA, tenant_id: "t-1" });
    expect(r).toEqual({ posted: false });
    expect(m.whatsapp).not.toHaveBeenCalled();
  });

  it("sends nothing without a tenant (cannot re-validate) or without routing", async () => {
    expect(await notifyChatApprovalPending({ trigger: "whatsapp", payload: WA })).toEqual({ posted: false });
    expect(
      await notifyChatApprovalPending({ trigger: "whatsapp", payload: { whatsapp: {} }, tenant_id: "t-1" }),
    ).toEqual({ posted: false });
    expect(m.whatsapp).not.toHaveBeenCalled();
  });

  it("never throws — a failing send reads as not posted", async () => {
    m.whatsapp.mockRejectedValueOnce(new Error("boom"));
    await expect(
      notifyChatApprovalPending({ trigger: "whatsapp", payload: WA, tenant_id: "t-1" }),
    ).resolves.toEqual({ posted: false });
  });
});

describe("imessage", () => {
  const IM = { imessage: { line: "+13475550100", handle: "+14155550123", message_handle: "mh-1", text: "hi" } };
  const KEYS = ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      SENDBLUE_API_KEY_ID: "kid",
      SENDBLUE_API_SECRET: "secret",
      SENDBLUE_FROM_NUMBER: "+13475550100",
      SENDBLUE_WEBHOOK_SECRET: "hook",
    });
    return () => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    };
  });

  it("texts the notice to the person, after re-checking this tenant's enabled thread", async () => {
    expect(await notifyChatApprovalPending({ trigger: "imessage", payload: IM, tenant_id: "t-1" })).toEqual({ posted: true });
    expect(m.imessage).toHaveBeenCalledWith({ handle: "+14155550123", text: approvalPendingText("t-1") });
    expect(m.filters).toEqual(
      expect.arrayContaining([
        ["tenant_id", "t-1"],
        ["line", "+13475550100"],
        ["handle", "+14155550123"],
        ["status", "enabled"],
      ]),
    );
  });

  it("sends nothing when the thread was removed, or when this host does not send from that line", async () => {
    m.binding = null;
    expect(await notifyChatApprovalPending({ trigger: "imessage", payload: IM, tenant_id: "t-1" })).toEqual({ posted: false });
    m.binding = { window_expires_at: null };
    process.env.SENDBLUE_FROM_NUMBER = "+13475559999";
    expect(await notifyChatApprovalPending({ trigger: "imessage", payload: IM, tenant_id: "t-1" })).toEqual({ posted: false });
    expect(m.imessage).not.toHaveBeenCalled();
  });
});

describe("other surfaces (unchanged)", () => {
  it("telegram replies to the triggering message", async () => {
    const r = await notifyChatApprovalPending({
      trigger: "telegram",
      payload: { telegram: { chat_id: 42, message_id: 7 } },
    });
    expect(r).toEqual({ posted: true });
    expect(m.telegram).toHaveBeenCalledWith({ chat_id: 42, reply_to_message_id: 7, text: APPROVAL_PENDING_TEXT });
  });

  it("the link opens Needs you (it forwards a card to where it lives) for the run's own company", () => {
    expect(approvalPendingText("t 1")).toContain("https://www.zaviagent.com/workspace?tab=needs-you&company=t%201 ");
    expect(APPROVAL_PENDING_TEXT).toContain("https://www.zaviagent.com/workspace?tab=needs-you ");
    expect(APPROVAL_PENDING_TEXT).not.toContain("tab=approvals");
  });

  it("unknown trigger posts nothing", async () => {
    expect(await notifyChatApprovalPending({ trigger: "slack", payload: {} })).toEqual({ posted: false });
  });
});
