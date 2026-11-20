
import { describe, expect, it } from "vitest";
import { deriveAlias, isAliasEmail, normalizeEmail } from "../alias";
import * as broker from "../broker";
import { deleteSiteAuthUser, ensureSiteAdmin, ensureSiteCustomer, siteCustomerMagicLink, siteOwnerMagicLink } from "../admin";
import { SiteAuthError } from "../errors";
import { ALIAS_KEY, SITE_A, SITE_B, claimsOf, world } from "./fakes";

const PW = "correct horse 1";

async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SiteAuthError) return e.code;
    throw e;
  }
  return "no-error";
}

type W = ReturnType<typeof world>;

function lastHookMail(w: W, alias: string) {
  const m = [...w.gotrue.hookOutbox].reverse().find((x) => x.alias === alias);
  if (!m) throw new Error(`no hook mail for ${alias}`);
  return m;
}

function signupLinks(w: W, site: string, email: string): string[] {
  return w.mailer.sent
    .filter((m) => m.kind === "verify_signup" && m.to === email && m.site.siteId === site)
    .map((m) => new URL(m.link!).searchParams.get("token_hash")!);
}

async function confirm(w: W, site: string, token: string) {
  return broker.confirmSignup(w.deps, w.ctx(site), { type: "signup", token_hash: token });
}

async function signupAndConfirm(w: W, site: string, email: string, password = PW) {
  await broker.signup(w.deps, w.ctx(site), { email });
  await w.settle();
  const token = signupLinks(w, site, email).at(-1)!;
  const c = await confirm(w, site, token);
  const p = await broker.changePassword(w.deps, w.ctx(site), { password }, bearer(c.session!));
  const alias = deriveAlias(ALIAS_KEY, site, email);
  return { session: p.session!, alias, uid: claimsOf(p.session!.access_token).sub as string };
}

const bearer = (s: { access_token: string }) => `Bearer ${s.access_token}`;

