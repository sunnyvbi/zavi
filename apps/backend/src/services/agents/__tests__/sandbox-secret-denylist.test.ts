
import { describe, it, expect } from "vitest";
import { isSecretPath, normalizePathForDenylist } from "../sandbox-secret-denylist";

describe("isSecretPath — blocks secret files", () => {
  const blocked = [
    ".env",
    ".env.local",
    ".env.production",
    "config/.env",
    "prod.env",
    "id_rsa",
    "deploy/id_ed25519",
    "server.key",
    "tls/cert.pem",
    "keystore.p12",
    "client.pfx",
    "auth.json",
    "credentials",
    "credentials.json",
    "app.token",
    "db.secret",
    "secrets.json",
    "secrets.yaml",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".pgpass",
    ".htpasswd",
  ];
  for (const p of blocked) {
    it(`blocks ${p}`, () => expect(isSecretPath(p)).toBe(true));
  }
});

describe("isSecretPath — blocks credentials directories", () => {
  const blocked = [
    "~/.aws/credentials",
    "/home/user/.ssh/id_rsa",
    ".gnupg/secring.gpg",
    "project/.kube/config",
    ".azure/accessTokens.json",
    "secrets/prod.yaml",
    ".docker/config.json",
  ];
  for (const p of blocked) {
    it(`blocks ${p}`, () => expect(isSecretPath(p)).toBe(true));
  }
});

describe("isSecretPath — path-form-agnostic (the exfil obfuscations)", () => {
  it("file:// URI", () => expect(isSecretPath("file:///Users/x/.ssh/id_rsa")).toBe(true));
  it("tilde home", () => expect(isSecretPath("~/.aws/credentials")).toBe(true));
  it("backslash separators", () => expect(isSecretPath("config\\.env")).toBe(true));
  it("quoted path", () => expect(isSecretPath('".env"')).toBe(true));
  it("dot-noise traversal", () => expect(isSecretPath("./foo/../.env")).toBe(true));
  it("case-insensitive", () => expect(isSecretPath("SERVER.PEM")).toBe(true));
});

describe("isSecretPath — does NOT false-flag legit dev files", () => {
  const allowed = [
    "package.json",
    "tsconfig.json",
    "src/index.ts",
    "README.md",
    "Dockerfile",
    "docker-compose.yml",
    ".eslintrc.json",
    "public/cert.crt",
    "keys/id_rsa.pub",
    "data/app.sqlite",
    "config.json",
    ".github/workflows/ci.yml",
    "",
  ];
  for (const p of allowed) {
    it(`allows ${JSON.stringify(p)}`, () => expect(isSecretPath(p)).toBe(false));
  }
  it("ignores non-string", () => expect(isSecretPath(undefined as unknown as string)).toBe(false));
});

describe("normalizePathForDenylist", () => {
  it("splits + drops noise", () => {
    expect(normalizePathForDenylist("./a/../b/.env")).toEqual({
      segments: ["a", "b", ".env"],
      basename: ".env",
    });
  });
});
