// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/"}

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthCb = (event: string, session: { user: { id: string; email: string } } | null) => void;

const h = vi.hoisted(() => ({
  identify: vi.fn(),
  reset: vi.fn(),
  loaded: false,
  authCb: null as AuthCb | null,
  consent: true,
  user: null as { id: string; email: string } | null,
  distinctId: "anon",
  userState: "anonymous",
  verify: null as null | ((u: { id: string; email: string } | null) => void),
  optedIn: true,
  opts: null as null | { before_send?: (e: unknown) => unknown },
}));

vi.mock("posthog-js", () => {
  const ph = {
    get __loaded() {
      return h.loaded;
    },
    init: (_key: string, opts: { loaded: (p: unknown) => void; before_send?: (e: unknown) => unknown }) => {
      h.opts = opts;
      h.loaded = true;
      opts.loaded({ has_opted_in_capturing: () => true, opt_in_capturing: vi.fn() });
    },
    identify: (id: string, props: unknown) => {
      h.identify(id, props);
      h.distinctId = id;
      h.userState = "identified";
    },
    reset: () => {
      h.reset();
      h.distinctId = "anon";
      h.userState = "anonymous";
      h.optedIn = false;
    },
    has_opted_in_capturing: () => h.optedIn,
    opt_in_capturing: () => {
      h.optedIn = true;
    },
    get_distinct_id: () => h.distinctId,
    get_property: (k: string) => (k === "$user_state" ? h.userState : undefined),
    capture: vi.fn(),
    set_config: vi.fn(),
    opt_out_capturing: vi.fn(),
    stopSessionRecording: vi.fn(),
  };
  return { default: ph };
});

vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePostHog: () => null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => null,
}));

vi.mock("@/lib/consent", () => ({
  hasAnalyticsConsent: () => h.consent,
  allowsAnalytics: () => h.consent,
  subscribe: () => () => {},
}));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        h.authCb = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));

vi.mock("@/lib/verifiedUser", () => ({
  getVerifiedUser: () =>
    h.verify === null
      ? Promise.resolve(h.user)
      : new Promise((resolve) => {
          h.verify = resolve;
        }),
}));

import { PostHogProvider, maskReplayAttribute, maskReplayInput, maskReplayText } from "./PostHogProvider";

describe("PostHogProvider identity", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    h.identify.mockReset();
    h.reset.mockReset();
    h.loaded = false;
    h.authCb = null;
    h.consent = true;
    h.user = null;
    h.distinctId = "anon";
    h.userState = "anonymous";
    h.verify = null;
    h.optedIn = true;
  });

  it("identifies an already signed-in user on load", async () => {
    h.user = { id: "u1", email: "a@b.co" };
    render(<PostHogProvider>x</PostHogProvider>);
    await waitFor(() => expect(h.identify).toHaveBeenCalledWith("u1", { email: "a@b.co" }));
  });

  it("identifies on sign-in and resets on sign-out", async () => {
    render(<PostHogProvider>x</PostHogProvider>);
    await waitFor(() => expect(h.authCb).not.toBeNull());
    h.authCb!("SIGNED_IN", { user: { id: "u2", email: "c@d.co" } });
    expect(h.identify).toHaveBeenCalledWith("u2", { email: "c@d.co" });
    h.authCb!("SIGNED_OUT", null);
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect(h.optedIn).toBe(true);
  });

  it("does nothing without analytics consent", async () => {
    h.consent = false;
    h.user = { id: "u3", email: "e@f.co" };
    render(<PostHogProvider>x</PostHogProvider>);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.authCb).toBeNull();
    expect(h.identify).not.toHaveBeenCalled();
  });

  it("resets before identifying a different user without a sign-out between", async () => {
    render(<PostHogProvider>x</PostHogProvider>);
    await waitFor(() => expect(h.authCb).not.toBeNull());
    h.authCb!("SIGNED_IN", { user: { id: "staff", email: "s@z.co" } });
    expect(h.reset).not.toHaveBeenCalled();
    h.authCb!("SIGNED_IN", { user: { id: "customer", email: "c@z.co" } });
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect(h.identify).toHaveBeenLastCalledWith("customer", { email: "c@z.co" });
    expect(h.optedIn).toBe(true);
  });

  it("a slow first lookup does not re-identify someone who signed out meanwhile", async () => {
    h.verify = () => {};
    render(<PostHogProvider>x</PostHogProvider>);
    await waitFor(() => expect(h.authCb).not.toBeNull());
    const resolveLookup = h.verify!;
    h.authCb!("SIGNED_OUT", null);
    resolveLookup({ id: "gone", email: "g@z.co" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.identify).not.toHaveBeenCalled();
  });
});

describe("plan-ready attribution survives PostHog scrubbing", () => {
  it("keeps campaign URL tags and SDK campaign properties while removing the company id", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    h.consent = true;
    h.loaded = false;
    h.opts = null;
    render(<PostHogProvider><div /></PostHogProvider>);
    await waitFor(() => expect(h.opts?.before_send).toBeTypeOf("function"));
    const out = h.opts!.before_send!({
      event: "$pageview",
      properties: {
        $current_url: "https://www.zaviagent.com/workspace?tab=growth-strategy&company=t1&utm_source=email&utm_medium=zavi&utm_campaign=plan_ready",
        page_group: "app", utm_source: "email", utm_medium: "zavi", utm_campaign: "plan_ready",
      },
    });
    expect(out).toMatchObject({
      event: "$pageview",
      properties: {
        $current_url: "https://www.zaviagent.com/workspace?utm_source=email&utm_medium=zavi&utm_campaign=plan_ready",
        page_group: "app", utm_source: "email", utm_medium: "zavi", utm_campaign: "plan_ready",
      },
    });
  });
});

