import { describe, it, expect } from "vitest";
import { createZavi, type KeyValueStorage } from "../files/src/zavi/client";
import { DevStore } from "../files/src/zavi/devstore";
import { createLocalServer, type DevSeed } from "../files/src/zavi/local";
import { validateManifest } from "../manifest";
import { TEMPLATE_FILES } from "../template-files.generated";

const ORIGIN = "http://localhost:5173";
const SITE = "00000000-0000-4000-8000-00000000d0e0";

function mem(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function world(opts: { manifest?: unknown; seed?: DevSeed; persist?: KeyValueStorage; now?: () => number } = {}) {
  const m = validateManifest(opts.manifest ?? TEMPLATE_FILES["zavi-site.json"]);
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  const store = new DevStore({ manifest: m.value, now: opts.now });
  const server = createLocalServer({
    store, siteId: SITE, persist: opts.persist ?? null, now: opts.now,
    seed: opts.seed ?? (JSON.parse(TEMPLATE_FILES["dev-seed.json"]) as DevSeed),
    objectUrl: () => `blob:${ORIGIN}/f00d`,
  });
  const tab = (storage: KeyValueStorage = mem()) =>
    createZavi({ fetch: server.fetch, origin: ORIGIN, siteId: async () => SITE, storage, now: opts.now });
  return { store, server, tab };
}

describe("dev mode: the starter's submissions collection behaves like production", () => {
  it("a visitor creates a message, cannot read it back; the seeded admin can", async () => {
    const w = world();
    const visitor = w.tab();
    const { id } = await visitor.data.collection("submissions").create({ name: "Pat", body: "hello" });
    expect(await visitor.data.collection("submissions").get(id)).toBeNull();
    expect((await visitor.data.collection("submissions").list()).items).toEqual([]);

    const admin = w.tab();
    await admin.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    expect(admin.auth.user()?.role).toBe("admin");
    const page = await admin.data.collection("submissions").list();
    expect(page.items.map((r) => r.data.name)).toEqual(["Pat", "Sample visitor"]);
    expect(await admin.data.collection("submissions").get(id)).toMatchObject({ id, data: { name: "Pat", body: "hello" }, mine: false });
  });

  it("schema and masks are enforced: unknown field, empty name, a visitor setting the admin-only status", async () => {
    const z = world().tab();
    const m = z.data.collection("submissions");
    await expect(m.create({ name: "P", body: "b", extra: 1 })).rejects.toMatchObject({ code: "validation", reason: "schema_violation: unknown field extra" });
    await expect(m.create({ name: "", body: "b" })).rejects.toMatchObject({ code: "validation" });
    await expect(m.create({ name: "P", body: "b", status: "done" })).rejects.toMatchObject({ code: "not_allowed", reason: "field_not_writable: status" });
    await expect(m.create({ name: "P", body: "x".repeat(2001) })).rejects.toMatchObject({ code: "validation" });
  });

  it("a signed-in user sees only their own submissions; update/delete stay admin-only", async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.auth.signUp({ email: "a@site.test", password: "password-a" });
    await b.auth.signUp({ email: "b@site.test", password: "password-b" });
    const { id } = await a.data.collection("submissions").create({ name: "A", body: "mine" });
    expect((await a.data.collection("submissions").list()).items.map((r) => [r.id, r.mine])).toEqual([[id, true]]);
    expect((await b.data.collection("submissions").list()).items).toEqual([]);
    expect(await b.data.collection("submissions").get(id)).toBeNull();
    await expect(a.data.collection("submissions").update(id, { body: "edit" })).rejects.toMatchObject({ code: "not_found" });
    await expect(a.data.collection("submissions").delete(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("an idempotent retry returns the same record; reusing the key for other values is a conflict", async () => {
    const z = world().tab();
    const m = z.data.collection("submissions");
    const k = "same-key-0123456789";
    const first = await m.create({ name: "P", body: "b" }, { idempotencyKey: k });
    expect(await m.create({ name: "P", body: "b" }, { idempotencyKey: k })).toEqual({ id: first.id, replayed: true });
    await expect(m.create({ name: "P", body: "other" }, { idempotencyKey: k })).rejects.toMatchObject({ code: "conflict" });
  });

  it("filters only on declared indexes and only for callers who can read the field", async () => {
    const w = world();
    const admin = w.tab();
    await admin.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    const { id } = await admin.data.collection("submissions").create({ name: "N", body: "b", status: "done" });
    expect((await admin.data.collection("submissions").list({ filter: { status: "done" } })).items.map((r) => r.id)).toEqual([id]);
    await expect(admin.data.collection("submissions").list({ filter: { name: "N" } })).rejects.toMatchObject({ code: "validation", reason: "filter_not_allowed" });
    await expect(admin.data.collection("submissions").list({ order: "name" })).rejects.toMatchObject({ reason: "sort_not_allowed" });
  });
});

describe("dev mode: auth", () => {
  it("wrong password, duplicate sign-up and weak password are typed errors", async () => {
    const z = world().tab();
    await expect(z.auth.signIn({ email: "admin@example.com", password: "nope" })).rejects.toMatchObject({ code: "not_allowed", reason: "invalid_credentials" });
    expect(await z.auth.signUp({ email: "admin@example.com", password: "password-x" })).toEqual({ session: null, confirmationRequired: true });
    await expect(z.auth.signUp("not-an-email")).rejects.toMatchObject({ code: "validation", reason: "invalid_email" });
  });

  it("sign-up is passwordless: a password is never sent; the new user sets one with updatePassword", async () => {
    const w = world();
    const calls: string[] = [];
    const z = createZavi({
      fetch: async (url, init) => { calls.push(String(init.body ?? "")); return w.server.fetch(url, init); },
      origin: ORIGIN, siteId: async () => SITE, storage: mem(),
    });
    await z.auth.signUp({ email: "pw@site.test", password: "never-sent-1" });
    expect(calls.join("\n")).not.toContain("never-sent-1");
    await z.auth.signUp("pw2@site.test");
    expect(z.auth.session()).not.toBeNull();
    const before = z.auth.session()!.refresh_token;
    await expect(z.auth.updatePassword("short")).rejects.toMatchObject({ reason: "weak_password" });
    await z.auth.updatePassword("chosen-pass-1");
    expect(z.auth.session()!.refresh_token).not.toBe(before);
    const other = w.tab();
    await expect(other.auth.signIn({ email: "pw@site.test", password: "never-sent-1" })).rejects.toMatchObject({ reason: "invalid_credentials" });
    expect(await other.auth.signIn({ email: "pw2@site.test", password: "chosen-pass-1" })).toBeTruthy();
  });

  it("the token's site_role is informational: a forged admin claim gets a user's rights", async () => {
    const w = world();
    const z = w.tab();
    await z.auth.signUp({ email: "mallory@site.test", password: "password-m" });
    const s = z.auth.session()!;
    const [h, p] = s.access_token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, site_role: "admin" })).toString("base64url")}.dev`;
    const res = await w.server.fetch("/api/data/submissions", { method: "GET", headers: { authorization: `Bearer ${forged}` } });
    expect(JSON.parse(await res.text()).data.items).toEqual([]);
  });

  it("tokens for another site, expired tokens and garbage are refused with 401", async () => {
    let now = Date.UTC(2026, 9, 1);
    const w = world({ now: () => now });
    const z = w.tab();
    await z.auth.signUp({ email: "u@site.test", password: "password-u" });
    const [h, p] = z.auth.session()!.access_token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const other = `${h}.${Buffer.from(JSON.stringify({ ...claims, site_id: "99999999-0000-4000-8000-000000000000" })).toString("base64url")}.dev`;
    for (const t of [other, "garbage", `${h}.!!!.x`]) {
      const res = await w.server.fetch("/api/data/submissions", { method: "GET", headers: { authorization: `Bearer ${t}` } });
      expect(res.status).toBe(401);
    }
    now += 2 * 3600 * 1000;
    const expired = await w.server.fetch("/api/data/submissions", { method: "GET", headers: { authorization: `Bearer ${z.auth.session()!.access_token}` } });
    expect(expired.status).toBe(401);
  });

  it("refresh tokens rotate: the SDK refreshes an expired session, and a reused refresh token is refused", async () => {
    let now = Date.UTC(2026, 9, 1);
    const w = world({ now: () => now });
    const storage = mem();
    const z = w.tab(storage);
    await z.auth.signUp({ email: "r@site.test", password: "password-r" });
    const old = z.auth.session()!;
    now += 2 * 3600 * 1000;
    await z.data.collection("submissions").list();
    expect(z.auth.session()!.refresh_token).not.toBe(old.refresh_token);
    const reuse = await w.server.fetch("/api/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: old.refresh_token }) });
    expect(reuse.status).toBe(401);
  });

  it("password, email and delete need a recent sign-in or the current password", async () => {
    let now = Date.UTC(2026, 9, 1);
    const w = world({ now: () => now });
    const z = w.tab();
    await z.auth.signUp({ email: "re@site.test", password: "password-re" });
    await z.auth.updatePassword("password-new");
    now += 11 * 60 * 1000;
    await expect(z.auth.deleteAccount()).rejects.toMatchObject({ reason: "reauth_required" });
    await expect(z.auth.changeEmail({ email: "x@site.test", currentPassword: "wrong-pass" })).rejects.toMatchObject({ reason: "reauth_required" });
    await z.auth.changeEmail({ email: "x@site.test", currentPassword: "password-new" });
    await z.auth.deleteAccount({ currentPassword: "password-new" });
    expect(z.auth.session()).toBeNull();
  });

  it("deleting the account ends the session and the account", async () => {
    const w = world();
    const z = w.tab();
    await z.auth.signUp({ email: "d@site.test", password: "password-d" });
    const t = z.auth.session()!.access_token;
    await z.auth.deleteAccount();
    expect(z.auth.session()).toBeNull();
    const res = await w.server.fetch("/api/data/submissions", { method: "GET", headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
    await expect(z.auth.signIn({ email: "d@site.test", password: "password-d" })).rejects.toMatchObject({ code: "not_allowed" });
  });
});

describe("dev mode: persistence and seeds", () => {
  it("records and accounts survive a reload (same localStorage); the seed is applied once", async () => {
    const persist = mem();
    const w1 = world({ persist });
    await w1.tab().data.collection("submissions").create({ name: "Kept", body: "b" });
    const w2 = world({ persist });
    const admin = w2.tab();
    await admin.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    const names = (await admin.data.collection("submissions").list()).items.map((r) => r.data.name);
    expect(names).toEqual(["Kept", "Sample visitor"]);
  });

  it("a collection dropped from the manifest is ARCHIVED like production: kept, unreachable, back when re-declared", async () => {
    const persist = mem();
    const w1 = world({ persist });
    await w1.tab().data.collection("submissions").create({ name: "Kept", body: "b" });

    const full = JSON.parse(TEMPLATE_FILES["zavi-site.json"]) as { collections: Record<string, unknown> };
    const { submissions, ...rest } = full.collections;
    const without = { ...full, collections: { ...rest, notes: submissions } };
    const w2 = world({ persist, manifest: without });
    const admin = w2.tab();
    await admin.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    await expect(admin.data.collection("submissions").list()).rejects.toMatchObject({ code: "not_allowed" });
    expect((await admin.data.collection("notes").list()).items).toEqual([]);
    await expect(admin.data.collection("submissions").create({ name: "x", body: "y" })).rejects.toMatchObject({ code: "not_allowed" });
    await admin.data.collection("notes").create({ name: "N", body: "n" });

    const w3 = world({ persist });
    const admin3 = w3.tab();
    await admin3.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    const names = (await admin3.data.collection("submissions").list()).items.map((r) => r.data.name);
    expect(names).toEqual(["Kept", "Sample visitor"]);
  });

  it("a seed record that breaks the schema fails loudly", () => {
    expect(() => world({ seed: { records: { submissions: [{ data: { name: "x" } }] } } })).toThrow(/body is required/);
    expect(() => world({ seed: { records: { submissions: [{ owner: "ghost@x.test", data: { name: "x", body: "y" } }] } } })).toThrow(/not a seeded user/);
    expect(() => world({ seed: { records: { nope: [{ data: {} }] } } })).toThrow(/unknown records collection/);
  });
});

describe("dev mode: files", () => {
  const manifest = {
    schemaVersion: 1,
    collections: { photos: { kind: "files", rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], delete: ["owner", "admin"] } } },
  };

  it("upload, list, url and remove follow the area rules", async () => {
    const w = world({ manifest, seed: {} });
    const visitor = w.tab();
    await expect(visitor.storage.upload("photos", new Blob(["x"], { type: "image/png" }), { name: "a.png" })).rejects.toMatchObject({ code: "not_allowed" });
    const u = w.tab();
    await u.auth.signUp({ email: "f@site.test", password: "password-f" });
    await u.storage.upload("photos", new Blob(["x"], { type: "image/png" }), { name: "a.png" });
    await expect(u.storage.upload("photos", new Blob(["y"]), { name: "a.png" })).rejects.toMatchObject({ code: "conflict" });
    expect((await visitor.storage.list("photos")).map((f) => f.name)).toEqual(["a.png"]);
    expect(await visitor.storage.url("photos", "a.png")).toBe(`blob:${ORIGIN}/f00d`);
    await expect(visitor.storage.remove("photos", "a.png")).rejects.toMatchObject({ code: "not_allowed" });
    const other = w.tab();
    await other.auth.signUp({ email: "o@site.test", password: "password-o" });
    await expect(other.storage.remove("photos", "a.png")).rejects.toMatchObject({ code: "not_found" });
    await u.storage.remove("photos", "a.png");
    expect(await visitor.storage.list("photos")).toEqual([]);
  });

  it("an area that is not declared, or a records collection, refuses uploads", async () => {
    const w = world({ manifest, seed: {} });
    const u = w.tab();
    await u.auth.signUp({ email: "g@site.test", password: "password-g" });
    await expect(u.storage.upload("secrets", new Blob(["x"]), { name: "a.txt" })).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("files over 10 MB are refused before any bytes move", async () => {
    const w = world({ manifest, seed: {} });
    const u = w.tab();
    await u.auth.signUp({ email: "h@site.test", password: "password-h" });
    const big = { size: 11 * 1024 * 1024, type: "image/png", name: "big.png" } as unknown as Blob;
    await expect(u.storage.upload("photos", big, { name: "big.png" })).rejects.toMatchObject({ code: "quota" });
  });
});

describe("dev mode: hostile payloads", () => {
  it("a __proto__ key is an unknown field, never a prototype", async () => {
    const w = world();
    const admin = w.tab();
    await admin.auth.signIn({ email: "admin@example.com", password: "preview-admin-1" });
    const { id } = await admin.data.collection("submissions").create({ name: "P", body: "b" });
    const patch = JSON.parse('{"__proto__": {"isAdmin": true}}');
    await expect(admin.data.collection("submissions").update(id, patch)).rejects.toMatchObject({ code: "validation", reason: "schema_violation: unknown field __proto__" });
    await expect(admin.data.collection("submissions").create(JSON.parse('{"name":"P","body":"b","__proto__":{"x":1}}'))).rejects.toMatchObject({ code: "validation" });
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("a NUL character is refused like jsonb refuses it", async () => {
    const z = world().tab();
    await expect(z.data.collection("submissions").create({ name: "P\u0000", body: "b" })).rejects.toMatchObject({ code: "validation" });
  });
});
