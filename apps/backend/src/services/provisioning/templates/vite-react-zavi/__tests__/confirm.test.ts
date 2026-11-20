import { describe, it, expect } from "vitest";
import { createZavi, sessionStorageKey, type KeyValueStorage } from "../files/src/zavi/client";
import { CONFIRM_MESSAGES, PENDING_KEY, runConfirm } from "../files/src/zavi/confirm";

const ORIGIN = "https://shop.zavi.site";
const SITE = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000;

function token(claims: Record<string, unknown>) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "ES256" })}.${b(claims)}.sig`;
}
function setup() {
  const data = new Map<string, string>();
  const storage: KeyValueStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  const fetches: string[] = [];
  const accounts = new Map<string, string>([["rt-1", "u@x.test"]]);
  const zavi = createZavi({
    fetch: async (url, init) => {
      fetches.push(url);
      if (url.endsWith("/api/auth/refresh")) {
        const rt = (JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")) as { refresh_token?: string }).refresh_token ?? "";
        const email = accounts.get(rt);
        const body = email
          ? { data: { session: { access_token: token({ sub: "00000000-0000-4000-8000-000000000001", site_role: "user", exp: NOW + 3600 }), refresh_token: `${rt}-next`, expires_at: NOW + 3600, expires_in: 3600, token_type: "bearer", email } } }
          : { error: { code: "not_allowed", message: "invalid refresh token" } };
        return { status: email ? 200 : 401, headers: { get: () => null }, text: async () => JSON.stringify(body) };
      }
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { status: "check_email" } }) };
    },
    origin: ORIGIN, siteId: async () => SITE, storage, now: () => NOW * 1000,
  });
  const events: string[] = [];
  const tab = new Map<string, string>();
  let clock = NOW * 1000;
  const pending = { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v), removeItem: (k: string) => void tab.delete(k) };
  const deps = {
    pending, now: () => clock,
    replaceUrl: (u: string) => events.push(`replace:${u}`), navigate: (u: string) => events.push(`navigate:${u}`),
  };
  const startedHere = () => tab.set(PENDING_KEY, String(clock));
  return { zavi, data, fetches, accounts, events, deps, tab, startedHere, advance: (ms: number) => { clock += ms; } };
}
const tokens = (role = "user", type = "magiclink") => new URLSearchParams({
  type,
  access_token: token({ sub: "00000000-0000-4000-8000-000000000001", email: "u@x.test", site_role: role, exp: NOW + 3600 }),
  refresh_token: "rt-1", expires_at: String(NOW + 3600), expires_in: "3600", token_type: "bearer",
}).toString();

describe("/auth/confirm hop 1: the link's token_hash", () => {
  it("wipes the fragment, then navigates to the confirming callback; nothing is fetched or stored", async () => {
    const t = setup();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#type=magiclink&token_hash=pkce_abc123-XYZ.=`, t.deps);
    const url = "/api/auth/callback?type=magiclink&token_hash=pkce_abc123-XYZ.%3D&confirm=1";
    expect(r).toEqual({ kind: "navigate", url });
    expect(t.events).toEqual(["replace:/auth/confirm", `navigate:${url}`]);
    expect(t.fetches).toEqual([]);
    expect(t.data.size).toBe(0);
  });

  it.each([
    ["an unknown type", "type=admin&token_hash=abcdefgh123"],
    ["a token_hash with odd characters", "type=signup&token_hash=abc%26confirm%3D1%26x"],
    ["a too-short token_hash", "type=signup&token_hash=abc"],
    ["no type", "token_hash=abcdefgh123"],
  ])("refuses %s without navigating", async (_n, frag) => {
    const t = setup();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${frag}`, t.deps);
    expect(r).toMatchObject({ kind: "error", code: "invalid_link" });
    expect(t.events).toEqual(["replace:/auth/confirm"]);
  });
});

describe("/auth/confirm hop 2: the session fragment", () => {
  it("stores the broker's session under zavi.auth.v1:<site_id> and wipes the tokens from the URL first", async () => {
    const t = setup();
    t.startedHere();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, t.deps);
    expect(t.events).toEqual(["replace:/auth/confirm"]);
    expect(t.events.join()).not.toContain("rt-1");
    expect(r).toEqual({ kind: "signed_in", type: "magiclink", next: "/" });
    expect(JSON.parse(t.data.get(sessionStorageKey(SITE))!)).toMatchObject({ refresh_token: "rt-1", expires_at: NOW + 3600, expires_in: 3600, token_type: "bearer" });
    expect(t.zavi.auth.user()?.email).toBe("u@x.test");
  });

  it("routes an admin to /admin, a password reset to /account, and a remembered next (once)", async () => {
    let t = setup();
    t.startedHere();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("admin")}`, t.deps)).toMatchObject({ next: "/admin" });
    t = setup();
    t.startedHere();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("admin", "recovery")}`, t.deps)).toMatchObject({ next: "/account?reset=1" });
    t = setup();
    t.startedHere();
    await t.zavi.auth.signInWithMagicLink({ email: "u@x.test", next: "/orders" });
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, t.deps)).toMatchObject({ next: "/orders" });
    expect(t.zavi.auth.takeNext()).toBeNull();
  });

  it("a remembered next that is not a site path is ignored", async () => {
    const t = setup();
    t.data.set(`zavi.next.v1:${SITE}`, "//evil.example");
    t.startedHere();
    await t.zavi.auth.ready();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, t.deps)).toMatchObject({ next: "/" });
  });

  it("an incomplete session fragment stores nothing", async () => {
    const t = setup();
    t.startedHere();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#type=magiclink&access_token=x.y.z`, t.deps);
    expect(r).toMatchObject({ kind: "error", code: "invalid_link" });
    expect(t.data.size).toBe(0);
    expect(t.events).toEqual(["replace:/auth/confirm"]);
  });

  it("a confirmed email change reports it", async () => {
    const t = setup();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#type=email_change&email_changed=1`, t.deps)).toEqual({ kind: "email_changed" });
  });
});

