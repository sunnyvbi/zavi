import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  sgSend: vi.fn(async (..._a: unknown[]) => undefined),
  owner: "owner-1" as string | null,
}));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: m.sgSend }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: m.owner ? { user_id: m.owner } : null, error: null }),
      };
      return q;
    },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@acme.test` } } }) } },
  }),
}));

import {
  renderChooseDestinationEmail,
  renderRecapPostFailedEmail,
  sendChooseDestinationEmail,
  sendRecapPostFailedEmail,
} from "../summary-email";

beforeEach(() => {
  m.sgSend.mockClear();
  m.owner = "owner-1";
  process.env.SYSTEM_SENDGRID_API_KEY = "test";
});

describe("the emails sent instead of meeting content", () => {
  it("the choose-where email links to the Meet tab and carries no meeting content", () => {
    const e = renderChooseDestinationEmail("https://www.zaviagent.com/workspace?tab=meet&company=t1");
    expect(e.subject).toBe("Choose where Zavi shares your meeting notes");
    expect(e.text).toContain("Until you choose, Zavi doesn't post or email them.");
    expect(e.text).toContain("https://www.zaviagent.com/workspace?tab=meet&company=t1");
    expect(e.html).toContain("Choose where they go");
    expect(e.html).toContain("tab=meet");
  });

  it("the couldn't-post email names the channel and says the notes are in Zavi", () => {
    const e = renderRecapPostFailedEmail("standups", "https://x.test/workspace?tab=meet");
    expect(e.subject).toBe("Zavi couldn't post meeting notes to #standups");
    expect(e.text).toContain("They're saved in Zavi.");
    expect(e.text).toContain("Make sure @Zavi is in #standups");
    expect(renderRecapPostFailedEmail(null, "u").subject).toBe("Zavi couldn't post meeting notes to your Slack channel");
  });

  it("both go to the owner only, with the tenant's own Meet link", async () => {
    await sendChooseDestinationEmail("t1");
    await sendRecapPostFailedEmail("t1", "standups");
    expect(m.sgSend).toHaveBeenCalledTimes(2);
    expect(m.sgSend.mock.calls.map((c) => c[0])).toEqual(["owner-1@acme.test", "owner-1@acme.test"]);
    expect(String(m.sgSend.mock.calls[0][3])).toContain("/workspace?tab=meet&company=t1");
  });

  it("no owner: nothing is sent", async () => {
    m.owner = null;
    expect(await sendChooseDestinationEmail("t1")).toEqual({ sent: 0, reason: "no_recipients" });
    expect(m.sgSend).not.toHaveBeenCalled();
  });
});
