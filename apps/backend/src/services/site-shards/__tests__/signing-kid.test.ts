import { describe, expect, it } from "vitest";
import { isZaviSigningKid, nextSigningKid, provisionShard, shardSigningKid, SIGNING_KID_SLOTS } from "../provision";
import { world } from "./provision-world";

const SHARD = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("shard signing kid", () => {
  it("is a v4-layout UUID, stable per (shard, slot), different across slots and shards", () => {
    const a = shardSigningKid(SHARD, 0);
    expect(a).toMatch(UUID_V4);
    expect(shardSigningKid(SHARD, 0)).toBe(a);
    expect(shardSigningKid(SHARD, 1)).not.toBe(a);
    expect(shardSigningKid("bbbbbbbb-0000-4000-8000-000000000002", 0)).not.toBe(a);
    expect(() => shardSigningKid(SHARD, SIGNING_KID_SLOTS)).toThrow();
    expect(() => shardSigningKid(SHARD, -1)).toThrow();
  });

  it("recognises derived kids and legacy prefix kids as Zavi's; a foreign UUID or another shard's kid is not", () => {
    expect(isZaviSigningKid(SHARD, shardSigningKid(SHARD, 7))).toBe(true);
    expect(isZaviSigningKid(SHARD, "zavi-gw-aaaaaaaa-1759390000000")).toBe(true);
    expect(isZaviSigningKid(SHARD, "678056fc-2815-466b-a9a1-7ac168638f67")).toBe(false);
    expect(isZaviSigningKid(SHARD, shardSigningKid("bbbbbbbb-0000-4000-8000-000000000002", 0))).toBe(false);
    expect(isZaviSigningKid(SHARD, "zavi-gw-aaaaaaaa")).toBe(false);
    expect(isZaviSigningKid(SHARD, null)).toBe(false);
  });

  it("nextSigningKid takes the first slot not on the project, null when all are used", () => {
    expect(nextSigningKid(SHARD, [])).toBe(shardSigningKid(SHARD, 0));
    expect(nextSigningKid(SHARD, [shardSigningKid(SHARD, 0), null, "x"])).toBe(shardSigningKid(SHARD, 1));
    const all = Array.from({ length: SIGNING_KID_SLOTS }, (_, n) => shardSigningKid(SHARD, n));
    expect(nextSigningKid(SHARD, all)).toBeNull();
  });
});

describe("provisionShard signing_key step", () => {
  it("imports a UUID kid (slot 0), puts the SAME kid on the signer, and leaves the project's own key alone", async () => {
    const w = world();
    await w.deps.mgmt.importSigningKey("x", { private_jwk: { kid: "678056fc-2815-466b-a9a1-7ac168638f67" }, status: "in_use" });
    const signerKids: string[] = [];
    const put = w.deps.signer!.put.bind(w.deps.signer);
    w.deps.signer = { ...w.deps.signer!, put: async (ref, jwk) => (signerKids.push(String(jwk.kid)), put(ref, jwk)) };
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    const ours = w.keys.find((k) => k.kid === shardSigningKid(SHARD, 0));
    expect(ours?.status).toBe("in_use");
    expect(signerKids).toEqual([shardSigningKid(SHARD, 0)]);
    expect(w.keys.find((k) => k.kid === "678056fc-2815-466b-a9a1-7ac168638f67")?.status).toBe("in_use");
  });

  it("a lost import response (slot-0 key left standby) is recovered: slot 1 is imported and slot 0 revoked", async () => {
    const w = world();
    await provisionShard({ ...w.deps, signer: null }, { env: "dev", n: 1, region: "us-west-1" });
    await w.deps.mgmt.importSigningKey("x", { private_jwk: { kid: shardSigningKid(SHARD, 0) }, status: "standby" });
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.keys.map((k) => [k.kid, k.status])).toEqual([
      [shardSigningKid(SHARD, 0), "revoked"],
      [shardSigningKid(SHARD, 1), "in_use"],
    ]);
  });

  it("a shard whose Zavi key is already current (legacy prefix kid) imports nothing", async () => {
    const w = world();
    await provisionShard({ ...w.deps, signer: null }, { env: "dev", n: 1, region: "us-west-1" });
    w.keys.push({ id: "legacy", kid: "zavi-gw-aaaaaaaa-1", algorithm: "ES256", status: "in_use" });
    const before = w.log.filter((l) => l.startsWith("import:")).length;
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.log.filter((l) => l.startsWith("import:")).length).toBe(before);
  });

  it("blocks (no import) when every kid slot is already on the project", async () => {
    const w = world();
    await provisionShard({ ...w.deps, signer: null }, { env: "dev", n: 1, region: "us-west-1" });
    for (let n = 0; n < SIGNING_KID_SLOTS; n++) {
      await w.deps.mgmt.importSigningKey("x", { private_jwk: { kid: shardSigningKid(SHARD, n) }, status: "revoked" as never });
    }
    const imports = w.log.filter((l) => l.startsWith("import:")).length;
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r).toMatchObject({ status: "blocked", step: "signing_key" });
    expect(w.log.filter((l) => l.startsWith("import:")).length).toBe(imports);
  });
});