describe("PostHog never receives secrets from the address bar", () => {
  it("before_send keeps only the path and campaign tags of every URL property", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    h.consent = true;
    h.loaded = false;
    render(
      <PostHogProvider>
        <div />
      </PostHogProvider>,
    );
    await waitFor(() => expect(h.opts?.before_send).toBeTypeOf("function"));
    const out = h.opts!.before_send!({
      event: "signup_completed",
      properties: {
        $current_url: "https://www.zaviagent.com/invite/beta?key=s3cret&utm_source=x",
        method: "email",
      },
      $set_once: { $initial_current_url: "https://www.zaviagent.com/auth/callback?code=abc" },
    });
    expect(out).toEqual({
      event: "signup_completed",
      properties: { $current_url: "https://www.zaviagent.com/invite/beta?utm_source=x", method: "email" },
      $set: undefined,
      $set_once: { $initial_current_url: "https://www.zaviagent.com/auth" },
    });
  });
});

describe("session replay hides passwords, secrets and emails, and shows the rest", () => {
  const html = (markup: string) => {
    const host = document.createElement("div");
    host.innerHTML = markup;
    return host.firstElementChild as HTMLElement;
  };

  it("shows page text but hides every email address in it", () => {
    const p = html("<p>Signed in</p>");
    expect(maskReplayText("Revenue up 12% this week", p)).toBe("Revenue up 12% this week");
    expect(maskReplayText("Invite sent to ravi@upcar.ai today", p)).toBe("Invite sent to ************* today");
    expect(maskReplayText("Ping @channel about it", p)).toBe("Ping @channel about it");
  });

  it("hides all text inside an area marked for masking", () => {
    const area = html('<div data-replay-mask=""><code>sk_live_123</code></div>');
    expect(maskReplayText("sk_live_123", area.querySelector("code") as HTMLElement)).toBe("***********");
    expect(maskReplayText("secret", html('<span class="ph-mask">x</span>'))).toBe("******");
  });

  it("hides passwords, login codes, email fields and secret fields, even when shown as plain text", () => {
    for (const markup of [
      '<input type="password">',
      '<input type="text" autocomplete="current-password">',
      '<input type="text" autocomplete="one-time-code">',
      '<input type="email">',
      '<input type="text" data-replay-mask="">',
    ]) {
      expect(maskReplayInput("hunter22", html(markup))).toBe("********");
    }
  });

  it("shows other typed text unless it holds an email address", () => {
    const input = html('<input type="text">');
    expect(maskReplayInput("Grow signups in Austin", input)).toBe("Grow signups in Austin");
    expect(maskReplayInput("ravi@up", input)).toBe("*******");
  });

  it("hides tokens in links, key-shaped values and private keys wherever they appear", () => {
    const p = html("<p>x</p>");
    expect(maskReplayText("Your token zavi_pat_AbC123xyz789 is ready", p)).toBe("Your token ********************* is ready");
    expect(maskReplayText("Use sk_live_51Habcdefgh now", p)).toBe("Use ******************* now");
    expect(maskReplayText("docker run -e PAIR=zpair_0123456789ABCDEFGHJKMNPQRS x", p)).not.toContain("zpair_");
    expect(maskReplayText("Mail sales/ops@example.com", p)).toBe("Mail " + "*".repeat("sales/ops@example.com".length));
    const textarea = html("<textarea></textarea>");
    expect(maskReplayInput("-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----", textarea)).not.toContain("MIGT");
    expect(maskReplayInput("https://site.example/join?invite=abc123", html('<input type="text">'))).not.toContain("abc123");
    const a = html("<a></a>");
    expect(maskReplayAttribute("href", "https://x.supabase.co/obj/sign/f.pdf?token=eyJabc&download=1", a)).toBe(
      "https://x.supabase.co/obj/sign/f.pdf?token=******&download=1",
    );
    expect(maskReplayAttribute("href", "https://admin.shopify.com/apps/zavi?zavi_confirmation=signed-choice&embedded=1", a)).toBe(
      "https://admin.shopify.com/apps/zavi?zavi_confirmation=*************&embedded=1",
    );
    expect(maskReplayAttribute("href", "https://t.me/zavibot?startgroup=abc123", a)).toBe("https://t.me/zavibot?startgroup=******");
    expect(maskReplayAttribute("href", "https://wa.me/15550100?text=connect%20abc123", a)).not.toContain("abc123");
    expect(maskReplayAttribute("href", "/workspace?tab=settings", a)).toBe("/workspace?tab=settings");
  });

  it("hides emails and secret values in attributes and keeps the rest so the replay renders", () => {
    const div = html("<div></div>");
    expect(maskReplayAttribute("title", "Owner: a@b.co", div)).toBe("Owner: ******");
    expect(maskReplayAttribute("href", "mailto:a@b.co", html("<a></a>"))).toBe("mailto:******");
    expect(maskReplayAttribute("aria-label", "Open settings", div)).toBe("Open settings");
    expect(maskReplayAttribute("value", "hunter22", html('<input type="password">'))).toBe("********");
    expect(maskReplayAttribute("title", "sk_live_123", html('<div data-replay-mask=""></div>'))).toBe("***********");
    expect(maskReplayAttribute("class", "flex gap-2", div)).toBe("flex gap-2");
    expect(maskReplayAttribute("href", "/_next/app.css", html("<link>"))).toBe("/_next/app.css");
  });
});
