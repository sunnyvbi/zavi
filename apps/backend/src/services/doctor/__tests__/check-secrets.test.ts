import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const secrets: Record<string, string> = {};
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
  SecretsManagerClient: class {
    async send(cmd: { input: { SecretId: string } }) {
      const v = secrets[cmd.input.SecretId];
      if (v === undefined) throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
      return { SecretString: v, CreatedDate: new Date(0) };
    }
  },
}));

import { checkSecrets } from "../run";

describe("checkSecrets", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(secrets)) delete secrets[k];
    process.env.PRAXIS_SECRETS_SECRET_ID = "role-secret";
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("passes when the optional common secret does not exist (prod has none)", async () => {
    secrets["role-secret"] = JSON.stringify({ DOCTOR_TEST_KEY: "x" });
    process.env.DOCTOR_TEST_KEY = "x";
    const r = await checkSecrets();
    expect(r.status).not.toBe("fail");
  });

  it("still fails when the role secret itself is missing", async () => {
    await expect(checkSecrets()).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});