describe("aliases", () => {
  it("are deterministic per (site, email), distinct across sites, and carry no email or site", () => {
    const a1 = deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com");
    expect(deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com")).toBe(a1);
    expect(deriveAlias(ALIAS_KEY, SITE_B, "alice@x.com")).not.toBe(a1);
    expect(isAliasEmail(a1)).toBe(true);
    expect(a1).not.toMatch(/alice|aaaaaaaa/);
  });
  it("[malicious] cannot be derived without the key (different key -> different alias) or from a weak key", () => {
    expect(deriveAlias("z".repeat(48), SITE_A, "alice@x.com")).not.toBe(deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com"));
    expect(() => deriveAlias("short", SITE_A, "alice@x.com")).toThrow();
  });
  it("normalizes case/whitespace but keeps provider-specific forms distinct", () => {
    expect(normalizeEmail("  Alice@X.COM ")).toBe("alice@x.com");
    expect(normalizeEmail("a.lice@gmail.com")).toBe("a.lice@gmail.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b@c.com")).toBeNull();
  });
});

describe("signup: email ownership first, credential second", () => {
  it("signup creates no auth user and stores no password; the confirm POST creates the account and a site-A session", async () => {
    const w = world();
    const r = await broker.signup(w.deps, w.ctx(SITE_A), { email: "Alice@X.com", password: "attacker chosen" });
    expect(r).toEqual({ status: "check_email" });
    expect(w.gotrue.users.size).toBe(0);
    expect(w.gotrue.calls).toEqual([]);
    expect(w.store.idents).toHaveLength(0);
    expect(JSON.stringify(w.store.signups)).not.toContain("attacker chosen");
    await w.settle();
    const [token] = signupLinks(w, SITE_A, "alice@x.com");
    const mail = w.mailer.sent[0];
    expect(new URL(mail.link!).origin).toBe("https://a-shop.zaviagent.com");
    expect(new URL(mail.link!).searchParams.get("type")).toBe("signup");
    expect(JSON.stringify(w.store)).not.toContain(token);

    const c = await confirm(w, SITE_A, token);
    const claims = claimsOf(c.session!.access_token);
    expect(claims).toMatchObject({ site_id: SITE_A, site_role: "user", role: "authenticated" });
    expect(typeof claims.session_started_at).toBe("number");
    const u = w.gotrue.users.get(claims.sub)!;
    expect(u).toMatchObject({ email: deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com"), confirmed: true });
    expect(u.password).not.toBe("attacker chosen");
    expect(w.store.idents).toMatchObject([{ siteId: SITE_A, email: "alice@x.com", state: "active" }]);
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: "attacker chosen" }))).toBe("invalid_credentials");
    const p = await broker.changePassword(w.deps, w.ctx(SITE_A), { password: PW }, bearer(c.session!));
    expect(p.session).toBeDefined();
    await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW });
  });

  it("[malicious] TAKEOVER, attacker first: attacker signs up the victim's address with a password; the victim confirms; the attacker has nothing", async () => {
    const w = world();
    await broker.signup(w.deps, w.ctx(SITE_A, "198.51.100.66"), { email: "victim@x.com", password: "attacker pass 1" });
    await w.settle();
    const [token] = signupLinks(w, SITE_A, "victim@x.com");
    const c = await confirm(w, SITE_A, token);
    expect(c.session).toBeDefined();
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "victim@x.com", password: "attacker pass 1" }))).toBe("invalid_credentials");
    expect([...w.gotrue.users.values()].some((u) => u.password === "attacker pass 1")).toBe(false);
  });

  it("[malicious] TAKEOVER, victim first: a repeat signup never replaces the pending row; the victim's link keeps working", async () => {
    const w = world();
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "victim@x.com" });
    await w.settle();
    const uid = w.store.signups[0].uid;
    const [first] = signupLinks(w, SITE_A, "victim@x.com");
    for (let i = 0; i < 3; i++) await broker.signup(w.deps, w.ctx(SITE_A, `198.51.100.${i}`), { email: "victim@x.com", password: "attacker pass 1" });
    await w.settle();
    expect(w.store.signups).toHaveLength(1);
    expect(w.store.signups[0].uid).toBe(uid);
    expect(signupLinks(w, SITE_A, "victim@x.com")).toHaveLength(1);
    const c = await confirm(w, SITE_A, first);
    expect(claimsOf(c.session!.access_token).sub).toBe(uid);
  });

  it("[malicious] repeat signups add at most 3 live challenges (after the cooldown); the first confirmation kills them all", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      await broker.signup(w.deps, w.ctx(SITE_A, `198.51.100.${i}`), { email: "alice@x.com" });
      w.advance((broker.SIGNUP_COOLDOWN_S + 1) * 1000);
    }
    await w.settle();
    const links = signupLinks(w, SITE_A, "alice@x.com");
    expect(links).toHaveLength(broker.SIGNUP_MAX_LIVE);
    await confirm(w, SITE_A, links[1]);
    expect(await err(confirm(w, SITE_A, links[0]))).toBe("invalid_link");
    expect(await err(confirm(w, SITE_A, links[2]))).toBe("invalid_link");
    expect(await confirm(w, SITE_A, links[1])).toEqual({ type: "signup", confirmed: true });
    w.advance(11 * 60 * 1000);
    expect(await err(confirm(w, SITE_A, links[1]))).toBe("invalid_link");
    expect(w.gotrue.users.size).toBe(1);
  });

  it("[malicious] RACE: two concurrent signups of one address -> one pending row, one account, no known password", async () => {
    const w = world();
    await Promise.all([
      broker.signup(w.deps, w.ctx(SITE_A, "198.51.100.1"), { email: "alice@x.com", password: "pw of caller 1" }),
      broker.signup(w.deps, w.ctx(SITE_A, "198.51.100.2"), { email: "alice@x.com", password: "pw of caller 2" }),
    ]);
    await w.settle();
    expect(w.store.signups).toHaveLength(1);
    const links = signupLinks(w, SITE_A, "alice@x.com");
    expect(links).toHaveLength(1);
    const [c1, c2] = await Promise.all([links[0], links[0]].map((t) => confirm(w, SITE_A, t).catch((e) => e)));
    const subs = [c1, c2].filter((x) => x && "session" in x && x.session).map((x) => claimsOf(x.session.access_token).sub);
    expect(subs.length).toBeLessThanOrEqual(1);
    expect(w.gotrue.users.size).toBe(1);
    for (const pw of ["pw of caller 1", "pw of caller 2"]) {
      expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: pw }))).toBe("invalid_credentials");
    }
  });

  it("[malicious] the link's GET never confirms (scanners): only the interstitial's POST does", async () => {
    const w = world();
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
    await w.settle();
    const [token] = signupLinks(w, SITE_A, "alice@x.com");
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type: "signup", token_hash: token }))).toBe("invalid_link");
    expect(broker.callbackLanding({ type: "signup", token_hash: token })).toBe("/auth/confirm#error=invalid_link");
    const html = broker.signupInterstitial(token);
    expect(html).toContain('<form method="post" action="/api/auth/confirm">');
    expect(html).not.toMatch(/<script|https?:\/\/|<img|<link /);
    expect(broker.INTERSTITIAL_HEADERS).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "strict-origin" });
    expect(broker.signupInterstitial('"><script>x</script>')).not.toContain("<script>x");
    expect(w.store.idents).toHaveLength(0);
    expect((await confirm(w, SITE_A, token)).session).toBeDefined();
  });

  it("[malicious] a signup link of site A posted to site B is refused; an expired one says so", async () => {
    const w = world();
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
    await w.settle();
    const [token] = signupLinks(w, SITE_A, "alice@x.com");
    expect(await err(confirm(w, SITE_B, token))).toBe("invalid_link");
    expect(await err(broker.confirmSignup(w.deps, w.ctx(SITE_A), { type: "magiclink", token_hash: token }))).toBe("invalid_link");
    w.advance((broker.SIGNUP_TTL_S + 1) * 1000);
    expect(await err(confirm(w, SITE_A, token))).toBe("link_expired");
    expect(w.store.idents).toHaveLength(0);
  });

  it("[malicious] the same email on B is a separate account; a site-A account cannot sign in on B", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    expect(await err(broker.login(w.deps, w.ctx(SITE_B), { email: "alice@x.com", password: PW }))).toBe("invalid_credentials");
    const b = await signupAndConfirm(w, SITE_B, "alice@x.com", "other pass 2");
    expect(b.uid).not.toBe(a.uid);
    expect(claimsOf(b.session.access_token).site_id).toBe(SITE_B);
    expect(await err(broker.login(w.deps, w.ctx(SITE_B), { email: a.alias, password: PW }))).toBe("invalid_credentials");
  });

  describe("Supabase Auth failure at every confirm step", () => {
    async function pending(w: W) {
      await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      await w.settle();
      return signupLinks(w, SITE_A, "alice@x.com")[0];
    }

    it("createUser fails before creating: unavailable, nothing activated, the same link works later", async () => {
      const w = world();
      const t = await pending(w);
      w.gotrue.fail.createUser = "before";
      expect(await err(confirm(w, SITE_A, t))).toBe("unavailable");
      expect(w.store.idents).toHaveLength(0);
      expect(w.store.signups[0].state).toBe("pending");
      w.gotrue.fail = {};
      expect((await confirm(w, SITE_A, t)).session).toBeDefined();
    });

    it("createUser commits but its response is lost: the exact id + alias + confirmation match, so it continues", async () => {
      const w = world();
      const t = await pending(w);
      w.gotrue.fail.createUser = "after";
      const c = await confirm(w, SITE_A, t);
      expect(c.session).toBeDefined();
      expect(w.gotrue.users.size).toBe(1);
    });

    it("createUser AND the lookup fail (ambiguous): the lease is kept and a retry of the same link resumes it", async () => {
      const w = world();
      const t = await pending(w);
      w.gotrue.fail = { createUser: "after", getUserById: true };
      expect(await err(confirm(w, SITE_A, t))).toBe("unavailable");
      expect(w.store.signups[0].state).toBe("creating");
      expect(w.store.idents).toHaveLength(0);
      w.gotrue.fail = {};
      expect((await confirm(w, SITE_A, t)).session).toBeDefined();
      expect(w.gotrue.users.size).toBe(1);
    });

    it("[malicious] an auth user with the preallocated id but another email is never adopted: quarantined", async () => {
      const w = world();
      const t = await pending(w);
      const uid = w.store.signups[0].uid;
      w.gotrue.users.set(uid, { id: uid, email: "someone-else@u.zavisite.invalid", password: "known", confirmed: true });
      expect(await err(confirm(w, SITE_A, t))).toBe("invalid_link");
      expect(w.store.signups[0].state).toBe("quarantined");
      expect(w.store.idents).toHaveLength(0);
      expect(await err(confirm(w, SITE_A, t))).toBe("invalid_link");
    });

    it("another link of the same signup waits while a confirm holds the lease", async () => {
      const w = world();
      await pending(w);
      w.advance((broker.SIGNUP_COOLDOWN_S + 1) * 1000);
      await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      await w.settle();
      const [t1, t2] = signupLinks(w, SITE_A, "alice@x.com");
      w.gotrue.fail = { createUser: "after", getUserById: true };
      expect(await err(confirm(w, SITE_A, t1))).toBe("unavailable");
      w.gotrue.fail = {};
      expect(await err(confirm(w, SITE_A, t2))).toBe("unavailable");
      w.advance((broker.CONFIRM_LEASE_S + 1) * 1000);
      expect((await confirm(w, SITE_A, t2)).session).toBeDefined();
    });

    it("the session mint fails after activation: the account is active, the visitor signs in by magic link", async () => {
      const w = world();
      const t = await pending(w);
      w.gotrue.fail.magicLink = true;
      expect(await confirm(w, SITE_A, t)).toEqual({ type: "signup", confirmed: true });
      expect(w.store.idents[0].state).toBe("active");
      w.gotrue.fail = {};
      await broker.magicLink(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      await w.settle();
      const m = lastHookMail(w, deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com"));
      expect((await broker.callback(w.deps, w.ctx(SITE_A), { type: m.type, token_hash: m.tokenHash })).session).toBeDefined();
    });

    it("[malicious] the address became an account during the confirm: the auth user it made is removed, no takeover", async () => {
      const w = world();
      const t = await pending(w);
      const orig = w.store.signupConfirmFinish.bind(w.store);
      w.store.signupConfirmFinish = async (s, sha) => {
        w.store.idents.push({ siteId: SITE_A, email: "alice@x.com", uid: "someone", alias: "someone@u", state: "active" });
        return orig(s, sha);
      };
      expect(await err(confirm(w, SITE_A, t))).toBe("invalid_link");
      expect(w.gotrue.calls).toContain("deleteUser");
      expect(w.store.idents.map((i) => i.uid)).toEqual(["someone"]);
    });

    it("an abandoned confirm's auth user is removed by the shard sweep after expiry", async () => {
      const w = world();
      const t = await pending(w);
      w.gotrue.fail = { createUser: "after", getUserById: true };
      await err(confirm(w, SITE_A, t));
      w.gotrue.fail = {};
      expect(w.gotrue.users.size).toBe(1);
      w.advance((broker.SIGNUP_TTL_S + 1) * 1000);
      expect(await broker.purgeSignups(w.shard)).toBe(1);
      expect(w.gotrue.users.size).toBe(0);
      expect(w.store.signups).toHaveLength(0);
    });
  });

  it("[malicious] a pre-1004 unconfirmed signup (identity unverified, auth user with an attacker-chosen password) is finished by inbox proof; the old password dies", async () => {
    const w = world();
    const alias = deriveAlias(ALIAS_KEY, SITE_A, "legacy@x.com");
    w.store.idents.push({ siteId: SITE_A, email: "legacy@x.com", uid: "e1e1e1e1-0000-4000-8000-000000000001", alias, state: "unverified" });
    w.store.members.push({ siteId: SITE_A, uid: "e1e1e1e1-0000-4000-8000-000000000001", role: "user", status: "active", createdAt: 0 });
    w.gotrue.users.set("e1e1e1e1-0000-4000-8000-000000000001", { id: "e1e1e1e1-0000-4000-8000-000000000001", email: alias, password: "attacker pass 1", confirmed: false });
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "legacy@x.com" });
    await w.settle();
    const [t] = signupLinks(w, SITE_A, "legacy@x.com");
    expect(t).toBeDefined();
    const c = await confirm(w, SITE_A, t);
    expect(claimsOf(c.session!.access_token).sub).toBe("e1e1e1e1-0000-4000-8000-000000000001");
    expect(w.gotrue.users.get("e1e1e1e1-0000-4000-8000-000000000001")!.password).not.toBe("attacker pass 1");
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "legacy@x.com", password: "attacker pass 1" }))).toBe("invalid_credentials");
  });

  it("a rate-limited verification mail is kept and retried later, not dropped", async () => {
    const w = world();
    let limited = true;
    w.mailer.send = async (_s, req) => { if (limited) return "limited"; w.mailer.sent.push(req); return "sent"; };
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
    await w.settle();
    expect(w.store.outbox).toHaveLength(1);
    limited = false;
    expect(await broker.drainOutbox(w.deps, w.shard)).toBe(0);
    w.advance((broker.OUTBOX_LIMITED_RETRY_S + 1) * 1000);
    expect(await broker.drainOutbox(w.deps, w.shard)).toBe(1);
    expect(signupLinks(w, SITE_A, "alice@x.com")).toHaveLength(1);
    expect(w.store.outbox).toHaveLength(0);
  });

  it("[malicious] a shard still on legacy HS256 tokens yields no session (the gateway needs ES256 + kid)", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.gotrue.legacyHs256 = true;
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW }))).toBe("invalid_link");
    expect(broker.sessionTokenFits("not.a.jwt", SITE_A)).toBe(false);
  });

  it("rejects a bad email and a suspended site", async () => {
    const w = world();
    expect(await err(broker.signup(w.deps, w.ctx(SITE_A), { email: "nope" }))).toBe("bad_request");
    w.sites[SITE_A].active = false;
    expect(await err(broker.signup(w.deps, w.ctx(SITE_A), { email: "a@x.com" }))).toBe("site_unavailable");
  });
});