describe("/auth/confirm: hop 2 is bound to this tab's hop 1 (login CSRF)", () => {
  it("a crafted session fragment with no hop 1 in this tab is refused and stores nothing", async () => {
    const t = setup();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("admin")}`, t.deps);
    expect(r).toMatchObject({ kind: "error", code: "invalid_link" });
    expect(t.data.size).toBe(0);
    expect(t.events).toEqual(["replace:/auth/confirm"]);
  });

  it("the full two hops in one tab sign in; the marker is single use and expires", async () => {
    const t = setup();
    await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#type=magiclink&token_hash=abcdefgh123`, t.deps);
    expect(t.tab.get(PENDING_KEY)).toBeDefined();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, t.deps)).toMatchObject({ kind: "signed_in" });
    expect(t.tab.get(PENDING_KEY)).toBeUndefined();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, t.deps)).toMatchObject({ kind: "error" });

    const late = setup();
    await runConfirm(late.zavi, `${ORIGIN}/auth/confirm#type=magiclink&token_hash=abcdefgh123`, late.deps);
    late.advance(11 * 60 * 1000);
    expect(await runConfirm(late.zavi, `${ORIGIN}/auth/confirm#${tokens()}`, late.deps)).toMatchObject({ kind: "error", code: "invalid_link" });
    expect(late.data.size).toBe(0);
  });
});

