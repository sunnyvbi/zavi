
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ownerEmail: "owner@example.test" as string | null,
  sent: [] as Array<{ to: string; text: string; html: string }>,
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: () => {},
    send: async (m: { to: string; text: string; html: string }) => {
      h.sent.push(m);
    },
  },
}));
vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => ({ data: { user_id: "u1", created_at: "x" }, error: null });
  return {
    serviceClient: () => ({
      from: () => chain,
      auth: { admin: { getUserById: async () => ({ data: { user: { email: h.ownerEmail } }, error: null }) } },
    }),
  };
});

import { sendBuildLiveEmail } from "../sendAuthEmail";

const base = { tenant_id: "t1", siteName: "Alpha", liveUrl: "https://alpha.zaviagent.com", workspaceUrl: "https://w/workspace" };

describe("sendBuildLiveEmail owner sign-in link", () => {
  beforeEach(() => {
    h.sent = [];
    h.ownerEmail = "owner@example.test";
    process.env.SYSTEM_SENDGRID_API_KEY ??= "test-key";
  });

  it("mints and includes the link when the recipient is the site owner", async () => {
    const mint = vi.fn(async () => "https://ref.supabase.co/verify?token=fresh-owner-link");
    await sendBuildLiveEmail({ ...base, ownerLogin: { email: "Owner@Example.test", mint } });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(h.sent[0].text).toContain("fresh-owner-link");
  });

  it("never mints a link for someone else's inbox", async () => {
    const mint = vi.fn(async () => "https://ref.supabase.co/verify?token=member-link");
    await sendBuildLiveEmail({ ...base, ownerLogin: { email: "member@example.test", mint } });
    expect(mint).not.toHaveBeenCalled();
    expect(h.sent[0].text).not.toContain("member-link");
  });

  it("a failed mint still sends the mail without the line", async () => {
    await sendBuildLiveEmail({ ...base, ownerLogin: { email: "owner@example.test", mint: async () => { throw new Error("x"); } } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).not.toContain("Sign in");
  });
});