describe("[malicious] anti-enumeration", () => {
  it("signup answers identically, in the same time, for a new and an existing address", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.slept.length = 0;
    const t0 = w.deps.now();
    const known = await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: "whatever 123" });
    const t1 = w.deps.now();
    const unknown = await broker.signup(w.deps, w.ctx(SITE_A), { email: "nobody@x.com", password: "whatever 123" });
    const t2 = w.deps.now();
    expect(known).toEqual(unknown);
    expect(t1 - t0).toBe(broker.FLOOR_ENUMERATION_MS);
    expect(t2 - t1).toBe(broker.FLOOR_ENUMERATION_MS);
    expect(w.store.calls.filter((c) => c === "signupRequest")).toHaveLength(3);
    await w.settle();
    expect(w.mailer.sent.slice(-2).map((m) => `${m.kind}:${m.to}`).sort()).toEqual(["account_exists:alice@x.com", "verify_signup:nobody@x.com"]);
    await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW });
  });

  it("magic link and recovery answer identically for unknown/known; only known addresses get mail", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const users = w.gotrue.users.size;
    for (const op of [broker.magicLink, broker.recover]) {
      const before = w.gotrue.hookOutbox.length;
      const t0 = w.deps.now();
      const u = await op(w.deps, w.ctx(SITE_A), { email: "ghost@x.com" });
      const t1 = w.deps.now();
      const k = await op(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      const t2 = w.deps.now();
      expect(u).toEqual(k);
      expect([t1 - t0, t2 - t1]).toEqual([broker.FLOOR_ENUMERATION_MS, broker.FLOOR_ENUMERATION_MS]);
      expect(w.gotrue.hookOutbox.slice(before).map((m) => m.alias)).toEqual([a.alias]);
    }
    expect(w.gotrue.users.size).toBe(users);
  });

  it("a slow mail path cannot make a known address answer later than an unknown one", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.gotrue.sendRecovery = () => new Promise(() => {});
    w.gotrue.sendMagicLink = () => new Promise(() => {});
    for (const op of [broker.magicLink, broker.recover]) {
      const t0 = w.deps.now();
      await op(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      expect(w.deps.now() - t0).toBe(broker.FLOOR_ENUMERATION_MS);
    }
  });

  it("a link asked for right after confirming still arrives: the broker mails it when the auth service throttles (QA R6-1b)", async () => {
    for (const [op, type, kind] of [[broker.magicLink, "magiclink", "magic_link"], [broker.recover, "recovery", "recovery"]] as const) {
      const w = world();
      w.gotrue.mailWindowMs = 60_000;
      await broker.signup(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      await w.settle();
      await confirm(w, SITE_A, signupLinks(w, SITE_A, "alice@x.com").at(-1)!);
      const hookBefore = w.gotrue.hookOutbox.length;
      w.advance(30_000);
      expect(await op(w.deps, w.ctx(SITE_A), { email: "alice@x.com" })).toEqual({ status: "check_email" });
      await w.settle();
      const m = w.mailer.sent.at(-1)!;
      expect(m).toMatchObject({ to: "alice@x.com", kind });
      expect(m.site.siteId).toBe(SITE_A);
      const link = new URL(m.link!);
      expect(link.hostname).toBe("a-shop.zaviagent.com");
      expect(link.searchParams.get("type")).toBe(type);
      expect((await broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: link.searchParams.get("token_hash")! })).session).toBeDefined();
      expect(w.gotrue.hookOutbox.length).toBe(hookBefore);
      const mailed = w.mailer.sent.length;
      w.advance(10_000);
      expect(await op(w.deps, w.ctx(SITE_A), { email: "alice@x.com" })).toEqual({ status: "check_email" });
      await w.settle();
      expect(w.mailer.sent.length).toBe(mailed);
      expect(w.gotrue.hookOutbox.length).toBe(hookBefore);
      w.advance(61_000);
      await op(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
      await w.settle();
      expect(w.gotrue.hookOutbox.length).toBe(hookBefore + 1);
      expect(w.mailer.sent.length).toBe(mailed);
    }
  });

  it("any other auth-service failure on a link mail is not retried by the broker", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.gotrue.sendMagicLink = async () => { throw new Error("gotrue otp: boom"); };
    const mailed = w.mailer.sent.length;
    expect(await broker.magicLink(w.deps, w.ctx(SITE_A), { email: "alice@x.com" })).toEqual({ status: "check_email" });
    await w.settle();
    expect(w.mailer.sent.length).toBe(mailed);
  });

  it("login: wrong password and unknown address give the same code after the same time", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    const t0 = w.deps.now();
    const e1 = await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: "wrong pass" }));
    const t1 = w.deps.now();
    const e2 = await err(broker.login(w.deps, w.ctx(SITE_A), { email: "ghost@x.com", password: "wrong pass" }));
    const t2 = w.deps.now();
    expect([e1, e2]).toEqual(["invalid_credentials", "invalid_credentials"]);
    expect([t1 - t0, t2 - t1]).toEqual([broker.FLOOR_LOGIN_MS, broker.FLOOR_LOGIN_MS]);
  });

  it("rate limits key on the inputs, so known and unknown addresses hit them identically", async () => {
    const w = world();
    await signupAndConfirm(w, SITE_A, "alice@x.com");
    const run = async (email: string) => {
      const codes: string[] = [];
      for (let i = 0; i < 11; i++) codes.push(await err(broker.login(w.deps, w.ctx(SITE_A, `198.51.100.${i}`), { email, password: "bad pass 1" })));
      return codes;
    };
    const known = await run("alice@x.com");
    const unknown = await run("ghost@x.com");
    expect(known).toEqual(unknown);
    expect(known.at(-1)).toBe("rate_limited");
    expect(await err(broker.login(w.deps, w.ctx(SITE_B), { email: "alice@x.com", password: "bad pass 1" }))).toBe("invalid_credentials");
  });
});

