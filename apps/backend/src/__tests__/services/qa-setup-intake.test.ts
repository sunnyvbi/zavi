
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const ROOT = process.cwd();

type VaultKey = {
  key: string;
  label: string;
  input: string;
  required: boolean;
};

function readQaVaultKeys(): VaultKey[] {
  const raw = fs.readFileSync(
    path.join(ROOT, "src", "agents", "qa", "agent.md"),
    "utf-8",
  );
  const fm = matter(raw).data as Record<string, unknown>;
  const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
  const praxis = (meta.praxis as Record<string, unknown> | undefined) ?? {};
  const setup = (praxis.setup as Record<string, unknown> | undefined) ?? {};
  return Array.isArray(setup.vault_keys) ? (setup.vault_keys as VaultKey[]) : [];
}

describe("qa setup intake — vault-key declaration parity (P0-2)", () => {
  const keys = readQaVaultKeys();
  const byKey = new Map(keys.map((k) => [k.key, k]));

  it("declares every key qaGetRuntimeConfig reads", () => {
    const reader = fs.readFileSync(
      path.join(ROOT, "src", "services", "mcp", "internal", "qa-engineer.ts"),
      "utf-8",
    );
    const readKeys = [...reader.matchAll(/safe\("(qa\.[a-z._]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(readKeys.length).toBeGreaterThanOrEqual(5);
    for (const k of readKeys) {
      expect(byKey.has(k), `agent.md must declare vault key ${k}`).toBe(true);
    }
  });

  it("qa.staging_url is the ONLY required key (read-only execution needs nothing else)", () => {
    expect(byKey.get("qa.staging_url")?.required).toBe(true);
    for (const k of keys) {
      if (k.key === "qa.staging_url") continue;
      expect(k.required, `${k.key} must be optional`).toBe(false);
    }
  });

  it("declares sane input types (password fields masked, url field typed)", () => {
    expect(byKey.get("qa.staging_url")?.input).toBe("url");
    expect(byKey.get("qa.guest.password")?.input).toBe("password");
    expect(byKey.get("qa.host.password")?.input).toBe("password");
  });
});

describe("qa setup intake — dispatcher setup gate is mode-aware for qa", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "services", "agents", "generic-dispatcher.ts"),
    "utf-8",
  );

  it("bypasses the hard setup block for every qa run that is NOT weekly-execute-shaped", () => {
    expect(src).toMatch(/ctx\.agent\.slug === "qa"/);
    expect(src).toMatch(/mode !== "weekly-execute"\)\s*break setupGate/);
  });

  it("bypass appears BEFORE the probeSetupCompleteness call (no wasted probe + no recordSetupBlock for drafting runs)", () => {
    const bypassIdx = src.indexOf('mode !== "weekly-execute"');
    const probeIdx = src.indexOf("const setupProbe = await probeSetupCompleteness(");
    expect(bypassIdx).toBeGreaterThan(0);
    expect(probeIdx).toBeGreaterThan(0);
    expect(bypassIdx).toBeLessThan(probeIdx);
  });
});

describe("qa setup intake — worker URL gate emits a blocked digest (never silent)", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "workers", "functions", "qa-weekly-execute.ts"),
    "utf-8",
  );

  it("emits a qa.weekly-digest decision telling the operator to connect their staging site", () => {
    const gate = src.slice(
      src.indexOf("const stagingUrl = await getStagingUrl(tenant.id);"),
      src.indexOf('"blocked: needs URL — qa.staging_url vault key is not set.'),
    );
    expect(gate).toContain('p_decision_class: "qa.weekly-digest"');
    expect(gate).toContain("Blocked: connect your staging site");
  });

  it("emit failure is durable-logged and never blocks the skip outcome", () => {
    expect(src).toContain('code: "blocked_digest_emit_failed"');
  });
});
