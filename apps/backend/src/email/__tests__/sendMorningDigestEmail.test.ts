
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MorningBriefResponse } from "../../services/workspace/morning-brief-assembler";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setApiKey: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("@sendgrid/mail", () => ({
  default: { send: mocks.send, setApiKey: mocks.setApiKey },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    auth: { admin: { getUserById: mocks.getUserById } },
  }),
}));

import { sendMorningDigestEmail } from "../sendAuthEmail";

const BRIEF: MorningBriefResponse = {
  yesterday: { builds_started: 1, builds_done: 1, builds_failed: 0, spend_usd: 2, pr_count: null },
  today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 1 },
  goals: [],
  recent_activity: [],
};

const ARGS = {
  owner_user_id: "user-123",
  tenant_id: "tenant-abc",
  brief: BRIEF,
  workspaceUrl: "https://www.zaviagent.com/workspace",
  approvalsUrl: "https://www.zaviagent.com/workspace",
  displayName: "Acme",
};

const ORIG_KEY = process.env.SYSTEM_SENDGRID_API_KEY;
const ORIG_FROM = process.env.ZAVI_EMAIL_FROM;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
  process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";
  mocks.send.mockResolvedValue([{ statusCode: 202 }]);
  mocks.getUserById.mockResolvedValue({
    data: { user: { email: "owner@acme.com" } },
    error: null,
  });
});

afterEach(() => {
  process.env.SYSTEM_SENDGRID_API_KEY = ORIG_KEY;
  process.env.ZAVI_EMAIL_FROM = ORIG_FROM;
});

describe("sendMorningDigestEmail", () => {
  it("resolves the recipient from owner_user_id and sends → {sent:true}", async () => {
    const r = await sendMorningDigestEmail(ARGS);
    expect(r).toEqual({ sent: true });
    expect(mocks.getUserById).toHaveBeenCalledWith("user-123");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.to).toBe("owner@acme.com");
    expect(payload.subject).toBeTruthy();
    expect(payload.html).toContain("What your AI team did");
  });

  it("returns {sent:false, reason:'no_system_key'} when the key is missing (never throws)", async () => {
    delete process.env.SYSTEM_SENDGRID_API_KEY;
    const r = await sendMorningDigestEmail(ARGS);
    expect(r).toEqual({ sent: false, reason: "no_system_key" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it("returns {sent:false, reason:'no_email'} when the owner has no email on file", async () => {
    mocks.getUserById.mockResolvedValue({ data: { user: { email: null } }, error: null });
    const r = await sendMorningDigestEmail(ARGS);
    expect(r).toEqual({ sent: false, reason: "no_email" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("throws on a real SendGrid send failure (key present) so the caller's catch logs it", async () => {
    mocks.send.mockRejectedValue(new Error("sendgrid 500"));
    await expect(sendMorningDigestEmail(ARGS)).rejects.toThrow("sendgrid 500");
  });
});
