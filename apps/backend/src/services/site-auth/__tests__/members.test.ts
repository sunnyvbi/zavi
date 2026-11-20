
import { describe, expect, it } from "vitest";
import * as broker from "../broker";
import { ensureSiteAdmin } from "../admin";
import { SiteAuthError } from "../errors";
import { SITE_A, SITE_B, claimsOf, world } from "./fakes";

const PW = "correct horse 1";
type W = ReturnType<typeof world>;
const bearer = (s: { access_token: string }) => `Bearer ${s.access_token}`;

async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SiteAuthError) return e.code;
    throw e;
  }
  return "no-error";
}

async function signupAndConfirm(w: W, site: string, email: string, password = PW) {
  await broker.signup(w.deps, w.ctx(site), { email });
  await w.settle();
  const m = w.mailer.sent.filter((x) => x.kind === "verify_signup" && x.to === email && x.site.siteId === site).at(-1)!;
  const c = await broker.confirmSignup(w.deps, w.ctx(site), { type: "signup", token_hash: new URL(m.link!).searchParams.get("token_hash") });
  const p = await broker.changePassword(w.deps, w.ctx(site), { password }, bearer(c.session!));
  return { session: p.session!, uid: claimsOf(p.session!.access_token).sub as string };
}

async function founder(w: W, site: string, email = "owner@biz.com") {
  const { authUserId } = await ensureSiteAdmin(w.deps, { siteId: site, email });
  await broker.magicLink(w.deps, w.ctx(site), { email });
  await w.settle();
  const m = [...w.gotrue.hookOutbox].reverse().find((x) => x.type === "magiclink")!;
  const cb = await broker.callback(w.deps, w.ctx(site), { type: m.type, token_hash: m.tokenHash });
  return { uid: authUserId, session: cb.session! };
}

async function setup() {
  const w = world();
  w.store.roles.set(SITE_A, ["seller", "moderator"]);
  const admin = await founder(w, SITE_A);
  const bob = await signupAndConfirm(w, SITE_A, "bob@x.com");
  const adminB = await founder(w, SITE_B, "ownerb@biz.com");
  const carolB = await signupAndConfirm(w, SITE_B, "carol@x.com");
  return { w, admin, bob, adminB, carolB };
}

