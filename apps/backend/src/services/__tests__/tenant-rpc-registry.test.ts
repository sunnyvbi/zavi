import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const SRC = join(__dirname, "../..");
const ROOTS = [SRC, join(SRC, "../workers")];
const TENANT_CLIENT = join(SRC, "services/tenant-client.ts");

function registeredRpcNames(): Set<string> {
  const src = readFileSync(TENANT_CLIENT, "utf8");
  const body = src.slice(src.indexOf("const RPC_TENANT_ARG"));
  return new Set([...body.matchAll(/^\s{2}([a-z0-9_]+):\s*"/gm)].map((m) => m[1]));
}

const CALL = /(?:(?:tenantRpc|\brpc)\(\s*[A-Za-z0-9_.$]+(?:\([^()]*\))?|(?<![.\w])call\(\s*tenant_id)\s*,\s*"([a-z0-9_]+)"/gs;

function calledRpcNames(): Map<string, string[]> {
  const files = ROOTS.flatMap((root) =>
    execFileSync("grep", ["-rlE", "(tenantRpc|\\brpc|\\bcall)\\(", root, "--include=*.ts"], {
      encoding: "utf8",
    }).split("\n"),
  ).filter((f) => f && !f.includes("__tests__") && !f.endsWith(".test.ts"));

  const found = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(CALL)) {
      const name = m[1];
      found.set(name, [...(found.get(name) ?? []), f.slice(SRC.length + 1)]);

    }
  }
  return found;
}

describe("tenantRpc registry completeness", () => {
  it("every RPC the backend calls through tenantRpc is registered", () => {
    const called = calledRpcNames();
    expect(called.size).toBeGreaterThan(25);

    const registered = registeredRpcNames();
    expect(registered.size).toBeGreaterThan(10);

    const missing = [...called.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, files]) => `${name} (called in ${files.join(", ")})`);

    expect(missing, "unregistered RPCs: tenantRpc throws, and a guarded caller swallows it").toEqual([]);
  });
});
