import { describe, it, expect, vi, beforeEach } from "vitest";

type AdminErr = { message: string; code?: string; status?: number } | null;

const state = {
  createUserError: null as AdminErr,
  emailOtp: "12345678" as string | null,
  generateLinkError: null as AdminErr,
  createUserCalls: [] as Array<{ email: string }>,
  generateLinkCalls: [] as Array<{ type: string }>,
  sent: [] as Array<{ to: string; subject: string; html: string }>,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    auth: {
      admin: {
        createUser: vi.fn(async (opts: { email: string }) => {
          state.createUserCalls.push({ email: opts.email });
          if (state.createUserError) return { data: { user: null }, error: state.createUserError };
          return { data: { user: { id: "u_new" } }, error: null };
        }),
        generateLink: vi.fn(async (opts: { type: string }) => {
          state.generateLinkCalls.push({ type: opts.type });
          if (state.generateLinkError) return { data: null, error: state.generateLinkError };
          return { data: { properties: { email_otp: state.emailOtp } }, error: null };
        }),
      },
    },
  }),
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn(async (msg: { to: string; subject: string; html: string }) => {
      state.sent.push({ to: msg.to, subject: msg.subject, html: msg.html });
    }),
  },
}));

beforeEach(() => {
  state.createUserError = null;
  state.emailOtp = "12345678";
  state.generateLinkError = null;
  state.createUserCalls = [];
  state.generateLinkCalls = [];
  state.sent = [];
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
  process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";
  vi.resetModules();
});

describe("sendOtpEmail — duplicate-user swallow by code/status", () => {
  it("REGRESSION: existing user (status 422, code email_exists) still gets an OTP", async () => {
    state.createUserError = {
      message: "A user with this email address has already been registered",
      code: "email_exists",
      status: 422,
    };

    const { sendOtpEmail } = await import("../sendAuthEmail");
    const out = await sendOtpEmail("returning@example.com");

    expect(out).toEqual({ sent: true });
    expect(state.generateLinkCalls).toHaveLength(1);
    expect(state.generateLinkCalls[0].type).toBe("magiclink");
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toBe("returning@example.com");
  });

  it("code-absent fallback: 422 whose MESSAGE confirms a duplicate is swallowed", async () => {
    state.createUserError = {
      message: "A user with this email address has already been registered",
      status: 422,
    };
    const { sendOtpEmail } = await import("../sendAuthEmail");
    const out = await sendOtpEmail("returning2@example.com");
    expect(out).toEqual({ sent: true });
    expect(state.sent).toHaveLength(1);
  });

  it("a NON-duplicate 422 (different code) THROWS — not swallowed", async () => {
    state.createUserError = {
      message: "Password should be at least 6 characters",
      code: "weak_password",
      status: 422,
    };
    const { sendOtpEmail } = await import("../sendAuthEmail");
    await expect(sendOtpEmail("user@example.com")).rejects.toThrow(/createUser failed/);
    expect(state.generateLinkCalls).toHaveLength(0);
    expect(state.sent).toHaveLength(0);
  });

  it("a bare 422 (no code, non-duplicate message) THROWS — not swallowed", async () => {
    state.createUserError = {
      message: "Signups not allowed for this instance",
      status: 422,
    };
    const { sendOtpEmail } = await import("../sendAuthEmail");
    await expect(sendOtpEmail("user@example.com")).rejects.toThrow(/createUser failed/);
    expect(state.sent).toHaveLength(0);
  });

  it("brand-new user (no createUser error) gets an OTP — no signup regression", async () => {
    state.createUserError = null;
    const { sendOtpEmail } = await import("../sendAuthEmail");
    const out = await sendOtpEmail("brandnew@example.com");
    expect(out).toEqual({ sent: true });
    expect(state.createUserCalls).toHaveLength(1);
    expect(state.sent).toHaveLength(1);
  });

  it("a real (non-duplicate) createUser error THROWS — not swallowed", async () => {
    state.createUserError = {
      message: "database connection failed",
      code: "unexpected_failure",
      status: 500,
    };
    const { sendOtpEmail } = await import("../sendAuthEmail");
    await expect(sendOtpEmail("user@example.com")).rejects.toThrow(/createUser failed/);
    expect(state.generateLinkCalls).toHaveLength(0);
    expect(state.sent).toHaveLength(0);
  });

  it("generateLink returning no email_otp throws (no silent empty send)", async () => {
    state.emailOtp = null;
    const { sendOtpEmail } = await import("../sendAuthEmail");
    await expect(sendOtpEmail("user@example.com")).rejects.toThrow(/no email_otp/);
    expect(state.sent).toHaveLength(0);
  });
});

it('reports only a newly created OTP identity and keeps email delivery independent of location failure',async()=>{
 const {sendOtpEmail}=await import('../sendAuthEmail');
 const capture=vi.fn(async()=>{throw Error('location offline')});
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 await expect(sendOtpEmail('new@example.com',capture)).resolves.toEqual({sent:true});
 expect(capture).toHaveBeenCalledWith('u_new');expect(state.sent).toHaveLength(1);
 state.createUserError={code:'email_exists',status:422,message:'already registered'};
 capture.mockClear();await sendOtpEmail('returning@example.com',capture);expect(capture).not.toHaveBeenCalled();warn.mockRestore();
});
