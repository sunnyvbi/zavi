import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostedShards, registryRefusal } from "./hosted-stack";

const jwk = JSON.stringify({ ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }), kid: "zavi-gw-test" });
const shard = (p: string, ref: string) => ({
  [`${p}REF`]: ref,
  [`${p}PUBLISHABLE_KEY`]: "sb_publishable_x",
  [`${p}SERVICE_KEY`]: "sb_secret_x",
  [`${p}DB_URL`]: `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`,
  [`${p}BROKER_DB_URL`]: `postgresql://zsite_broker:pw@db.${ref}.supabase.co:5432/postgres`,
  [`${p}HOOK_SECRET`]: "v1,whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  [`${p}SIGNER_JWK`]: jwk,
});
const POOLED = "stagingpooled0000001";
const KERNEL = "stagingkernel0000001";
const ok = () => ({
  ZSI_HOSTED_ENV: "staging",
  ZSI_HOSTED_CONFIRM: `${POOLED},${KERNEL}`,
  ...shard("ZSI_POOLED_", POOLED),
  ...shard("ZSI_KERNEL_", KERNEL),
});

describe("hosted isolation gate safety rails", () => {
  it("builds both shard targets from a complete staging env", () => {
    const { pooled, kernel } = hostedShards(ok());
    expect(pooled).toMatchObject({ ref: POOLED, kind: "pooled", publicUrl: `https://${POOLED}.supabase.co`, baseUrl: `https://${POOLED}.supabase.co` });
    expect(kernel).toMatchObject({ ref: KERNEL, kind: "kernel" });
  });

  it("refuses anything but ZSI_HOSTED_ENV=staging", () => {
    expect(() => hostedShards({ ...ok(), ZSI_HOSTED_ENV: "production" })).toThrow(/staging/);
    expect(() => hostedShards({ ...ok(), ZSI_HOSTED_ENV: undefined })).toThrow(/staging/);
  });

  it("refuses Zavi's own projects (prod, staging, this backend's) as either shard, by ref or by connection string", () => {
    expect(() => hostedShards({ ...ok(), ...shard("ZSI_POOLED_", "wmycgyjsenvgtczlupoe"), ZSI_HOSTED_CONFIRM: `wmycgyjsenvgtczlupoe,${KERNEL}` })).toThrow(/Zavi's own/);
    expect(() => hostedShards({ ...ok(), ...shard("ZSI_POOLED_", "dgzgwclslzzzrjopbobp"), ZSI_HOSTED_CONFIRM: `dgzgwclslzzzrjopbobp,${KERNEL}` })).toThrow(/Zavi's own/);
    expect(() => hostedShards({ ...ok(), SUPABASE_URL: `https://${POOLED}.supabase.co` })).toThrow(/Zavi's own/);
    expect(() => hostedShards({ ...ok(), ZSI_KERNEL_DB_URL: "postgresql://postgres:pw@db.wmycgyjsenvgtczlupoe.supabase.co:5432/postgres" })).toThrow(/Zavi's own/);
  });

  it("refuses DB URLs that do not belong to the named project or role", () => {
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_DB_URL: `postgresql://postgres:pw@db.${KERNEL}.supabase.co:5432/postgres` })).toThrow(/does not connect/);
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_BROKER_DB_URL: `postgresql://postgres:pw@db.${POOLED}.supabase.co:5432/postgres` })).toThrow(/does not connect/);
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_DB_URL: "postgresql://postgres:pw@127.0.0.1:5432/postgres" })).toThrow(/does not connect/);
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_DB_URL: `postgresql://postgres:pw@db.${POOLED}.supabase.co:5432/postgres?host=db.${KERNEL}.supabase.co` })).toThrow(/'host' parameter/);
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_DB_URL: `postgresql://postgres:pw@db.${POOLED}.supabase.co:5432/postgres?user=zsite_broker` })).toThrow(/'user' parameter/);
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_DB_URL: "postgresql://postgres:pw@db.%77mycgyjsenvgtczlupoe.supabase.co:5432/postgres" })).toThrow(/Zavi's own|does not connect/);
    expect(hostedShards({ ...ok(), ZSI_POOLED_DB_URL: `postgresql://postgres:pw@db.${POOLED}.supabase.co:5432/postgres?sslmode=require` }).pooled.ref).toBe(POOLED);
    const pooler = hostedShards({ ...ok(), ZSI_POOLED_DB_URL: `postgresql://postgres.${POOLED}:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres` });
    expect(pooler.pooled.ref).toBe(POOLED);
  });

  it("refuses an unconfirmed, mismatched or reused pair of refs", () => {
    expect(() => hostedShards({ ...ok(), ZSI_HOSTED_CONFIRM: undefined })).toThrow(/CONFIRM/);
    expect(() => hostedShards({ ...ok(), ZSI_HOSTED_CONFIRM: `${KERNEL},${POOLED}` })).toThrow(/CONFIRM/);
    expect(() => hostedShards({ ...ok(), ...shard("ZSI_KERNEL_", POOLED), ZSI_HOSTED_CONFIRM: `${POOLED},${POOLED}` })).toThrow(/different project/);
  });

  it("refuses a missing value or a public signer key", () => {
    expect(() => hostedShards({ ...ok(), ZSI_POOLED_SERVICE_KEY: "" })).toThrow(/ZSI_POOLED_SERVICE_KEY/);
    const pub = JSON.stringify({ ...generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }), kid: "k" });
    expect(() => hostedShards({ ...ok(), ZSI_KERNEL_SIGNER_JWK: pub })).toThrow(/private EC P-256/);
  });

  it("only a staging validation shard that placement can never pick is usable", () => {
    const ok1 = { env: "dev", purpose: "validation", state: "full", dedicated_site_id: null };
    expect(registryRefusal(POOLED, [ok1])).toBeNull();
    expect(registryRefusal(POOLED, [{ ...ok1, state: "draining" }])).toBeNull();
    expect(registryRefusal(POOLED, [{ ...ok1, purpose: "pool" }])).toMatch(/not a validation shard/);
    expect(registryRefusal(POOLED, [{ ...ok1, purpose: undefined }])).toMatch(/not a validation shard/);
    expect(registryRefusal(POOLED, [{ ...ok1, state: "open" }])).toMatch(/state open/);
    expect(registryRefusal(POOLED, [{ ...ok1, state: "retired" }])).toMatch(/state retired/);
    expect(registryRefusal(POOLED, [{ ...ok1, state: "provisioning" }])).toMatch(/state provisioning/);
    expect(registryRefusal(POOLED, [{ ...ok1, env: "prod" }])).toMatch(/env prod/);
    expect(registryRefusal(POOLED, [{ ...ok1, dedicated_site_id: "11111111-1111-4111-8111-111111111111" }])).toMatch(/dedicated/);
    expect(registryRefusal(POOLED, [])).toMatch(/not registered/);
    expect(registryRefusal(POOLED, null)).toMatch(/not registered/);
    expect(registryRefusal(POOLED, [ok1, ok1])).toMatch(/not registered/);
  });
});
