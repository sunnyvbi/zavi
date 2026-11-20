import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(__dirname, "../..");

const VAULT_BOUNDARY_ALLOWLIST = new Set<string>([
  "services/secrets/vault.ts",
]);

const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /vault\.decrypted_secrets/, label: "direct vault.decrypted_secrets access" },
  { re: /vault\.secrets\b/, label: "direct vault.secrets access" },
  { re: /\.schema\(\s*["'`]vault["'`]\s*\)/, label: '.schema("vault") access' },
  { re: /\.from\(\s*["'`]vault\./, label: 'from("vault.<table>") access' },
  { re: /\.rpc\(\s*["'`]get_secret["'`]/, label: 'raw rpc("get_secret") bypass of getSecret()' },
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walkTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function relSrc(full: string): string {
  return relative(SRC_DIR, full).split("\\").join("/");
}

describe("Vault-access static scan — no direct vault.* / get_secret bypass in app code (C5)", () => {
  it("scans a non-trivial number of source files (sanity)", () => {
    expect(walkTsFiles(SRC_DIR).length).toBeGreaterThan(100);
  });

  it("only services/secrets/vault.ts touches the vault read boundary", () => {
    const violations: string[] = [];
    for (const full of walkTsFiles(SRC_DIR)) {
      const rel = relSrc(full);
      if (rel.includes("__tests__")) continue;
      if (VAULT_BOUNDARY_ALLOWLIST.has(rel)) continue;

      const code = stripComments(readFileSync(full, "utf-8"));
      for (const { re, label } of FORBIDDEN) {
        if (re.test(code)) {
          violations.push(`${rel} — ${label}`);
        }
      }
    }

    expect(
      violations,
      `C5 VAULT-ACCESS VIOLATION — these files bypass the get_secret() boundary. ` +
        `Read secrets via getSecret(tenant_id, key); write via a set_*_connection RPC. ` +
        `NEVER touch vault.* directly:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("the allow-listed boundary file actually uses the sanctioned RPC (anti-vacuous)", () => {
    const vault = readFileSync(join(SRC_DIR, "services/secrets/vault.ts"), "utf-8");
    expect(vault).toMatch(/\.rpc\(\s*["'`]get_secret["'`]/);
    expect(vault).toMatch(/export async function getSecret/);
  });
});