describe("password reset", () => {
  it("[malicious] a reset link works once; the new password applies and other sessions are signed out", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    await broker.recover(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
    const m = lastHookMail(w, a.alias);
    expect(m.type).toBe("recovery");
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: "recovery", token_hash: m.tokenHash });
    const p = await broker.changePassword(w.deps, w.ctx(SITE_A), { password: "brand new pw" }, bearer(cb.session!));
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type: "recovery", token_hash: m.tokenHash }))).toBe("invalid_link");
    expect(await w.gotrue.getUser(a.session.access_token)).toBeNull();
    await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: "brand new pw" });
    expect(claimsOf(p.session!.access_token).site_id).toBe(SITE_A);
    await broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(p.session!));
  });

  it("[malicious] if the password update fails, earlier (possibly stolen) sessions are already revoked", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const thief = await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW });
    w.gotrue.signOut = async () => {};
    w.gotrue.fail.updateUser = true;
    await expect(broker.changePassword(w.deps, w.ctx(SITE_A), { password: "after reset 1", current_password: PW }, bearer(a.session))).rejects.toThrow();
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(thief.session)))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: thief.session.refresh_token }))).toBe("unauthorized");
  });

  it("[malicious] an old session after a reset is refused at once, even if Supabase Auth still accepts it; its refresh is denied by the hook", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const thief = await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW });
    w.gotrue.signOut = async () => {};
    await broker.changePassword(w.deps, w.ctx(SITE_A), { password: "after reset 1", current_password: PW }, bearer(a.session));
    expect(await w.gotrue.getUser(thief.session.access_token)).not.toBeNull();
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(thief.session)))).toBe("unauthorized");
    expect(await err(broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "t@evil.com" }, bearer(thief.session)))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: thief.session.refresh_token }))).toBe("unauthorized");
  });

  it("[malicious] a stale session without the current password cannot change the password", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.advance((broker.REAUTH_WINDOW_S + 60) * 1000);
    expect(await err(broker.changePassword(w.deps, w.ctx(SITE_A), { password: "hijack pass" }, bearer(a.session)))).toBe("reauth_required");
    expect(await err(broker.changePassword(w.deps, w.ctx(SITE_A), { password: "hijack pass", current_password: "guess 123" }, bearer(a.session)))).toBe("reauth_required");
    await broker.changePassword(w.deps, w.ctx(SITE_A), { password: "legit new pw", current_password: PW }, bearer(a.session));
  });
});

