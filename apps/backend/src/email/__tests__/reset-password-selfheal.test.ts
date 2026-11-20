import { describe, it, expect, vi, beforeEach } from "vitest";

const APEX = "https://zaviagent.com";
const SITE = "https://www.zaviagent.com";
const NEXT = encodeURIComponent("/reset-password");

const state = {
  links: [] as string[],
  errors: [] as Array<{ message: string } | null>,
  hashed: [] as Array<string | undefined>,
  calls: [] as Array<{ type: string; redirectTo: string }>,
  sent: [] as Array<{ html: string; subject: string }>,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    auth: {
      admin: {
        generateLink: vi.fn(async (opts: { type: string; options: { redirectTo: string } }) => {
          state.calls.push({ type: opts.type, redirectTo: opts.options.redirectTo });
          const err = state.errors.shift();
          if (err) return { data: null, error: err };
          const action_link = state.links.shift() ?? "";
          return { data: { properties: { action_link, hashed_token: state.hashed.shift() } }, error: null };
        }),
      },
    },
  }),
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn(async (msg: { html: string; subject: string }) => {
      state.sent.push({ html: msg.html, subject: msg.subject });
    }),
  },
}));

function actionLink(rt: string, token = "tok"): string {
  return `https://wmycgyjsenvgtczlupoe.supabase.co/auth/v1/verify?token=${token}&type=recovery&redirect_to=${encodeURIComponent(
    rt,
  )}`;
}

beforeEach(() => {
  state.links = [];
  state.errors = [];
  state.hashed = [];
  state.calls = [];
  state.sent = [];
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
  process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";
  process.env.WEB_BASE_URL = SITE;
  vi.resetModules();
});

describe("sendResetPasswordEmail — redirect self-heal + enumeration safety", () => {
  it("re-mints on the Site URL host when Supabase downgrades the apex redirect", async () => {
    const wanted = `${APEX}/auth/callback?next=${NEXT}`;
    state.links = [
      actionLink(SITE, "stripped"),
      actionLink(`${SITE}/auth/callback?next=${NEXT}`, "healed"),
    ];

    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    await sendResetPasswordEmail("user@example.com", wanted);

    expect(state.calls).toHaveLength(2);
    expect(state.calls[0].type).toBe("recovery");
    expect(state.calls[0].redirectTo).toBe(wanted);
    expect(state.calls[1].redirectTo).toBe(`${SITE}/auth/callback?next=${NEXT}`);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].html).toContain("token=healed");
    expect(state.sent[0].html).not.toContain("token=stripped");
  });

  it("does NOT re-mint when the redirect is preserved on the first try", async () => {
    const wanted = `${SITE}/auth/callback?next=${NEXT}`;
    state.links = [actionLink(wanted)];
    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    await sendResetPasswordEmail("user@example.com", wanted);
    expect(state.calls).toHaveLength(1);
    expect(state.sent).toHaveLength(1);
  });

  it("user_not_found is swallowed (enumeration-safe): returns without sending", async () => {
    state.errors = [{ message: "User not found" }];
    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    const out = await sendResetPasswordEmail("ghost@example.com", `${SITE}/auth/callback?next=${NEXT}`);
    expect(out).toEqual({ sent: true });
    expect(state.sent).toHaveLength(0);
  });

  it("a real (non-user-not-found) generateLink error throws", async () => {
    state.errors = [{ message: "rate limit exceeded" }];
    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    await expect(
      sendResetPasswordEmail("user@example.com", `${SITE}/auth/callback?next=${NEXT}`),
    ).rejects.toThrow(/rate limit/);
    expect(state.sent).toHaveLength(0);
  });

  it("links straight to /auth/reset with the token when Supabase returns one", async () => {
    const wanted = `${SITE}/auth/callback?next=${NEXT}`;
    state.links = [actionLink(wanted)];
    state.hashed = ["hash-123"];
    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    await sendResetPasswordEmail("user@example.com", wanted);
    expect(state.calls).toHaveLength(1);
    const html = state.sent[0].html.replace(/&amp;/g, "&");
    expect(html).toContain(
      `${SITE}/auth/reset?next=%2Freset-password&token_hash=hash-123&type=recovery&deeplink=reset`,
    );
    expect(html).not.toContain("supabase.co/auth/v1/verify");
  });

  it("builds the direct link on our web origin, never on a tenant subdomain from redirectTo", async () => {
    const wanted = `https://attacker-site.zaviagent.com/auth/callback?next=${NEXT}`;
    state.links = [actionLink(SITE)];
    state.hashed = ["hash-456"];
    const { sendResetPasswordEmail } = await import("../sendAuthEmail");
    await sendResetPasswordEmail("victim@example.com", wanted);
    const html = state.sent[0].html.replace(/&amp;/g, "&");
    expect(html).toContain(`${SITE}/auth/reset?next=%2Freset-password&token_hash=hash-456`);
    expect(html).not.toContain("attacker-site");
  });
});
