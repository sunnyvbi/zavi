import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache } from "../jwt";
import { clearAnonCache, handle } from "../worker";
import { HOST_A, NOW, SHARD_URL, SITE_A, harness, sessionToken, type Harness } from "./helpers";

const REPO_SDK = join(__dirname, "../../../../apps/backend/src/services/provisioning/templates/vite-react-zavi/files/src/zavi/client.ts");
const SDK = process.env.SDK_CLIENT_PATH ? resolve(process.env.SDK_CLIENT_PATH) : REPO_SDK;
const ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
});

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function shard(h: Harness) {
  h.setResponse((c) => {
    if (c.url.endsWith("/rpc/list_records")) return json({ items: [], next_cursor: null });
    if (c.url.endsWith("/rpc/create_record")) return json({ id: ID, replayed: false });
    if (c.url.endsWith("/rpc/update_record")) return json({ id: ID, updated: true });
    if (c.url.endsWith("/rpc/get_record")) return json({ id: ID, data: { a: 1 }, mine: true, created_at: "t", updated_at: "t" });
    if (c.url.includes("/object/upload/sign/") && c.method === "POST") return json({ url: `/object/upload/sign/site-files/${SITE_A}/photos/pic.png?token=up.tok` });
    if (c.url.includes("/object/upload/sign/") && c.method === "PUT") return json({ Key: "k" });
    if (c.url.includes("/object/sign/") && c.method === "POST") return json({ signedURL: `/object/sign/site-files/${SITE_A}/photos/pic.png?token=down.tok` });
    if (c.url.includes("/object/sign/")) return new Response("PNG!", { headers: { "content-type": "image/png" } });
    if (c.url.includes("/object/list/")) return json([]);
    return json({});
  });
}

describe.skipIf(!existsSync(SDK))("real site SDK against the gateway", () => {
  async function client(h: Harness, token: string | null = null) {
    const mod = (await import(pathToFileURL(SDK).href)) as { createZavi: (c: Record<string, unknown>) => any };
    const store = new Map<string, string>();
    if (token) store.set(`zavi.auth.v1:${SITE_A}`, JSON.stringify({ access_token: token, refresh_token: "r", expires_at: NOW / 1000 + 3600, token_type: "bearer" }));
    return mod.createZavi({
      origin: `https://${HOST_A}`,
      now: () => NOW,
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      siteId: async () => {
        const r = await handle(new Request(`https://${HOST_A}/api/site`), h.env, { now: () => NOW, fetch: h.fetch });
        return ((await r.json()) as { data: { site_id: string } }).data.site_id;
      },
      fetch: async (path: string, init: { method: string; headers: Record<string, string>; body?: BodyInit }) =>
        handle(new Request(new URL(path, `https://${HOST_A}`), { method: init.method, headers: { ...init.headers, origin: `https://${HOST_A}` }, body: init.body }), h.env, { now: () => NOW, fetch: h.fetch }),
    });
  }

  it("list / create / get / update / delete round-trip with the SDK's shapes", async () => {
    const h = await harness();
    shard(h);
    const z = await client(h, await sessionToken({}));
    const col = z.data.collection("products");
    await col.list({ filter: { category: "shoes", price: { gte: 10 } }, order: "-price", limit: 20, cursor: btoa("{}") });
    const created = await col.create({ name: "a" }, { idempotencyKey: "idem-key-0123456789abcdef" });
    expect(created).toEqual({ id: ID, replayed: false });
    expect(await col.get(ID)).toMatchObject({ id: ID });
    await col.update(ID, { name: null });
    await col.delete(ID);
    const rpc = h.calls.filter((c) => c.url.includes("/rpc/")).map((c) => [c.url.split("/rpc/")[1], c.body]);
    expect(rpc).toEqual([
      ["list_records", { p_collection: "products", p_filter: { category: "shoes", price: { gte: 10 } }, p_limit: 20, p_cursor: btoa("{}"), p_sort: "-price" }],
      ["create_record", { p_collection: "products", p_data: { name: "a" }, p_idempotency_key: "idem-key-0123456789abcdef" }],
      ["get_record", { p_collection: "products", p_id: ID }],
      ["update_record", { p_collection: "products", p_id: ID, p_patch: { name: null } }],
      ["delete_record", { p_collection: "products", p_id: ID }],
    ]);
  });

  it("anonymous create carries the SDK's auto idempotency key", async () => {
    const h = await harness();
    shard(h);
    const z = await client(h);
    await z.data.collection("bookings").create({ name: "a" });
    const c = h.calls.find((x) => x.url.endsWith("/rpc/create_record"))!;
    expect((c.body as { p_idempotency_key: string }).p_idempotency_key).toMatch(/^[0-9a-f]{48}$/);
  });

  it("storage upload, url and list stay on the site's origin and reach the shard", async () => {
    const h = await harness();
    shard(h);
    const z = await client(h, await sessionToken({}));
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    expect(await z.storage.upload("photos", file, { name: "pic.png" })).toEqual({ name: "pic.png" });
    const put = h.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`${SHARD_URL}/storage/v1/object/upload/sign/site-files/${SITE_A}/photos/pic.png?token=up.tok`);
    const url = await z.storage.url("photos", "pic.png");
    expect(url.startsWith("/api/storage/photos/object/pic.png?t=")).toBe(true);
    const bytes = await handle(new Request(`https://${HOST_A}${url}`), h.env, { now: () => NOW, fetch: h.fetch });
    expect(await bytes.text()).toBe("PNG!");
    expect(await z.storage.list("photos")).toEqual([]);
  });
});