describe("member admin: who may call", () => {
  it("[malicious] a non-admin cannot invite, list, change roles, disable or remove", async () => {
    const { w, admin, bob } = await setup();
    const ctx = w.ctx(SITE_A);
    const auth = bearer(bob.session);
    expect(await err(broker.memberInvite(w.deps, ctx, { email: "evil@x.com", role: "admin" }, auth))).toBe("member_admin_required");
    expect(await err(broker.memberList(w.deps, ctx, {}, auth))).toBe("member_admin_required");
    expect(await err(broker.memberSetRole(w.deps, ctx, { user_id: bob.uid, role: "admin" }, auth))).toBe("member_admin_required");
    expect(await err(broker.memberSetRole(w.deps, ctx, { user_id: admin.uid, role: "user" }, auth))).toBe("member_admin_required");
    expect(await err(broker.memberDisable(w.deps, ctx, { user_id: admin.uid }, auth))).toBe("member_admin_required");
    expect(await err(broker.memberRemove(w.deps, ctx, { user_id: admin.uid }, auth))).toBe("member_admin_required");
    expect(w.store.members.find((m) => m.uid === bob.uid)!.role).toBe("user");
    expect(w.store.audit.filter((a) => a.actor === bob.uid)).toHaveLength(0);
  });

  it("[malicious] a forged site_role=admin claim on a user's token changes nothing (membership is read from the DB)", async () => {
    const { w, bob } = await setup();
    const parts = bob.session.access_token.split(".");
    const c = claimsOf(bob.session.access_token);
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...c, site_role: "admin" })).toString("base64url")}.${parts[2]}`;
    expect(await err(broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "admin" }, `Bearer ${forged}`))).toBe("member_admin_required");
  });

  it("[malicious] an admin of site A cannot manage site B, nor reach B's members through A", async () => {
    const { w, admin, carolB } = await setup();
    expect(await err(broker.memberSetRole(w.deps, w.ctx(SITE_B), { user_id: carolB.uid, role: "admin" }, bearer(admin.session)))).toBe("unauthorized");
    expect(await err(broker.memberList(w.deps, w.ctx(SITE_B), {}, bearer(admin.session)))).toBe("unauthorized");
    expect(await err(broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: carolB.uid, role: "user" }, bearer(admin.session)))).toBe("member_not_found");
    expect(await err(broker.memberDisable(w.deps, w.ctx(SITE_A), { user_id: carolB.uid }, bearer(admin.session)))).toBe("member_not_found");
    expect(await err(broker.memberRemove(w.deps, w.ctx(SITE_A), { user_id: carolB.uid }, bearer(admin.session)))).toBe("member_not_found");
    const list = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(list.items.map((m) => m.user_id)).not.toContain(carolB.uid);
    expect(w.store.members.find((m) => m.uid === carolB.uid)).toMatchObject({ role: "user", status: "active" });
  });
});

describe("member admin: roles and last admin", () => {
  it("[malicious] an undeclared or malformed role is refused; a manifest role, admin and user are accepted", async () => {
    const { w, admin, bob } = await setup();
    const set = (role: unknown) => broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role }, bearer(admin.session));
    expect(await err(set("superuser"))).toBe("invalid_role");
    expect(await err(set("Admin"))).toBe("invalid_role");
    expect(await err(set(""))).toBe("invalid_role");
    expect(await err(set(["admin"]))).toBe("invalid_role");
    expect((await set("seller")).role).toBe("seller");
    expect(await err(broker.memberInvite(w.deps, w.ctx(SITE_B), { email: "x@x.com", role: "seller" }, bearer((await founderSession(w, SITE_B)))))).toBe("invalid_role");
    expect((await set("admin")).role).toBe("admin");
    expect((await set("user")).role).toBe("user");
  });

  it("the last active admin cannot be demoted, disabled, removed, or delete their own account", async () => {
    const { w, admin } = await setup();
    const a = bearer(admin.session);
    expect(await err(broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: admin.uid, role: "user" }, a))).toBe("last_admin");
    expect(await err(broker.memberDisable(w.deps, w.ctx(SITE_A), { user_id: admin.uid }, a))).toBe("last_admin");
    expect(await err(broker.memberRemove(w.deps, w.ctx(SITE_A), { user_id: admin.uid }, a))).toBe("last_admin");
    w.advance(1000);
    expect(await err(broker.deleteAccount(w.deps, w.ctx(SITE_A), {}, a))).toBe("last_admin");
    expect(w.gotrue.users.has(admin.uid)).toBe(true);
    expect(w.store.members.find((m) => m.uid === admin.uid)).toMatchObject({ role: "admin", status: "active" });
  });

  it("[malicious] a demoted admin's existing session is refused at once and cannot refresh", async () => {
    const { w, admin, bob } = await setup();
    await broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "admin" }, bearer(admin.session));
    const bobAdmin = await broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW });
    expect(claimsOf(bobAdmin.session.access_token).site_role).toBe("admin");
    await broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "user" }, bearer(admin.session));
    expect(await err(broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(bobAdmin.session)))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: bobAdmin.session.refresh_token }))).toBe("unauthorized");
    const fresh = await broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW });
    expect(claimsOf(fresh.session.access_token).site_role).toBe("user");
  });

  it("[malicious] a disabled member is denied: existing session, refresh and new sign-in", async () => {
    const { w, admin, bob } = await setup();
    const r = await broker.memberDisable(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session));
    expect(r).toMatchObject({ user_id: bob.uid, status: "disabled", email: "bob@x.com" });
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(bob.session)))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: bob.session.refresh_token }))).toBe("unauthorized");
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW }))).toBe("invalid_credentials");
  });

  it("remove ends the membership at once but keeps the person's records; invite brings them back", async () => {
    const { w, admin, bob } = await setup();
    w.store.records.push({ siteId: SITE_A, owner: bob.uid, id: "r1" }, { siteId: SITE_A, owner: bob.uid, id: "r2" });
    expect(await broker.memberRemove(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session))).toEqual({ user_id: bob.uid, removed: true });
    expect(w.store.records.filter((r) => r.owner === bob.uid)).toHaveLength(2);
    expect(w.gotrue.users.has(bob.uid)).toBe(true);
    expect(await err(broker.logout(w.deps, w.ctx(SITE_A), {}, bearer(bob.session)))).toBe("unauthorized");
    expect(await err(broker.refresh(w.deps, w.ctx(SITE_A), { refresh_token: bob.session.refresh_token }))).toBe("unauthorized");
    expect(await err(broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW }))).toBe("invalid_credentials");
    const list = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(list.items.map((m) => m.user_id)).not.toContain(bob.uid);
    await broker.memberInvite(w.deps, w.ctx(SITE_A), { email: "bob@x.com", role: "seller" }, bearer(admin.session));
    await w.settle();
    const back = await broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW });
    expect(claimsOf(back.session.access_token).site_role).toBe("seller");
  });

  it("reassign-owner hands one record of a removed person to an active member; never across sites", async () => {
    const { w, admin, bob, adminB, carolB } = await setup();
    const r1 = "11111111-1111-4111-8111-000000000001", r2 = "11111111-1111-4111-8111-000000000002", rb = "11111111-1111-4111-8111-0000000000bb";
    w.store.records.push({ siteId: SITE_A, owner: bob.uid, id: r1, collection: "listings" }, { siteId: SITE_A, owner: bob.uid, id: r2, collection: "listings" },
      { siteId: SITE_B, owner: carolB.uid, id: rb, collection: "listings" });
    await broker.memberRemove(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session));
    const call = (body: unknown, auth = bearer(admin.session)) => broker.memberReassignOwner(w.deps, w.ctx(SITE_A), body, auth);
    expect(await call({ collection: "listings", id: r1, to_user_id: admin.uid })).toEqual({ id: r1, owner_id: admin.uid });
    expect(w.store.records.map((r) => r.owner)).toEqual([admin.uid, bob.uid, carolB.uid]);
    expect(await err(call({ collection: "listings", id: rb, to_user_id: admin.uid }))).toBe("not_found");
    expect(await err(call({ collection: "listings", id: r2, to_user_id: adminB.uid }))).toBe("member_not_found");
    expect(await err(call({ collection: "listings", id: r2, to_user_id: bob.uid }))).toBe("member_not_found");
    expect(await err(call({ collection: "listings", id: r2, to_user_id: admin.uid }, bearer(bob.session)))).toBe("unauthorized");
    expect(w.store.audit.filter((a) => a.action === "reassign")).toHaveLength(1);
  });

  it("delete-data erases the person's records and account on this site only, needs confirm, never the last admin", async () => {
    const { w, admin, bob, adminB, carolB } = await setup();
    w.store.records.push({ siteId: SITE_A, owner: bob.uid, id: "r1" }, { siteId: SITE_B, owner: carolB.uid, id: "rb" });
    expect(await err(broker.memberDeleteData(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session)))).toBe("confirmation_required");
    expect(await err(broker.memberDeleteData(w.deps, w.ctx(SITE_A), { user_id: admin.uid, confirm: true }, bearer(admin.session)))).toBe("last_admin");
    expect(await err(broker.memberDeleteData(w.deps, w.ctx(SITE_A), { user_id: carolB.uid, confirm: true }, bearer(admin.session)))).toBe("member_not_found");
    w.store.objects.push({ name: `${SITE_A}/avatars/bob.png`, owner: bob.uid });
    expect(await broker.memberDeleteData(w.deps, w.ctx(SITE_A), { user_id: bob.uid, confirm: true }, bearer(admin.session))).toEqual({ user_id: bob.uid, records: 1, files: 1 });
    expect(w.store.records.map((r) => r.id)).toEqual(["rb"]);
    expect(w.gotrue.users.has(bob.uid)).toBe(false);
    expect(w.gotrue.users.has(carolB.uid) && w.gotrue.users.has(adminB.uid)).toBe(true);
    expect(w.store.audit.filter((a) => a.action === "delete_data")).toHaveLength(1);
  });

  it("re-enable: admin-only, audited, restores sign-in", async () => {
    const { w, admin, bob, carolB } = await setup();
    await broker.memberDisable(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session));
    expect(await err(broker.memberReenable(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(bob.session)))).toBe("unauthorized");
    expect(await err(broker.memberReenable(w.deps, w.ctx(SITE_A), { user_id: carolB.uid }, bearer(admin.session)))).toBe("member_not_found");
    expect(await broker.memberReenable(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, bearer(admin.session))).toMatchObject({ user_id: bob.uid, status: "active" });
    await broker.login(w.deps, w.ctx(SITE_A), { email: "bob@x.com", password: PW });
    expect(w.store.audit.filter((a) => a.action === "enable")).toHaveLength(1);
  });
});

async function founderSession(w: W, site: string) {
  const id = w.store.idents.find((i) => i.siteId === site && w.store.members.some((m) => m.uid === i.uid && m.role === "admin"))!;
  await broker.magicLink(w.deps, w.ctx(site), { email: id.email });
  await w.settle();
  const m = [...w.gotrue.hookOutbox].reverse().find((x) => x.alias === id.alias)!;
  return (await broker.callback(w.deps, w.ctx(site), { type: m.type, token_hash: m.tokenHash })).session!;
}

describe("member admin: invite", () => {
  it("[malicious] invite gives no signal: same body, same time, same store call for new, member, pending-signup and held addresses", async () => {
    const { w, admin, bob } = await setup();
    await broker.signup(w.deps, w.ctx(SITE_A), { email: "pending@x.com" });
    await broker.requestEmailChange(w.deps, w.ctx(SITE_A), { new_email: "held@x.com", current_password: PW }, bearer(bob.session));
    await w.settle();
    const out: unknown[] = [];
    const times: number[] = [];
    for (const email of ["new@x.com", "bob@x.com", "pending@x.com", "held@x.com", "owner@biz.com"]) {
      const t0 = w.deps.now();
      out.push(await broker.memberInvite(w.deps, w.ctx(SITE_A), { email, role: "seller" }, bearer(admin.session)));
      times.push(w.deps.now() - t0);
    }
    expect(out).toEqual([
      { email: "new@x.com", role: "seller", status: "invited" },
      { email: "bob@x.com", role: "seller", status: "invited" },
      { email: "pending@x.com", role: "seller", status: "invited" },
      { email: "held@x.com", role: "seller", status: "invited" },
      { email: "owner@biz.com", role: "seller", status: "invited" },
    ]);
    expect(new Set(times)).toEqual(new Set([broker.FLOOR_ENUMERATION_MS]));
    await w.settle();
    expect(w.store.members.find((m) => m.uid === bob.uid)!.role).toBe("user");
    expect(w.store.members.find((m) => m.uid === admin.uid)!.role).toBe("admin");
    expect(w.store.signups.some((s) => s.email === "pending@x.com")).toBe(false);
  });

  it("a new address becomes an active member with the role and gets a one-time sign-in link; a re-invite resumes", async () => {
    const { w, admin } = await setup();
    await broker.memberInvite(w.deps, w.ctx(SITE_A), { email: "Sam@X.com", role: "moderator" }, bearer(admin.session));
    await w.settle();
    const mail = w.mailer.sent.filter((m) => m.kind === "invite").at(-1)!;
    expect(mail).toMatchObject({ to: "sam@x.com" });
    const u = new URL(mail.link!);
    expect(u.origin).toBe("https://a-shop.zaviagent.com");
    const cb = await broker.callback(w.deps, w.ctx(SITE_A), { type: u.searchParams.get("type"), token_hash: u.searchParams.get("token_hash") });
    expect(claimsOf(cb.session!.access_token)).toMatchObject({ site_id: SITE_A, site_role: "moderator" });
    const list = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(list.items.find((m) => m.email === "sam@x.com")).toMatchObject({ role: "moderator", status: "active" });
  });

  it("an invite whose auth user fails to land stays 'invited' (grants nothing) and a re-invite completes it", async () => {
    const { w, admin } = await setup();
    w.gotrue.fail.createUser = "before";
    await broker.memberInvite(w.deps, w.ctx(SITE_A), { email: "sam@x.com", role: "seller" }, bearer(admin.session));
    await w.settle();
    let list = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(list.items.find((m) => m.email === "sam@x.com")).toMatchObject({ status: "invited" });
    w.gotrue.fail = {};
    await broker.memberInvite(w.deps, w.ctx(SITE_A), { email: "sam@x.com", role: "seller" }, bearer(admin.session));
    await w.settle();
    list = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(list.items.find((m) => m.email === "sam@x.com")).toMatchObject({ status: "active", role: "seller" });
  });
});

describe("member admin: list + audit", () => {
  it("lists with a keyset cursor and validates the query", async () => {
    const { w, admin } = await setup();
    for (const e of ["a1@x.com", "a2@x.com", "a3@x.com"]) await signupAndConfirm(w, SITE_A, e);
    const p1 = await broker.memberList(w.deps, w.ctx(SITE_A), { limit: "2" }, bearer(admin.session));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBe(p1.items[1].user_id);
    const p2 = await broker.memberList(w.deps, w.ctx(SITE_A), { limit: "2", cursor: p1.next_cursor }, bearer(admin.session));
    expect(p2.items.every((m) => m.user_id > p1.next_cursor!)).toBe(true);
    const all = await broker.memberList(w.deps, w.ctx(SITE_A), {}, bearer(admin.session));
    expect(all.items).toHaveLength(5);
    expect(all.next_cursor).toBeNull();
    expect(await err(broker.memberList(w.deps, w.ctx(SITE_A), { limit: "500" }, bearer(admin.session)))).toBe("bad_request");
    expect(await err(broker.memberList(w.deps, w.ctx(SITE_A), { cursor: "x' or 1=1" }, bearer(admin.session)))).toBe("bad_request");
  });

  it("every change appends one audit row with actor, target and detail; refusals write none", async () => {
    const { w, admin, bob } = await setup();
    const before = w.store.audit.length;
    const a = bearer(admin.session);
    await broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "seller" }, a);
    await broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "seller" }, a);
    await broker.memberDisable(w.deps, w.ctx(SITE_A), { user_id: bob.uid }, a);
    await broker.memberInvite(w.deps, w.ctx(SITE_A), { email: "new@x.com", role: "user" }, a);
    await w.settle();
    await broker.memberList(w.deps, w.ctx(SITE_A), {}, a);
    await err(broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: admin.uid, role: "user" }, a));
    await err(broker.memberSetRole(w.deps, w.ctx(SITE_A), { user_id: bob.uid, role: "nope" }, a));
    const rows = w.store.audit.slice(before);
    expect(rows.map((r) => r.action)).toEqual(["set_role", "disable", "invite", "invite_activated", "list"]);
    expect(rows[0]).toMatchObject({ siteId: SITE_A, actor: admin.uid, target: bob.uid, detail: { from: "user", to: "seller" } });
    expect(JSON.stringify(rows)).not.toContain("new@x.com");
  });
});

describe("Turnstile with a site's own secret (custom widget)", () => {
  it("verifies with THAT site's secret only; no secret set fails closed; a token for another hostname fails", async () => {
    const w = world();
    const secrets: Record<string, string> = { [SITE_A]: "secret-of-a", [SITE_B]: "secret-of-b" };
    const seen: Array<Record<string, string>> = [];
    let host = "a-shop.zaviagent.com";
    const deps = {
      ...w.deps,
      turnstileSecret: async (id: string) => secrets[id] ?? null,
      fetch: (async (_u: string, init: { body: URLSearchParams }) => {
        const f = Object.fromEntries(init.body.entries());
        seen.push(f);
        return new Response(JSON.stringify({ success: f.secret === "secret-of-a" && f.response === "tok", hostname: host }));
      }) as never,
    };
    expect(await broker.turnstileVerify(deps, w.ctx(SITE_A), { token: "tok", ip: "203.0.113.7" })).toEqual({ success: true });
    expect(seen[0]).toEqual({ secret: "secret-of-a", response: "tok", remoteip: "203.0.113.7" });
    expect(await broker.turnstileVerify(deps, w.ctx(SITE_B), { token: "tok" })).toEqual({ success: false });
    expect(seen[1].secret).toBe("secret-of-b");
    host = "b-cafe.zaviagent.com";
    expect(await broker.turnstileVerify(deps, w.ctx(SITE_A), { token: "tok" })).toEqual({ success: false });
    delete secrets[SITE_A];
    expect(await err(broker.turnstileVerify(deps, w.ctx(SITE_A), { token: "tok" }))).toBe("unavailable");
    expect(await broker.turnstileVerify(deps, w.ctx(SITE_B), { token: "" })).toEqual({ success: false });
  });
});