describe("email change", () => {
  async function aliceWithSession(w: W) {
    return signupAndConfirm(w, SITE_A, "alice@x.com");
  }
  function changeLink(w: W) {
    const m = w.mailer.sent.filter((x) => x.kind === "email_change_confirm").at(-1)!;
    const p = new URL(m.link!).searchParams;
    return { mail: m, type: p.get("type")!, token: p.get("token_hash")! };
  }

  it("commits only after the NEW address confirms, then notifies the old one", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "alice2@y.com", current_password: PW }, bearer(a.session));
    const { mail, type, token } = changeLink(w);
    expect(mail).toMatchObject({ to: "alice2@y.com" });
    expect(new URL(mail.link!).host).toBe("a-shop.zaviagent.com");
    await broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW });
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice2@y.com", password: PW }))).toBe("invalid_credentials");

    const r = await broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token });
    expect(r).toMatchObject({ type: "email_change", email_changed: true });
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(a.session)))).toBe("unauthorized");
    expect(claimsOf(r.session!.access_token).site_id).toBe(SITE_A);
    expect(w.mailer.sent.at(-1)).toMatchObject({ kind: "email_changed_notice", to: "alice@x.com", detail: "a***@y.com" });
    await broker.login(w.deps, w.ctx(SITE_A), { email: "alice2@y.com", password: PW });
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW }))).toBe("invalid_credentials");
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token }))).toBe("invalid_link");
  });

  it("[malicious] the confirmation token is bound to its site", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "alice2@y.com", current_password: PW }, bearer(a.session));
    const { type, token } = changeLink(w);
    expect(await err(broker.callback(w.deps, w.ctx(SITE_B), { type, token_hash: token }))).toBe("invalid_link");
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token + "x" }))).toBe("invalid_link");
  });

  it("[malicious] changing to an address that already has an account on the site: same answer, no mail, victim intact", async () => {
    const w = world();
    const victim = await signupAndConfirm(w, SITE_A, "victim@x.com", "victim pass 1");
    const attacker = await signupAndConfirm(w, SITE_A, "attacker@x.com", "attacker pass");
    const sentBefore = w.mailer.sent.length;
    const r = await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "victim@x.com", current_password: "attacker pass" }, bearer(attacker.session));
    expect(r).toEqual({ status: "check_email" });
    expect(w.mailer.sent.length).toBe(sentBefore);
    await broker.login(w.deps, w.ctx(SITE_A), { email: "victim@x.com", password: "victim pass 1" });
    expect(victim.uid).not.toBe(attacker.uid);
  });

  it("[malicious] a pending reservation blocks a second claimant and a signup of that address", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    const b = await signupAndConfirm(w, SITE_A, "bob@x.com", "bob pass 12");
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "free@x.com", current_password: PW }, bearer(a.session));
    const n = w.mailer.sent.length;
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "free@x.com", current_password: "bob pass 12" }, bearer(b.session));
    expect(w.mailer.sent.length).toBe(n);
    const users = w.gotrue.users.size;
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "free@x.com", password: "squatter pw" });
    expect(w.gotrue.users.size).toBe(users);
  });

  it("[malicious] a stolen stale session without the password cannot start an email change", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    w.advance((broker.REAUTH_WINDOW_S + 60) * 1000);
    expect(await err(broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "thief@evil.com" }, bearer(a.session)))).toBe("reauth_required");
    expect(w.mailer.sent.some((m) => m.to === "thief@evil.com")).toBe(false);
  });

  it("[malicious] a site-A session cannot act on site B", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await signupAndConfirm(w, SITE_B, "alice@x.com");
    for (const call of [
      () => broker.requestEmailChange(w.deps, w.ctx(SITE_B), { new_email: "z@x.com", current_password: PW }, bearer(a.session)),
      () => broker.changePassword(w.deps, w.ctx(SITE_B), { password: "new pass 99", current_password: PW }, bearer(a.session)),
      () => broker.deleteAccount(w.deps, w.ctx(SITE_B), { current_password: PW }, bearer(a.session)),
      () => broker.logout(w.deps, w.ctx(SITE_B), {}, bearer(a.session)),
    ]) {
      expect(await err(call())).toBe("unauthorized");
    }
  });

  it("an expired link is refused and the account returns to normal", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "late@y.com", current_password: PW }, bearer(a.session));
    const { type, token } = changeLink(w);
    w.advance((broker.EMAIL_CHANGE_TTL_S + 1) * 1000);
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token }))).toBe("link_expired");
    expect(w.store.idents.find((i) => i.uid === a.uid)!.state).toBe("active");
  });

  it("if the commit fails after the auth email moved, the auth email is reverted", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "race@y.com", current_password: PW }, bearer(a.session));
    const { type, token } = changeLink(w);
    w.store.idents.push({ siteId: SITE_A, email: "race@y.com", uid: "other", alias: "other@u", state: "active" });
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token }))).toBe("invalid_link");
    expect(w.gotrue.users.get(a.uid)!.email).toBe(a.alias);
    expect(w.store.changes.at(-1)!.state).toBe("failed");
  });

  it("an interrupted commit resumes with the same link", async () => {
    const w = world();
    const a = await aliceWithSession(w);
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "retry@y.com", current_password: PW }, bearer(a.session));
    const { type, token } = changeLink(w);
    w.gotrue.failUpdateEmail = true;
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token }))).toBe("unavailable");
    w.gotrue.failUpdateEmail = false;
    expect(await broker.callback(w.deps, w.ctx(SITE_A), { type, token_hash: token })).toMatchObject({ type: "email_change", email_changed: true });
  });
});

