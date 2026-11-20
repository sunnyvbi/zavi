import { describe, expect, it, vi } from "vitest";
import { createShardMgmt } from "../shard-mgmt";
import { SupabaseMgmtError } from "@/services/sites/supabase-mgmt";

const ENV = { SUPABASE_MGMT_TOKEN: "t", SUPABASE_ORG_ID: "org-sites", SUPABASE_URL: "https://ownprojectrefaaaaaaa.supabase.co" };
const SHARD = "abcdefghijklmnopqrst";
const JWK = { kty: "EC", crv: "P-256", x: "X", y: "Y", d: "PRIVATE-D", kid: "zavi-gw-aaaaaaaa-1" };

function failing(status: number, body: string) {
  const fetchFn = vi.fn(async () => ({ status, text: async () => body }));
  return createShardMgmt({ fetchFn, env: ENV });
}

async function importError(status: number, body: string): Promise<SupabaseMgmtError> {
  const m = failing(status, body);
  const e = await m.importSigningKey(SHARD, { private_jwk: JWK, status: "standby" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SupabaseMgmtError);
  return e as SupabaseMgmtError;
}

describe("shard mgmt: a refused request says why", () => {
  it("carries Supabase's message for a 4xx, with the status", async () => {
    const e = await importError(400, JSON.stringify({ message: "private_jwk.kid: Invalid UUID" }));
    expect(e.status).toBe(400);
    expect(e.message).toBe("supabase signing key import failed (400): private_jwk.kid: Invalid UUID");
  });

  it("never echoes the private key, even if Supabase put it in the message", async () => {
    const e = await importError(400, JSON.stringify({ message: `bad jwk ${JSON.stringify(JWK)}` }));
    expect(e.message).not.toContain("PRIVATE-D");
  });

  it("caps a long message and strips control characters", async () => {
    const e = await importError(422, JSON.stringify({ message: `a\u0000b\nc${"x".repeat(1000)}` }));
    expect(e.message.length).toBeLessThanOrEqual("supabase signing key import failed (422): ".length + 200);
    expect(e.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it("keeps the old message when the body is not JSON or has no message", async () => {
    for (const body of ["<html>oops</html>", "", JSON.stringify({ error: 1 })]) {
      const e = await importError(500, body);
      expect(e.message).toBe("supabase signing key import failed (500)");
    }
  });

  it("never echoes the db password Supabase put back in a refused createProject", async () => {
    const pass = "Zq7-db-pass-k2Lm9";
    const m = failing(400, JSON.stringify({ message: `bad db_pass ${pass}` }));
    const e = await m.createProject({ name: "zavi-shard-01", dbPass: pass, region: "us-east-1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SupabaseMgmtError);
    expect((e as SupabaseMgmtError).message).toContain("bad db_pass");
    expect((e as SupabaseMgmtError).message).not.toContain(pass);
    expect((e as SupabaseMgmtError).message).not.toContain("k2Lm9");
  });

  it("never echoes a secret nested anywhere in a refused patchAuthConfig body", async () => {
    const smtp = "smtp-secret-Hq81xZ";
    const hook = "v1,whsec_hookSecretAbcdef";
    const m = failing(422, JSON.stringify({ message: `rejected ${hook} and ${smtp}; hook ok` }));
    const e = await m
      .patchAuthConfig(SHARD, { smtp_host: "smtp.x.io", nested: { deeper: [{ smtp_pass: smtp }] }, hook_custom_access_token_secrets: hook })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SupabaseMgmtError);
    const msg = (e as SupabaseMgmtError).message;
    expect(msg).not.toContain(smtp);
    expect(msg).not.toContain(hook);
    expect(msg).toContain("hook ok");
  });
});