describe("SDK wire shapes (literal, always run)", () => {
  const run = (h: Harness, r: Request) => handle(r, h.env, { now: () => NOW, fetch: h.fetch });
  const sdkHeaders = (extra: Record<string, string> = {}) => ({ accept: "application/json", "content-type": "application/json", ...extra });

  it("create {data} + Idempotency-Key, update {patch}; bare documents are refused", async () => {
    const h = await harness();
    shard(h);
    const tok = await sessionToken({});
    const c = await run(h, new Request(`https://${HOST_A}/api/data/products`, { method: "POST", headers: sdkHeaders({ "idempotency-key": "idem-key-0123456789abcdef" }), body: JSON.stringify({ data: { name: "a" } }) }));
    expect(c.status).toBe(201);
    const u = await run(h, new Request(`https://${HOST_A}/api/data/products/${ID}`, { method: "PATCH", headers: sdkHeaders({ authorization: `Bearer ${tok}` }), body: JSON.stringify({ patch: { name: "b" } }) }));
    expect(u.status).toBe(200);
    for (const [m, path, body] of [
      ["POST", "/api/data/products", { name: "a" }],
      ["POST", "/api/data/products", { data: { name: "a" }, site_id: SITE_A }],
      ["PATCH", `/api/data/products/${ID}`, { name: "b" }],
    ] as const) {
      const r = await run(h, new Request(`https://${HOST_A}${path}`, { method: m, headers: sdkHeaders({ authorization: `Bearer ${tok}`, "idempotency-key": "idem-key-0123456789abcdef" }), body: JSON.stringify(body) }));
      expect(r.status, `${m} ${JSON.stringify(body)}`).toBe(400);
    }
  });
});

