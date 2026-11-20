import { describe, it, expect } from "vitest";
import { createZavi, type FetchLike, type ResponseLike } from "../files/src/zavi/client";
import { ZaviError, codeForReason, KERNEL_REASONS } from "../files/src/zavi/errors";

const ORIGIN = "https://shop.zavi.site";
const SITE = "11111111-2222-4333-8444-555555555555";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const UID = "00000000-0000-4000-8000-000000000001";
const NOW = 1_800_000_000;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function res(status: number, body?: unknown): ResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}
const ok = (data: unknown) => res(200, { data });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SESSION = { access_token: `${b64({ alg: "ES256" })}.${b64({ sub: UID, site_role: "admin", exp: NOW + 3600 })}.sig`, refresh_token: "r", expires_at: NOW + 3600, token_type: "bearer" };

function harness(route: (c: Call) => ResponseLike, signedIn = true) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(c);
    return route(c);
  };
  const data = new Map<string, string>();
  if (signedIn) data.set(`zavi.auth.v1:${SITE}`, JSON.stringify(SESSION));
  const zavi = createZavi({
    fetch, origin: ORIGIN, siteId: async () => SITE, now: () => NOW * 1000, randomBytes: (n) => new Uint8Array(n).fill(171),
    storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) },
  });
  return { zavi, calls };
}
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ZaviError; } throw new Error("expected a rejection"); };

describe("collection.transition", () => {
  it("POSTs {to} to /api/data/:collection/:id/transition with the session", async () => {
    const { zavi, calls } = harness(() => ok({ id: ID, from: "draft", to: "published", transitioned: true }));
    expect(await zavi.data.collection("listings").transition(ID, "published")).toEqual({ id: ID, from: "draft", to: "published", transitioned: true });
    expect(calls[0]).toMatchObject({ method: "POST", url: `/api/data/listings/${ID}/transition`, body: { to: "published" } });
    expect(calls[0].headers.authorization).toMatch(/^Bearer /);
  });
  it("is signed-in only and validates the id and state locally", async () => {
    const { zavi, calls } = harness(() => ok({}), false);
    expect(await rejects(zavi.data.collection("listings").transition(ID, "published"))).toMatchObject({ code: "not_allowed", reason: "signed_out" });
    expect(await rejects(zavi.data.collection("listings").transition("nope", "published"))).toMatchObject({ reason: "invalid_id" });
    expect(await rejects(zavi.data.collection("listings").transition(ID, ""))).toMatchObject({ reason: "invalid_state" });
    expect(calls).toHaveLength(0);
  });
});

