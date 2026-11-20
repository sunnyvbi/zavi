import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

function effectiveBody(rpc: string): string {
  const startRe = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${rpc}(?![a-z0-9_])`,
    "i",
  );
  let body: string | null = null;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(/--.*$/gm, "");
    const start = startRe.exec(sql);
    if (!start) continue;
    const fromStart = sql.slice(start.index);
    const end = /\$\$\s*;/.exec(fromStart);
    body = end ? fromStart.slice(0, end.index) : fromStart;
  }
  if (!body) throw new Error(`no definition found for ${rpc}`);
  return body.toLowerCase();
}

describe("disconnect vs token-refresh race", () => {
  const disconnect = effectiveBody("disconnect_connector");
  const refresh = effectiveBody("refresh_connector_secrets");

  it("disconnect_connector locks the connector_metadata row before purging secrets", () => {
    const lock = disconnect.indexOf("for update");
    const purge = disconnect.indexOf("delete from vault.secrets");
    expect(lock).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(lock);
  });

  it("refresh_connector_secrets takes the same lock and refuses a disconnected connector", () => {
    const lock = refresh.indexOf("for update");
    const write = refresh.indexOf("vault.create_secret");
    expect(lock).toBeGreaterThan(-1);
    expect(refresh).toMatch(/if\s+not\s+found\s+then\s+raise\s+exception/);
    expect(write).toBeGreaterThan(lock);
  });

  it("matches secret keys by prefix length, not by a LIKE whose _ is a wildcard", () => {
    expect(disconnect).toContain("left(key, length(p_slug) + 1)");
    expect(disconnect).not.toMatch(/key\s+like\s+p_slug/);
  });
});
