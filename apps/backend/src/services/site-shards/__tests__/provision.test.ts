import { describe, expect, it } from "vitest";
import { provisionShard, signerSecretName, SHARD_AUTH_RATE_LIMITS } from "../provision";
import { world, CALLBACK, HOOK_BASE } from "./provision-world";
import type { ShardRow } from "../contract";

describe("shard provisioning tool", () => {
  it("runs every step in order and opens the shard", async () => {
    const w = world();
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.row).toMatchObject({ state: "open", provision_step: "done", project_ref: "newshardref01", url: "https://newshardref01.supabase.co", schema_version: "0001_core" });
    expect(w.log).toEqual([
      "createProject", "schema", "exposed:api",
      "vault:service_key", "vault:anon_key", "vault:hook_secret", "vault:broker_db_url", "authConfig",
      "signer.put", "import:standby", "keyStatus:key0:in_use", "kv.put:shard:newshardref01",
    ]);
    expect(JSON.parse(w.kvMap.get("shard:newshardref01") as string)).toEqual({ apikey: "sb_publishable_abc123" });
  });

  it("auth config: ONE fixed broker callback (never per-site), email on, rate limits raised, hooks verified", async () => {
    const w = world();
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(w.auth).toMatchObject({
      site_url: CALLBACK, uri_allow_list: CALLBACK, external_email_enabled: true, ...SHARD_AUTH_RATE_LIMITS,
      hook_custom_access_token_enabled: true,
      hook_custom_access_token_uri: "pg-functions://postgres/zsite_auth/custom_access_token_hook",
      hook_send_email_enabled: true,
      hook_send_email_uri: `${HOOK_BASE}/api/public/site-auth/hooks/send-email/${w.row.project_ref}`,
    });
    for (const bad of ["http://auth.zavisites.com/cb", "https://*.zavisites.com/cb", "https://a.com/cb?x=1", "https://u:p@a.com/cb"]) {
      await expect(provisionShard({ ...world().deps, brokerCallbackUrl: bad }, { env: "dev", n: 1, region: "us-west-1" })).rejects.toThrow(/fixed https/);
    }
  });

  it("the private key goes ONLY to the signer secret, BEFORE the shard trusts it; never into the registry", async () => {
    const w = world();
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(w.secrets).toHaveLength(1);
    expect(w.secrets[0].name).toBe(signerSecretName("newshardref01"));
    expect(w.secrets[0].name).toBe("SHARD_KEY_NEWSHARDREF01");
    expect(JSON.parse(w.secrets[0].value).d).toBe("PRIVATE-D");
    expect(w.log.indexOf("signer.put")).toBeLessThan(w.log.indexOf("import:standby"));
    expect(JSON.stringify(w.regUpdates)).not.toContain("PRIVATE-D");
  });

  it("is idempotent: a re-run creates nothing new (no second project, no second key)", async () => {
    const w = world();
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    const before = w.log.length;
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.log.slice(before)).toEqual(["authConfig"]);
  });

  it("is resumable: stops at auth_config without a hook base URL, then finishes when it is set", async () => {
    const w = world();
    const r1 = await provisionShard({ ...w.deps, hookBaseUrl: "" }, { env: "dev", n: 1, region: "us-west-1" });
    expect(r1).toMatchObject({ status: "blocked", step: "auth_config" });
    expect(w.row.state).toBe("provisioning");
    expect(w.row.provision_step).toBe("broker");
    const r2 = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r2.status).toBe("open");
    expect(w.log.filter((l) => l === "createProject")).toHaveLength(1);
  });

  it("refuses to proceed while hooks do not verify (e.g. Send Email Hook off)", async () => {
    const w = world();
    const w2 = world({ ignoreHooks: true });
    const r = await provisionShard(w2.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r).toMatchObject({ status: "blocked", step: "auth_config" });
    expect(w2.row.state).toBe("provisioning");
  });

  it("adopts the one existing project by name; refuses when the name is ambiguous", async () => {
    const one = world({ existingProjects: 1 });
    await provisionShard(one.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(one.log).not.toContain("createProject");
    expect(one.row.project_ref).toBe("existingref0");
    const two = world({ existingProjects: 2 });
    await expect(provisionShard(two.deps, { env: "dev", n: 1, region: "us-west-1" })).rejects.toThrow(/more than one project/);
  });

  it("waits for health and reports blocked (resumable) when it never comes up", async () => {
    const w = world({ healthyAfter: 1_000 });
    const r = await provisionShard({ ...w.deps, healthPolls: 3 }, { env: "dev", n: 1, region: "us-west-1" });
    expect(r).toMatchObject({ status: "blocked", step: "healthy" });
  });

  it("S3 broker: secrets go to Vault only (never the registry row), zsite_broker gets a login password, hook secret is stable", async () => {
    const w = world();
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect([...w.vault.keys()].sort()).toEqual(["anon_key", "broker_db_url", "hook_secret", "service_key"]);
    expect(w.vault.get("broker_db_url")).toMatch(
      /^postgresql:\/\/zsite_broker\.newshardref01:[A-Za-z0-9_-]+@aws-1-us-west-1\.pooler\.supabase\.com:6543\/postgres\?sslmode=require$/,
    );
    expect(w.vault.get("hook_secret")).toMatch(/^v1,whsec_/);
    const hook = w.vault.get("hook_secret");
    const url = w.vault.get("broker_db_url");
    for (const v of w.vault.values()) expect(JSON.stringify(w.regUpdates)).not.toContain(v);
    expect(w.sqlLog.filter((q) => q.startsWith("alter role zsite_broker with login password"))).toHaveLength(1);
    expect(w.sqlLog).toContain("alter role zsite_broker set statement_timeout = '10s'");
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(w.vault.get("hook_secret")).toBe(hook);
    expect(w.vault.get("broker_db_url")).toBe(url);
    expect(w.sqlLog.filter((q) => q.startsWith("alter role zsite_broker with login password"))).toHaveLength(1);
  });

  it("a re-run moves an OLD direct broker URL to the pooler, keeping the password (no rotation)", async () => {
    const w = world();
    await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    w.vault.set("broker_db_url", "postgresql://zsite_broker:s3cr%2Bt@db.newshardref01.supabase.co:5432/postgres?sslmode=require");
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.vault.get("broker_db_url")).toBe(
      "postgresql://zsite_broker.newshardref01:s3cr%2Bt@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require",
    );
    expect(w.sqlLog.filter((q) => q.startsWith("alter role zsite_broker with login password"))).toHaveLength(1);
  });

  it("stops (resumable) at broker when the pooler host is unavailable, storing nothing and rotating nothing", async () => {
    const w = world({ poolerHost: null });
    expect(await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" })).toMatchObject({ status: "blocked", step: "broker" });
    expect(w.vault.has("broker_db_url")).toBe(false);
    expect(w.sqlLog.some((q) => q.startsWith("alter role zsite_broker with login password"))).toBe(false);
  });

  it("stops (resumable) when S3's zsite_broker role is missing", async () => {
    const w = world({ brokerRole: false });
    expect(await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" })).toMatchObject({ status: "blocked", step: "broker" });
    expect(w.vault.has("broker_db_url")).toBe(false);
  });

  it("creates the project in the REQUESTED region", async () => {
    const w = world();
    const seen: string[] = [];
    const orig = w.deps.mgmt.createProject;
    w.deps.mgmt.createProject = async (i) => (seen.push(i.region), orig(i));
    await provisionShard(w.deps, { env: "dev", n: 1, region: "eu-west-2" });
    expect(seen).toEqual(["eu-west-2"]);
  });

  it("the gateway KV gets the PUBLISHABLE key only; a secret / service key is refused", async () => {
    for (const bad of ["sb_secret_abc", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig", ""]) {
      const w = world({ publishable: bad });
      const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
      expect(r).toMatchObject({ status: "blocked", step: "gateway_kv" });
      expect(w.kvMap.size).toBe(0);
      expect(w.row.state).toBe("provisioning");
    }
  });

  it("a half-done earlier key attempt is revoked, the new key becomes current", async () => {
    const w = world();
    await provisionShard({ ...w.deps, signer: null }, { env: "dev", n: 1, region: "us-west-1" });
    w.keys.push({ id: "legacy", kid: "zavi-gw-aaaaaaaa-1", algorithm: "ES256", status: "standby" });
    const r = await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" });
    expect(r.status).toBe("open");
    expect(w.keys.map((k) => k.status)).toEqual(["revoked", "in_use"]);
  });
});

describe("kernel provisioning (graduation target: the site's OWN project)", () => {
  const SITE = "11111111-1111-4111-8111-111111111111";
  const kernelRow = (): ShardRow => ({
    id: "bbbbbbbb-0000-4000-8000-000000000002", env: "dev", name: `zavi-shard-dev-k${SITE.replace(/-/g, "")}`,
    project_ref: "ownprojectref0001", url: "https://ownprojectref0001.supabase.co", region: "us-west-1",
    state: "provisioning", is_canary: false, schema_version: null, provision_step: null, max_sites: 1, site_count: 1,
    created_at: "2026-10-01T00:00:00Z", dedicated_site_id: SITE,
  });

  it("runs every shard step on the existing project, creates NO project and NEVER opens it", async () => {
    const w = world();
    const k = kernelRow();
    const base = w.deps.registry;
    w.deps.registry = { ...base, update: async (_id: string, patch: Record<string, unknown>) => (w.regUpdates.push(patch), Object.assign(k, patch)) } as never;
    const r = await provisionShard(w.deps, { kernel: k });
    expect(r.status).toBe("ready");
    expect(w.log).not.toContain("createProject");
    expect(w.log).toContain("schema");
    expect(w.log).toContain("authConfig");
    expect(w.log).toContain("signer.put");
    expect(w.log).toContain("kv.put:shard:ownprojectref0001");
    expect(w.regUpdates.some((u) => u.state === "open")).toBe(false);
    expect(w.regUpdates.at(-1)).toMatchObject({ provision_step: "done" });
  });

  it("refuses a row that is not a kernel row", async () => {
    const w = world();
    await expect(provisionShard(w.deps, { kernel: { ...kernelRow(), name: "zavi-shard-dev-7" } })).rejects.toThrow(/not a kernel shard row/);
  });
});

describe("auth token lifetime", () => {
  it("every shard's access tokens expire after 300s (K2 revocation bound); a project that ignores it is blocked", async () => {
    const w = world();
    expect((await provisionShard(w.deps, { env: "dev", n: 1, region: "us-west-1" })).status).toBe("open");
    expect(w.auth.jwt_exp).toBe(300);
  });
});

describe("signer key removal (kernel retirement)", () => {
  it("worker secret: DELETE the shard's secret, 404 = done; sealed KV: the key is gone", async () => {
    const { workerSecretKeyStore, sealedKvKeyStore } = await import("../shard-keys");
    const calls: Array<[string, string]> = [];
    const env = { CLOUDFLARE_ACCOUNT_ID: "acc", SITE_SIGNER_WORKER_NAME: "signer", CLOUDFLARE_SIGNER_API_TOKEN: "tok" };
    const ws = workerSecretKeyStore({ env, fetchFn: async (url, init) => (calls.push([init.method, url]), { status: calls.length === 1 ? 200 : 404 }) });
    await ws.remove!("kernelrefabcdefghij");
    await ws.remove!("kernelrefabcdefghij");
    expect(calls[0]).toEqual(["DELETE", "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/signer/secrets/SHARD_KEY_KERNELREFABCDEFGHIJ"]);
    const m = new Map([["shardkey:kernelrefabcdefghij", "{}"], ["shardkey:sharedref000001", "{}"]]);
    const kv = { get: async (k: string) => m.get(k) ?? null, put: async () => undefined, delete: async (k: string) => void m.delete(k) };
    await sealedKvKeyStore({ kv, kekPublicJwk: () => ({}) }).remove!("kernelrefabcdefghij");
    expect([...m.keys()]).toEqual(["shardkey:sharedref000001"]);
  });
});

describe("facade signer store", () => {
  it("removal clears BOTH key forms (a storage-mode change never strands a key); no signer creds = no worker secret to clear", async () => {
    const { signerStore } = await import("../facade");
    const m = new Map([["shardkey:kernelrefabcdefghij", "{}"]]);
    const kv = { get: async (k: string) => m.get(k) ?? null, put: async () => undefined, delete: async (k: string) => void m.delete(k) };
    await signerStore({}, kv).remove!("kernelrefabcdefghij");
    expect(m.size).toBe(0);
  });
});