describe("zavi.actions.run", () => {
  it("forward: {target_id, data} with an Idempotency-Key (generated when absent)", async () => {
    const result = { action: "reserve_slot", target_id: ID, record_id: UID, counter: 1, replayed: false };
    const { zavi, calls } = harness(() => ok(result));
    expect(await zavi.actions.run("reserve_slot", { targetId: ID, data: { note: "hi" } })).toEqual(result);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/actions/reserve_slot", body: { target_id: ID, data: { note: "hi" } } });
    expect(calls[0].headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
  it("inverse: {record_id}; a caller key and a Turnstile token are forwarded", async () => {
    const { zavi, calls } = harness(() => ok({}));
    await zavi.actions.run("cancel_slot", { recordId: ID }, { idempotencyKey: "cancel-0000000000001", captchaToken: "tt" });
    expect(calls[0]).toMatchObject({ url: "/api/actions/cancel_slot", body: { record_id: ID } });
    expect(calls[0].headers["idempotency-key"]).toBe("cancel-0000000000001");
    expect(calls[0].headers["x-zavi-turnstile-token"]).toBe("tt");
  });
  it("refuses a malformed request before the network", async () => {
    const { zavi, calls } = harness(() => ok({}));
    expect(await rejects(zavi.actions.run("Bad Name", { targetId: ID }))).toMatchObject({ reason: "invalid_action" });
    expect(await rejects(zavi.actions.run("reserve_slot", { targetId: "x" }))).toMatchObject({ reason: "invalid_id" });
    expect(await rejects(zavi.actions.run("reserve_slot", { targetId: ID, recordId: ID } as never))).toMatchObject({ reason: "invalid_action_input" });
    expect(await rejects(zavi.actions.run("reserve_slot", { targetId: ID }, { idempotencyKey: "short" }))).toMatchObject({ reason: "idempotency_key_invalid" });
    expect(calls).toHaveLength(0);
  });
  it("server refusals are typed", async () => {
    const cases: Array<[string, number, string]> = [
      ["action_bound", 409, "conflict"], ["idempotency_conflict", 409, "conflict"], ["action_not_allowed", 403, "not_allowed"],
      ["invalid_reference", 400, "validation"], ["recipient_rate_limited", 429, "rate_limited"], ["quota_exceeded", 429, "quota"],
      ["transition_conflict", 409, "conflict"], ["not_found", 404, "not_found"], ["turnstile_required", 403, "not_allowed"],
    ];
    for (const [reason, status, code] of cases) {
      const { zavi } = harness(() => res(status, { error: { code: reason, message: reason, request_id: "r" } }));
      expect(await rejects(zavi.actions.run("reserve_slot", { targetId: ID })), reason).toMatchObject({ code, reason, status });
    }
  });
});

describe("zavi.aggregates.run", () => {
  it("POSTs {filter} and returns {value}", async () => {
    const { zavi, calls } = harness(() => ok({ value: 3 }));
    expect(await zavi.aggregates.run("booking_count", { filter: { status: "booked" } })).toEqual({ value: 3 });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/aggregates/booking_count", body: { filter: { status: "booked" } } });
    await zavi.aggregates.run("booking_count");
    expect(calls[1].body).toEqual({ filter: {} });
  });
  it("is signed-in only; aggregate_too_large is a validation error", async () => {
    expect(await rejects(harness(() => ok({}), false).zavi.aggregates.run("x"))).toMatchObject({ reason: "signed_out" });
    const { zavi } = harness(() => res(422, { error: { code: "aggregate_too_large", message: "m" } }));
    expect(await rejects(zavi.aggregates.run("x"))).toMatchObject({ code: "validation", reason: "aggregate_too_large" });
  });
});

describe("zavi.members", () => {
  it("invite / list / setRole / disable / remove hit the contract routes", async () => {
    const member = { user_id: UID, email: "a@x.test", role: "seller", status: "active" as const };
    const { zavi, calls } = harness((c) => ok(c.url.startsWith("/api/members/list") ? { items: [member], next_cursor: null } : c.url.endsWith("remove") ? { user_id: UID, removed: true } : member));
    expect(await zavi.members.invite({ email: " a@x.test ", role: "seller" })).toEqual(member);
    expect(await zavi.members.list({ limit: 20, cursor: UID })).toEqual({ items: [member], next_cursor: null });
    await zavi.members.setRole(UID, "moderator");
    await zavi.members.disable(UID);
    expect(await zavi.members.remove(UID)).toEqual({ user_id: UID, removed: true });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/api/members/invite", { email: "a@x.test", role: "seller" }],
      ["GET", `/api/members/list?limit=20&cursor=${UID}`, undefined],
      ["POST", "/api/members/set-role", { user_id: UID, role: "moderator" }],
      ["POST", "/api/members/disable", { user_id: UID }],
      ["POST", "/api/members/remove", { user_id: UID }],
    ]);
  });
  it("reenableMember / reassignOwner / deleteUserData hit their routes; erasure needs confirm", async () => {
    const { zavi, calls } = harness(() => ok({}));
    await zavi.members.reenableMember(UID);
    await zavi.members.reassignOwner("listings", ID.toUpperCase(), UID);
    await zavi.members.deleteUserData(UID, { confirm: true });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/members/reenable", { user_id: UID }],
      ["/api/members/reassign-owner", { collection: "listings", id: ID, to_user_id: UID }],
      ["/api/members/delete-data", { user_id: UID, confirm: true }],
    ]);
    expect(await rejects(zavi.members.deleteUserData(UID, {} as never))).toMatchObject({ reason: "confirm_required" });
    expect(await rejects(zavi.members.reassignOwner("Bad", ID, UID))).toMatchObject({ reason: "invalid_collection" });
    expect(calls).toHaveLength(3);
  });

  it("invite answers without a user id", async () => {
    const { zavi } = harness(() => ok({ email: "a@x.test", role: "seller", status: "invited" }));
    const m = await zavi.members.invite({ email: "a@x.test", role: "seller" });
    expect(m.user_id).toBeUndefined();
    expect(m.status).toBe("invited");
  });

  it("never sends a site id, validates ids/roles locally, types the refusals", async () => {
    const { zavi, calls } = harness(() => res(409, { error: { code: "last_admin", message: "m" } }));
    expect(await rejects(zavi.members.setRole("x", "user"))).toMatchObject({ reason: "invalid_id" });
    expect(await rejects(zavi.members.setRole(UID, "Bad Role"))).toMatchObject({ reason: "invalid_role" });
    expect(await rejects(zavi.members.list({ limit: 500 }))).toMatchObject({ reason: "invalid_limit" });
    expect(calls).toHaveLength(0);
    expect(await rejects(zavi.members.disable(UID))).toMatchObject({ code: "conflict", reason: "last_admin" });
    expect(JSON.stringify(calls)).not.toContain(SITE);
  });
});

