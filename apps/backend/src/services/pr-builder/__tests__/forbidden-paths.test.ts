import { describe, it, expect } from "vitest";
import { isForbiddenPath } from "../from-sandbox-fs";

describe("isForbiddenPath — secret/credential file class coverage", () => {
  const forbidden = [
    ".env",
    ".env.local",
    ".env.production",
    "app/.env",
    "apps/web/.env.local",
    ".envrc",
    ".envrc.local",
    "id_rsa",
    "id_ecdsa",
    "id_ed25519",
    "id_dsa",
    "subdir/id_rsa",
    "tls/server.pem",
    "tls/server.key",
    "certs/client.p12",
    "certs/client.pfx",
    "credentials",
    "credentials.json",
    "credentials.yaml",
    "credentials.yml",
    "service-account.json",
    "service_account.json",
    "service-account-prod.json",
    ".aws/credentials",
    ".gcp/application_default.json",
    ".kube/config",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "subdir/.npmrc",
    "supabase/migrations/0001_init.sql",
    ".github/workflows/deploy.yml",
  ];

  const allowed = [
    "README.md",
    "src/index.ts",
    "app/components/Foo.tsx",
    "package.json",
    "env.d.ts",
    "myenv.config.ts",
    "credentials-page.tsx",
    "src/key-utils.ts",
    "supabase/seed.sql",
    ".github/dependabot.yml",
    ".env.example",
    ".env.sample",
    ".env.template",
    "apps/web/.env.example",
  ];

  for (const p of forbidden) {
    it(`rejects forbidden path: ${p}`, () => {
      expect(isForbiddenPath(p)).toBe(true);
    });
  }

  for (const p of allowed) {
    it(`accepts non-forbidden path: ${p}`, () => {
      expect(isForbiddenPath(p)).toBe(false);
    });
  }
});