describe("refresh, logout", () => {
  it("refresh rotates and keeps the site; a refresh token replayed on another site is refused and revoked", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const r = await broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: a.session.refresh_token });
    expect(claimsOf(r.session.access_token).site_id).toBe(SITE_A);
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: a.session.refresh_token }))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_B), { refresh_token: r.session.refresh_token }))).toBe("unauthorized");
  });

  it("logout revokes the session", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    await broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(a.session));
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(a.session)))).toBe("unauthorized");
  });

  it("[malicious] a forged token (claims say site A, no real session) is refused", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const c = claimsOf(a.session.access_token);
    const forged = `${a.session.access_token.split(".")[0]}.${Buffer.from(JSON.stringify({ ...c, session_id: "nope" })).toString("base64url")}.sig`;
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, `Bearer ${forged}`))).toBe("unauthorized");
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, "Basic abc"))).toBe("unauthorized");
  });
});

describe("account deletion", () => {
  it("deletes storage, then records/membership/mapping, then the auth user; other users and sites untouched", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const b = await signupAndConfirm(w, SITE_B, "alice@x.com");
    w.store.objects.push(
      { name: `${SITE_A}/avatars/a.png`, owner: a.uid },
      { name: `${SITE_A}/avatars/someone.png`, owner: "someone" },
      { name: `${SITE_B}/avatars/b.png`, owner: b.uid },
    );
    w.store.records.push({ siteId: SITE_A, owner: a.uid, id: "1" }, { siteId: SITE_A, owner: "someone", id: "2" }, { siteId: SITE_B, owner: b.uid, id: "3" });
    w.store.calls.length = 0;
    w.gotrue.calls.length = 0;
    await broker.deleteAccount(w.deps, w.ctx(SITE_A), { current_password: PW }, bearer(a.session));
    const order = [...w.store.calls, ...w.gotrue.calls].filter((c) =>
      ["beginDeletion", "removeObjects", "deleteAccountData", "deleteUser", "finishDeletion"].includes(c),
    );
    expect(w.store.calls).toEqual(["beginDeletion", "beginDeletion", "deleteAccountData", "finishDeletion"]);
    expect(w.gotrue.calls.filter((c) => c === "removeObjects" || c === "deleteUser")).toEqual(["removeObjects", "deleteUser"]);
    expect(order).toHaveLength(6);
    expect(w.gotrue.removed).toEqual([`${SITE_A}/avatars/a.png`]);
    expect(w.store.records.map((r) => r.id)).toEqual(["2", "3"]);
    expect(w.gotrue.users.has(a.uid)).toBe(false);
    expect(w.gotrue.users.has(b.uid)).toBe(true);
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW }))).toBe("invalid_credentials");
    await broker.login(w.deps, w.ctx(SITE_B), { email: "alice@x.com", password: PW });
  });

  it("strict ordering: storage is emptied before data, data before the auth user", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.store.objects.push({ name: `${SITE_A}/f/1`, owner: a.uid });
    const seen: string[] = [];
    const s = w.store, g = w.gotrue;
    const wrap = <T extends object>(o: T, k: keyof T, tag: string) => {
      const f = (o[k] as any).bind(o);
      (o as any)[k] = async (...args: any[]) => { seen.push(tag); return f(...args); };
    };
    wrap(s, "beginDeletion", "freeze"); wrap(g, "removeObjects", "storage"); wrap(s, "deleteAccountData", "data");
    wrap(g, "deleteUser", "auth"); wrap(s, "finishDeletion", "tombstone");
    await broker.deleteAccount(w.deps, w.ctx(SITE_A), { current_password: PW }, bearer(a.session));
    expect(seen).toEqual(["freeze", "freeze", "storage", "data", "auth", "tombstone"]);
  });

  it("[malicious] needs the password or a fresh sign-in", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    w.advance((broker.REAUTH_WINDOW_S + 60) * 1000);
    expect(await err(broker.deleteAccount(w.deps, w.ctx(SITE_A), {}, bearer(a.session)))).toBe("reauth_required");
    expect(w.gotrue.users.has(a.uid)).toBe(true);
  });

  it("an interrupted deletion is retried in process; the frozen account cannot sign in meanwhile", async () => {
    const w = world();
    const scheduled: Array<() => void> = [];
    const deps = { ...w.deps, schedule: (fn: () => void) => { scheduled.push(fn); } };
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const orig = w.gotrue.deleteUser.bind(w.gotrue);
    w.gotrue.deleteUser = async () => { throw new Error("gotrue down"); };
    expect(await broker.deleteAccount(deps, w.ctx(SITE_A), { current_password: PW }, bearer(a.session))).toEqual({ deleted: true, completing: true });
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "alice@x.com", password: PW }))).toBe("invalid_credentials");
    expect(scheduled).toHaveLength(1);
    w.gotrue.deleteUser = orig;
    scheduled[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.gotrue.users.has(a.uid)).toBe(false);
    expect(w.store.deletions.size).toBe(0);
  });

  it("leftover deletions are swept by the next admitted gateway call (throttled per shard)", async () => {
    const w = world();
    const a = await signupAndConfirm(w, SITE_A, "alice@x.com");
    const orig = w.gotrue.deleteUser.bind(w.gotrue);
    w.gotrue.deleteUser = async () => { throw new Error("gotrue down"); };
    await broker.deleteAccount({ ...w.deps, schedule: () => {} }, w.ctx(SITE_A), { current_password: PW }, bearer(a.session));
    w.gotrue.deleteUser = orig;
    await broker.admitGatewayRequest(w.deps, { siteId: SITE_B, shardId: "shard-1", requestId: "req-00000001", ts: 1 }, 300);
    await w.settle();
    expect(w.gotrue.users.has(a.uid)).toBe(false);
    expect(w.store.deletions.size).toBe(0);
    expect(await broker.resumeDeletions(w.shard)).toBe(0);
  });
});