describe("/auth/confirm: the error fragment", () => {
  it.each(Object.keys(CONFIRM_MESSAGES))("#error=%s shows its own message and wipes the fragment", async (code) => {
    const t = setup();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#error=${code}`, t.deps);
    expect(r).toEqual({ kind: "error", code, message: CONFIRM_MESSAGES[code] });
    expect(t.events).toEqual(["replace:/auth/confirm"]);
  });

  it("an unknown or hostile code falls back to a generic message (never echoed)", async () => {
    const t = setup();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#error=something_new`, t.deps)).toMatchObject({ kind: "error", message: expect.stringMatching(/could not be used/) });
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#error=%3Cscript%3E`, t.deps);
    expect(r).toMatchObject({ code: "invalid_link" });
    expect(JSON.stringify(r)).not.toContain("script");
  });

  it("an empty page (no fragment) is an invalid link and touches nothing", async () => {
    const t = setup();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm`, t.deps)).toMatchObject({ code: "invalid_link" });
    expect(t.events).toEqual([]);
  });
});

describe("/auth/confirm: passwordless sign-up (the broker's confirm POST lands here)", () => {
  it("adopts the session only in the browser that signed up, then sends the user to set a password", async () => {
    const t = setup();
    await t.zavi.auth.signUp("u@x.test");
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps);
    expect(r).toEqual({ kind: "signed_in", type: "signup", next: "/account?welcome=1" });
    expect(t.zavi.auth.session()?.refresh_token).toBe("rt-1-next");
    expect(t.zavi.auth.session()?.email).toBe("u@x.test");
    const again = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps);
    expect(again).toEqual({ kind: "signup_confirmed" });
  });

  it("signs in on a fresh page load: the marker from the sign-up page is read after the client starts (QA R6-1)", async () => {
    const t = setup();
    t.data.set(`zavi.signup.v1:${SITE}`, JSON.stringify({ t: NOW * 1000 - 60_000, email: "u@x.test" }));
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps);
    expect(r).toEqual({ kind: "signed_in", type: "signup", next: "/account?welcome=1" });
    expect(t.zavi.auth.session()?.refresh_token).toBe("rt-1-next");
    expect(t.data.has(`zavi.signup.v1:${SITE}`)).toBe(false);
  });

  it("a sign-up confirm on a site the client cannot resolve shows site_unavailable, not a false sign-in prompt", async () => {
    const data = new Map<string, string>();
    const zavi = createZavi({
      fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => "{}" }),
      origin: ORIGIN, siteId: async () => { throw new Error("offline"); },
      storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) },
      now: () => NOW * 1000,
    });
    const deps = { pending: null, replaceUrl: () => {}, navigate: () => {} };
    expect(await runConfirm(zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, deps)).toMatchObject({ kind: "error", code: "site_unavailable" });
  });

  it("[malicious] someone else's confirmed session is not adopted by a browser that signed up for another address (login CSRF)", async () => {
    const t = setup();
    await t.zavi.auth.signUp("victim@x.test");
    t.accounts.set("rt-1", "attacker@x.test");
    const crafted = new URLSearchParams(tokens("user", "signup"));
    crafted.set("email", "victim@x.test");
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${crafted.toString()}`, t.deps);
    expect(r).toEqual({ kind: "signup_confirmed" });
    expect(t.zavi.auth.session()).toBeNull();
    t.accounts.set("rt-2", "victim@x.test");
    const own = new URLSearchParams(tokens("user", "signup"));
    own.set("refresh_token", "rt-2");
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${own.toString()}`, t.deps)).toEqual({ kind: "signed_in", type: "signup", next: "/account?welcome=1" });
    expect(t.zavi.auth.session()?.email).toBe("victim@x.test");
  });

  it("an older marker without an address (saved before this release) adopts nothing", async () => {
    const t = setup();
    t.data.set(`zavi.signup.v1:${SITE}`, String(NOW * 1000 - 60_000));
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps)).toEqual({ kind: "signup_confirmed" });
    expect(t.zavi.auth.session()).toBeNull();
  });

  it("a crafted sign-up fragment in a browser that never signed up is not adopted (login CSRF)", async () => {
    const t = setup();
    const r = await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps);
    expect(r).toEqual({ kind: "signup_confirmed" });
    expect(t.zavi.auth.session()).toBeNull();
  });

  it("confirmed without a session (or the marker is older than a day): sign in with an email link", async () => {
    const t = setup();
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#type=signup&confirmed=1`, t.deps)).toEqual({ kind: "signup_confirmed" });
    t.data.set(`zavi.signup.v1:${SITE}`, JSON.stringify({ t: NOW * 1000 - 25 * 3600 * 1000, email: "u@x.test" }));
    expect(await runConfirm(t.zavi, `${ORIGIN}/auth/confirm#${tokens("user", "signup")}`, t.deps)).toEqual({ kind: "signup_confirmed" });
    expect(t.zavi.auth.session()).toBeNull();
  });
});