describe("captcha (Turnstile) for signed-out visitors", () => {
  it("create, actions, uploads, sign-up, magic link and reset carry captchaToken as x-zavi-turnstile-token", async () => {
    const { zavi, calls } = harness((c) => ok(c.url.includes("upload-url") ? { url: "/api/storage/photos/object/a.png?t=x" } : { id: ID, replayed: false }), false);
    await zavi.data.collection("messages").create({ body: "hi" }, { captchaToken: "tok-1" });
    await zavi.actions.run("reserve_slot", { targetId: ID }, { captchaToken: "tok-2" });
    await zavi.auth.signUp({ email: "a@x.test", password: "password-1", captchaToken: "tok-3" });
    await zavi.auth.signInWithMagicLink({ email: "a@x.test", captchaToken: "tok-4" });
    await zavi.auth.resetPassword({ email: "a@x.test", captchaToken: "tok-5" });
    await zavi.storage.upload("photos", Object.assign(new Blob(["x"], { type: "image/png" }), { name: "a.png" }), { captchaToken: "tok-6" });
    const sent = calls.filter((c) => c.headers["x-zavi-turnstile-token"]).map((c) => [c.url.split("?")[0], c.headers["x-zavi-turnstile-token"]]);
    expect(sent).toEqual([
      ["/api/data/messages", "tok-1"], ["/api/actions/reserve_slot", "tok-2"], ["/api/auth/signup", "tok-3"],
      ["/api/auth/magic-link", "tok-4"], ["/api/auth/recover", "tok-5"], ["/api/storage/photos/upload-url", "tok-6"],
    ]);
    await zavi.data.collection("messages").create({ body: "hi" });
    expect(calls[calls.length - 1].headers["x-zavi-turnstile-token"]).toBeUndefined();
    expect(await rejects(zavi.data.collection("messages").create({ body: "x" }, { captchaToken: "a\r\nx-evil: 1" }))).toMatchObject({ reason: "invalid_captcha" });
  });

  it("siteKey comes from GET /api/site once (null when the site asks for no challenge)", async () => {
    const { zavi, calls } = harness((c) => ok(c.url === "/api/site" ? { site_id: SITE, turnstile_site_key: "0x4AAA" } : {}));
    expect(await zavi.captcha.siteKey()).toBe("0x4AAA");
    expect(await zavi.captcha.siteKey()).toBe("0x4AAA");
    expect(calls.filter((c) => c.url === "/api/site")).toHaveLength(1);
    const none = harness(() => ok({ site_id: SITE }));
    expect(await none.zavi.captcha.siteKey()).toBeNull();
  });
});

describe("error reasons", () => {
  it("every kernel reason maps to its contract code", () => {
    const expected: Record<string, string> = {
      invalid_reference: "validation", invalid_action_input: "validation", invalid_idempotency_key: "validation", invalid_role: "validation", aggregate_too_large: "validation", cascade_too_large: "validation",
      not_found: "not_found", member_not_found: "not_found",
      forbidden: "not_allowed", action_not_allowed: "not_allowed", aggregate_not_allowed: "not_allowed", member_admin_required: "not_allowed",
      unique_conflict: "conflict", transition_conflict: "conflict", action_bound: "conflict", last_admin: "conflict", idempotency_conflict: "conflict", reference_restricted: "conflict", role_in_use: "conflict",
      recipient_rate_limited: "rate_limited", quota_exceeded: "quota", contract_building: "server", index_building: "server",
      field_not_writable: "not_allowed", field_not_readable: "not_allowed", invalid_member_body: "validation", invalid_transition: "validation",
      invalid_action_body: "validation", invalid_aggregate_body: "validation",
    };
    expect([...KERNEL_REASONS].sort()).toEqual(Object.keys(expected).sort());
    for (const [r, c] of Object.entries(expected)) expect(codeForReason(r), r).toBe(c);
  });
});