describe("founder admin", () => {
  it("creates an admin account on the site only, idempotently, and promotes an existing user", async () => {
    const w = world();
    const r1 = await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "Founder@Biz.com" });
    const r2 = await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" });
    expect(r1.created).toBe(true);
    expect(r2).toEqual({ authUserId: r1.authUserId, created: false });
    expect(w.store.members.find((m) => m.uid === r1.authUserId)).toMatchObject({ siteId: SITE_A, role: "admin" });
    expect(w.store.idents.filter((i) => i.email === "founder@biz.com")).toHaveLength(1);
    await broker.magicLink(w.deps, w.ctx(SITE_A), { email: "founder@biz.com" });
    const m = lastHookMail(w, deriveAlias(ALIAS_KEY, SITE_A, "founder@biz.com"));
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: m.type, token_hash: m.tokenHash });
    expect(claimsOf(cb.session!.access_token)).toMatchObject({ site_id: SITE_A, site_role: "admin" });
    expect(await err(broker.login(w.deps, w.ctx(SITE_B), { email: "founder@biz.com", password: PW }))).toBe("invalid_credentials");

    const u = await signupAndConfirm(w, SITE_A, "staff@biz.com");
    expect(await err(ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "staff@biz.com" }))).toBe("admin_exists");
    expect(w.store.members.find((m) => m.uid === u.uid)!.role).toBe("user");
  });

  it("an existing account becomes the founder admin when the site has none yet", async () => {
    const w = world();
    const u = await signupAndConfirm(w, SITE_A, "founder@biz.com");
    expect(await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" })).toEqual({ authUserId: u.uid, created: false });
    expect(w.store.members.find((m) => m.uid === u.uid)!.role).toBe("admin");
    expect(w.store.audit.map((a) => a.action)).toEqual(["bootstrap_admin"]);
  });

  it("owner link: a one-time sign-in for an ACTIVE admin of THIS site only, never mailed", async () => {
    const w = world();
    await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" });
    const before = w.gotrue.hookOutbox.length;
    const link = await siteOwnerMagicLink(w.deps, { shardId: "shard-1", siteId: SITE_A, email: "Founder@Biz.com", redirectTo: "https://a-shop.zaviagent.com/admin" });
    expect(w.gotrue.hookOutbox).toHaveLength(before);
    const u = new URL(link);
    expect(u.origin).toBe("https://a-shop.zaviagent.com");
    expect(u.pathname).toBe("/api/auth/callback");
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: u.searchParams.get("type"), token_hash: u.searchParams.get("token_hash") });
    expect(claimsOf(cb.session!.access_token)).toMatchObject({ site_id: SITE_A, site_role: "admin" });
    expect(await err(broker.callback(w.deps, w.ctx(SITE_A), { type: u.searchParams.get("type"), token_hash: u.searchParams.get("token_hash") }))).toBe("invalid_link");
  });

  it("[malicious] owner link refuses: a plain user, another site, another shard id, an off-site redirect", async () => {
    const w = world();
    await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" });
    await signupAndConfirm(w, SITE_A, "user@biz.com");
    const ok = { shardId: "shard-1", siteId: SITE_A, email: "founder@biz.com", redirectTo: "https://a-shop.zaviagent.com/admin" };
    await expect(siteOwnerMagicLink(w.deps, { ...ok, email: "user@biz.com" })).rejects.toThrow(/not an active admin/);
    await expect(siteOwnerMagicLink(w.deps, { ...ok, siteId: SITE_B })).rejects.toThrow(/not an active admin|redirect/);
    await expect(siteOwnerMagicLink(w.deps, { ...ok, shardId: "shard-2" })).rejects.toThrow(/not active on this shard/);
    await expect(siteOwnerMagicLink(w.deps, { ...ok, redirectTo: "https://b-cafe.zaviagent.com/admin" })).rejects.toThrow(/redirect/);
    await expect(siteOwnerMagicLink(w.deps, { ...ok, redirectTo: "http://a-shop.zaviagent.com/admin" })).rejects.toThrow(/redirect/);
  });

  it("a publish-gate customer is an active user member made with the admin as the actor, and its link signs in as a user (never an admin), with nothing mailed", async () => {
    const w = world();
    await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "gate-owner@a-shop.zaviagent.com" });
    const before = w.gotrue.hookOutbox.length;
    const args = { siteId: SITE_A, email: "gate-customer@a-shop.zaviagent.com", adminEmail: "gate-owner@a-shop.zaviagent.com" };
    const first = await ensureSiteCustomer(w.deps, args);
    expect((await ensureSiteCustomer(w.deps, args)).authUserId).toBe(first.authUserId);
    const link = await siteCustomerMagicLink(w.deps, { shardId: "shard-1", siteId: SITE_A, email: args.email, redirectTo: "https://a-shop.zaviagent.com/" });
    expect(w.gotrue.hookOutbox).toHaveLength(before);
    const u = new URL(link);
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: u.searchParams.get("type"), token_hash: u.searchParams.get("token_hash") });
    expect(claimsOf(cb.session!.access_token)).toMatchObject({ site_id: SITE_A, site_role: "user" });
  });

  it("[malicious] customer helpers refuse: a non-admin actor, the admin as the customer, an admin's link, an off-site redirect", async () => {
    const w = world();
    await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" });
    await signupAndConfirm(w, SITE_A, "user@biz.com");
    await expect(ensureSiteCustomer(w.deps, { siteId: SITE_A, email: "c@biz.com", adminEmail: "user@biz.com" })).rejects.toThrow(/not an active admin/);
    await expect(ensureSiteCustomer(w.deps, { siteId: SITE_A, email: "founder@biz.com", adminEmail: "founder@biz.com" })).rejects.toThrow(/cannot be the admin/);
    const ok = { shardId: "shard-1", siteId: SITE_A, email: "user@biz.com", redirectTo: "https://a-shop.zaviagent.com/" };
    await expect(siteCustomerMagicLink(w.deps, { ...ok, email: "founder@biz.com" })).rejects.toThrow(/not an active customer/);
    await expect(siteCustomerMagicLink(w.deps, { ...ok, redirectTo: "https://b-cafe.zaviagent.com/" })).rejects.toThrow(/redirect/);
    await expect(siteCustomerMagicLink(w.deps, { ...ok, shardId: "shard-2" })).rejects.toThrow(/not active on this shard/);
  });

  it("deleteSiteAuthUser removes the shard auth user; a missing user counts as done", async () => {
    const w = world();
    const { authUserId } = await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "founder@biz.com" });
    await deleteSiteAuthUser(w.deps, { shardId: "shard-1", authUserId });
    expect(w.gotrue.users.has(authUserId)).toBe(false);
    await deleteSiteAuthUser(w.deps, { shardId: "shard-1", authUserId });
    await expect(deleteSiteAuthUser(w.deps, { shardId: "nope", authUserId })).rejects.toThrow(/shard not found/);
  });
});