const sdkHasKernel = existsSync(SDK) && /\bconst members = \{/.test(readFileSync(SDK, "utf8"));
describe.skipIf(!sdkHasKernel)("real site SDK: kernel v2 routes against the gateway", () => {
  const UID = "55555555-5555-4555-8555-555555555555";
  async function kclient(h: Harness, token: string | null) {
    const mod = (await import(pathToFileURL(SDK).href)) as { createZavi: (c: Record<string, unknown>) => any };
    const store = new Map<string, string>();
    if (token) store.set(`zavi.auth.v1:${SITE_A}`, JSON.stringify({ access_token: token, refresh_token: "r", expires_at: NOW / 1000 + 3600, token_type: "bearer" }));
    return mod.createZavi({
      origin: `https://${HOST_A}`,
      now: () => NOW,
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      siteId: async () => SITE_A,
      fetch: async (path: string, init: { method: string; headers: Record<string, string>; body?: BodyInit }) =>
        handle(new Request(new URL(path, `https://${HOST_A}`), { method: init.method, headers: { ...init.headers, origin: `https://${HOST_A}` }, body: init.body }), h.env, { now: () => NOW, fetch: h.fetch }),
    });
  }

  it("transition / actions.run (forward + inverse) / aggregates.run reach the facade RPCs 1:1", async () => {
    const h = await harness();
    h.setResponse((c) => {
      if (c.url.endsWith("/rpc/transition_record")) return json({ id: ID, from: "pending", to: "accepted", transitioned: true });
      if (c.url.endsWith("/rpc/run_action")) return json({ action: "reserve_slot", target_id: ID, record_id: UID, counter: 1, replayed: false });
      if (c.url.endsWith("/rpc/aggregate")) return json({ value: 3 });
      return json({});
    });
    const z = await kclient(h, await sessionToken({}));
    expect(await z.data.collection("requests").transition(ID, "accepted")).toEqual({ id: ID, from: "pending", to: "accepted", transitioned: true });
    await z.actions.run("reserve_slot", { targetId: ID, data: { note: "x" } }, { idempotencyKey: "idem-key-0123456789abcdef" });
    await z.actions.run("cancel_slot", { recordId: UID }, { idempotencyKey: "idem-key-0123456789abcdeg" });
    expect(await z.aggregates.run("booking_count", { filter: { slot_id: ID } })).toEqual({ value: 3 });
    const rpc = h.calls.filter((c) => c.url.includes("/rpc/")).map((c) => [c.url.split("/rpc/")[1], c.body]);
    expect(rpc).toEqual([
      ["transition_record", { p_collection: "requests", p_id: ID, p_to: "accepted" }],
      ["run_action", { p_action: "reserve_slot", p_target_id: ID, p_record_id: null, p_data: { note: "x" }, p_idempotency_key: "idem-key-0123456789abcdef" }],
      ["run_action", { p_action: "cancel_slot", p_target_id: null, p_record_id: UID, p_data: {}, p_idempotency_key: "idem-key-0123456789abcdeg" }],
      ["aggregate", { p_name: "booking_count", p_filter: { slot_id: ID } }],
    ]);
  });

  it("anonymous actions.run carries the SDK's Turnstile token header and an auto idempotency key", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "ts" } });
    h.setResponse((c) => (c.url.includes("turnstile") ? json({ success: true, hostname: HOST_A }) : json({ counter: 1 })));
    const z = await kclient(h, null);
    await z.actions.run("reserve_slot", { targetId: ID }, { turnstileToken: "solved-token", captchaToken: "solved-token" });
    expect(h.calls.find((c) => c.url.includes("turnstile"))!.body).toMatchObject({ response: "solved-token" });
    const c = h.calls.find((x) => x.url.endsWith("/rpc/run_action"))!;
    expect((c.body as { p_idempotency_key: string }).p_idempotency_key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it.skipIf(!/reassignOwner/.test(readFileSync(SDK, "utf8")))("members.reenableMember / reassignOwner / deleteUserData use the gateway's paths and bodies", async () => {
    const h = await harness();
    const REC = "66666666-6666-4666-8666-666666666666";
    h.setResponse((c) => {
      if (c.url.endsWith("/members-reenable")) return json({ data: { user_id: UID, email: "a@x.com", role: "user", status: "active" } });
      if (c.url.endsWith("/members-reassign-owner")) return json({ data: { id: REC, owner_id: UID } });
      if (c.url.endsWith("/members-delete-data")) return json({ data: { user_id: UID, records: 2, files: 1 } });
      return json({ error: { code: "x" } }, 500);
    });
    const z = await kclient(h, await sessionToken({}));
    expect(await z.members.reenableMember(UID)).toMatchObject({ user_id: UID, status: "active" });
    expect(await z.members.reassignOwner("listings", REC, UID)).toEqual({ id: REC, owner_id: UID });
    expect(await z.members.deleteUserData(UID, { confirm: true })).toEqual({ user_id: UID, records: 2, files: 1 });
    const dec = (b: unknown) => (b instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(b)) : b);
    const calls = h.calls.filter((c) => c.url.startsWith("https://api.zaviagent.com/api/public/site-auth/"));
    expect(calls.map((c) => [c.url.split("/site-auth/")[1], dec(c.body)])).toEqual([
      ["members-reenable", { user_id: UID }],
      ["members-reassign-owner", { collection: "listings", id: REC, to_user_id: UID }],
      ["members-delete-data", { user_id: UID, confirm: true }],
    ]);
  });

  it("members.invite / list / setRole / disable / remove go to the broker as members-<op> with the SDK's bodies", async () => {
    const h = await harness();
    h.setResponse((c) => {
      if (c.url.includes("/members-list")) return json({ data: { items: [{ user_id: UID, email: "a@x.com", role: "user", status: "active" }], next_cursor: null } });
      if (c.url.endsWith("/members-remove")) return json({ data: { user_id: UID, removed: true } });
      return json({ data: { user_id: UID, email: "a@x.com", role: "seller", status: "active" } });
    });
    const z = await kclient(h, await sessionToken({}));
    await z.members.invite({ email: " Sam@X.com ", role: "seller" });
    const page = await z.members.list({ limit: 10, cursor: UID });
    expect(page.items).toHaveLength(1);
    await z.members.setRole(UID, "admin");
    await z.members.disable(UID);
    expect(await z.members.remove(UID)).toEqual({ user_id: UID, removed: true });
    const calls = h.calls.filter((c) => c.url.startsWith("https://api.zaviagent.com/api/public/site-auth/"));
    const dec = (b: unknown) => (b instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(b)) : b);
    expect(calls.map((c) => [c.method, c.url.split("/site-auth/")[1], dec(c.body)])).toEqual([
      ["POST", "members-invite", { email: "Sam@X.com", role: "seller" }],
      ["GET", `members-list?limit=10&cursor=${UID}`, undefined],
      ["POST", "members-set-role", { user_id: UID, role: "admin" }],
      ["POST", "members-disable", { user_id: UID }],
      ["POST", "members-remove", { user_id: UID }],
    ]);
  });
});
