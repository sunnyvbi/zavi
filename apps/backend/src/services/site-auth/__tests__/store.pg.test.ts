
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiteAuthError } from "../errors";
import { createShardStore } from "../store";
import type { ShardStore } from "../types";

const URL_ = process.env.SITE_AUTH_TEST_PG_URL;
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const sha = (n: number) => n.toString(16).padStart(64, "0");
const id = (n: number) => `d0000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

describe.skipIf(!URL_)("ShardStore over Postgres (zsite_broker)", () => {
  let c: Client;
  let store: ShardStore;
  beforeAll(async () => {
    c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query("set role zsite_broker");
    store = createShardStore(async (sql, params) => (await c.query(sql, params)).rows);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("signup -> confirm -> identity, with the same outcomes the broker branches on", async () => {
    const email = `pg-${Date.now()}@x.com`;
    const uid = id(Date.now() % 1e12);
    await store.signupRequest({ siteId: A, email, alias: `${uid}@u.test`, uid, challengeId: id(1e11 + (Date.now() % 1e9)), tokenSha256: sha(Date.now()), ttlSeconds: 3600, cooldownSeconds: 0, maxLive: 3 });
    expect(await store.signupConfirmBegin(B, sha(Date.now() - 1), 30)).toEqual({ outcome: "invalid" });
    const rows = await store.outboxClaim(100, 60);
    expect(rows.some((r) => r.to === email && r.kind === "verify_signup" && typeof r.id === "string")).toBe(true);
  });

  it("member admin errors come back as SiteAuthError codes; identity v2 carries the epoch", async () => {
    const owner = "a0000000-0000-4000-8000-0000000000aa";
    const err = await store.memberSetRole(A, "c0000000-0000-4000-8000-000000000999", owner, "user").catch((e) => e);
    expect(err).toBeInstanceOf(SiteAuthError);
    expect((err as SiteAuthError).code).toBe("member_admin_required");
    const last = await store.memberSetRole(A, owner, owner, "user").catch((e) => e);
    expect([(last as SiteAuthError).code]).toContain("last_admin");
    const list = await store.memberList(A, owner, null, 100);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toEqual(expect.objectContaining({ user_id: expect.any(String), email: expect.any(String), role: expect.any(String), status: expect.any(String), created_at: expect.any(String) }));
    await store.revokeSessions(A, owner);
    const ident = await store.identityByUser(owner);
    expect(ident).toMatchObject({ siteId: A, state: "active", role: "admin", memberStatus: "active" });
    expect(typeof ident!.sessionsValidAfter).toBe("number");
  });
});