describe("the session names the visitor by their real email, never the sign-in alias", () => {
  const noAlias = (s: object) => expect(JSON.stringify(s)).not.toMatch(/sites-auth/);

  it("confirm, password set, login, sign-in link, refresh and email change carry the real address", async () => {
    const w = world();
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "Alice@X.com" });
    await w.settle();
    const c = await confirm(w, SITE_A, signupLinks(w, SITE_A, "alice@x.com").at(-1)!);
    expect(c.session!.email).toBe("alice@x.com");
    const p = await broker.changePassword(w.deps, w.ctx(SITE_A), { password: PW }, bearer(c.session!));
    expect(p.session!.email).toBe("alice@x.com");

    const l = await broker.login(w.deps, w.ctx(SITE_A), { email: " ALICE@x.com ", password: PW });
    expect(l.session.email).toBe("alice@x.com");
    noAlias({ ...l.session, access_token: "", refresh_token: "" });

    await broker.magicLink(w.deps, w.ctx(SITE_A), { email: "alice@x.com" });
    const m = lastHookMail(w, deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com"));
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: m.type, token_hash: m.tokenHash });
    expect(cb.session!.email).toBe("alice@x.com");
    expect(broker.callbackResultFragment(cb)).toContain(`email=${encodeURIComponent("alice@x.com")}`);

    const rf = await broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: l.session.refresh_token });
    expect(rf.session.email).toBe("alice@x.com");
    const orig = w.store.identityByUser.bind(w.store);
    w.store.identityByUser = async () => { throw new Error("db down"); };
    const rf2 = await broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: rf.session.refresh_token });
    expect("email" in rf2.session).toBe(false);
    w.store.identityByUser = orig;

    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "alice2@y.com", current_password: PW }, bearer(cb.session!));
    const link = new URL(w.mailer.sent.filter((x) => x.kind === "email_change_confirm").at(-1)!.link!).searchParams;
    const ch = await broker.callback(w.deps, w.ctx(SITE_A), { type: link.get("type")!, token_hash: link.get("token_hash")! });
    expect(ch.session!.email).toBe("alice2@y.com");
  });
});
