import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  tenant: { data: { display_name: "Acme Rentals" } as unknown, error: null as { message: string } | null, throws: false },
  user: {
    data: { user: { email: "priya@acmerentals.com", user_metadata: { full_name: "Priya Shah" } } } as unknown,
    error: null as { message: string } | null,
    throws: false,
  },
  sent: [] as Array<{ to: string; subject: string; html: string; text: string }>,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (state.tenant.throws) throw new Error("tenants read timed out");
          return { data: state.tenant.data, error: state.tenant.error };
        },
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: async () => {
          if (state.user.throws) throw new Error("auth admin down");
          return { data: state.user.data, error: state.user.error };
        },
      },
    },
  }),
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn(async (m: { to: string; subject: string; html: string; text: string }) => {
      state.sent.push(m);
    }),
  },
}));

import { resolveInviteSender, sendWorkspaceInviteEmail, sgSend } from "../sendAuthEmail";

const T = "00000000-0000-0000-0000-000000000001";
const U = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  state.tenant = { data: { display_name: "Acme Rentals" }, error: null, throws: false };
  state.user = {
    data: { user: { email: "priya@acmerentals.com", user_metadata: { full_name: "Priya Shah" } } },
    error: null,
    throws: false,
  };
  state.sent = [];
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
});

describe("resolveInviteSender", () => {
  it("the workspace name and the inviter's display name, with their email beside it", async () => {
    expect(await resolveInviteSender(T, U)).toEqual({
      tenantName: "Acme Rentals",
      inviterLabel: "Priya Shah",
      inviterEmail: "priya@acmerentals.com",
    });
  });

  it("no display name: the inviter's email is the label (and not repeated)", async () => {
    state.user.data = { user: { email: "priya@acmerentals.com", user_metadata: {} } };
    expect(await resolveInviteSender(T, U)).toMatchObject({ inviterLabel: "priya@acmerentals.com", inviterEmail: null });
  });

  it("nothing readable: 'A workspace admin' and no company, and it never throws", async () => {
    state.user.throws = true;
    state.tenant.throws = true;
    expect(await resolveInviteSender(T, U)).toEqual({
      tenantName: null,
      inviterLabel: "A workspace admin",
      inviterEmail: null,
    });
    state.user = { data: null, error: { message: "user not found" }, throws: false };
    state.tenant = { data: null, error: { message: "boom" }, throws: false };
    expect(await resolveInviteSender(T, null)).toEqual({
      tenantName: null,
      inviterLabel: "A workspace admin",
      inviterEmail: null,
    });
  });
});

describe("sendWorkspaceInviteEmail", () => {
  it("sends the named invite to the invitee", async () => {
    await sendWorkspaceInviteEmail({
      to: "sam@example.com",
      acceptUrl: "https://www.zaviagent.com/invite/accept?id=abc&deeplink=invite",
      ...(await resolveInviteSender(T, U)),
    });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toBe("sam@example.com");
    expect(state.sent[0].subject).toBe("Priya Shah invited you to Acme Rentals on Zavi");
  });
});

describe("sgSend: the shared send boundary", () => {
  it("never puts a line break or control character into a subject, whatever built it", async () => {
    await sgSend("a@b.c", "Hello\r\nBcc: victim@example.com\t\u0000 there", "<p>x</p>", "x");
    expect(state.sent[0].subject).toBe("Hello Bcc: victim@example.com there");
  });

  it("also removes C1 controls such as NEL (U+0085)", async () => {
    await sgSend("a@b.c", "Hello\u0085Bcc: x@y.z\u009b", "<p>x</p>", "x");
    expect(state.sent[0].subject).toBe("Hello Bcc: x@y.z");
  });
});
