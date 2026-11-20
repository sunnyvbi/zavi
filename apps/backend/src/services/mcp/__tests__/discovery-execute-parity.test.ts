
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MCP = join(__dirname, "..");
const DISCOVERY = readFileSync(join(MCP, "discovery.ts"), "utf-8");
const EXECUTE = readFileSync(join(MCP, "execute.ts"), "utf-8");

function executeArms(): Set<string> {
  return new Set([...EXECUTE.matchAll(/server_id === ["']([a-z0-9_]+)["']/g)].map((m) => m[1]));
}

function listableServers(): Set<string> {
  const out = new Set<string>();
  for (const m of DISCOVERY.matchAll(/server\.server_id === ["']([a-z0-9_]+)["']/g)) out.add(m[1]);
  return out;
}

const KNOWN_UNREACHABLE: Record<string, string> = {
  skill: "injected by skill-runtime, never enumerated — by design",

  competitor_intel: "orphaned by the 2026-05-24 fleet cut; no agent declares it",

};

describe("mcp — every executable server must also be discoverable", () => {
  it("no server gains an execute arm without a listToolsForServer arm", () => {
    const listable = listableServers();
    const unreachable = [...executeArms()]
      .filter((s) => !listable.has(s))
      .filter((s) => !(s in KNOWN_UNREACHABLE))
      .sort();

    expect(
      unreachable,
      unreachable.length
        ? `These server_ids can be EXECUTED but never DISCOVERED, so any agent granted their ` +
          `tools silently has no lever: ${unreachable.join(", ")}. Add an import and a ` +
          `listToolsForServer branch in discovery.ts (and, for a credential-free server, a ` +
          `PLATFORM_INTERNAL_SERVERS row). If a server is unreachable on purpose, add it to ` +
          `KNOWN_UNREACHABLE with the reason.`
        : "",
    ).toEqual([]);
  });

  it("KNOWN_UNREACHABLE has no stale entries", () => {
    const listable = listableServers();
    const fixed = Object.keys(KNOWN_UNREACHABLE).filter((s) => listable.has(s));
    expect(
      fixed,
      `now discoverable — delete from KNOWN_UNREACHABLE: ${fixed.join(", ")}`,
    ).toEqual([]);
  });
});

describe("mcp/discovery — paid_acquisition server registration", () => {
  it("imports listPaidAcquisitionTools from internal/paid-acquisition", () => {
    expect(DISCOVERY).toMatch(
      /import \{ listPaidAcquisitionTools \} from ['"]\.\/internal\/paid-acquisition['"]/,
    );
  });

  it("registers 'paid_acquisition' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(DISCOVERY).toMatch(/server_id:\s*['"]paid_acquisition['"]/);
  });

  it("has a listToolsForServer branch for server_id='paid_acquisition'", () => {
    expect(DISCOVERY).toMatch(/server\.server_id === ['"]paid_acquisition['"]/);
    expect(DISCOVERY).toMatch(/tools = listPaidAcquisitionTools\(\)/);
  });

  it("has an execute.ts branch for server_id='paid_acquisition'", () => {
    expect(EXECUTE).toMatch(/server_id === ['"]paid_acquisition['"]/);
  });

  it(
    "exposes get_latest_snapshot under the paid_acquisition server",
    async () => {
      const { listPaidAcquisitionTools } = await import("../internal/paid-acquisition");
      const tools = listPaidAcquisitionTools();
      expect(tools.map((t) => `${t.server_id}__${t.tool_name}`)).toContain(
        "paid_acquisition__get_latest_snapshot",
      );
    },
    20_000,
  );
});
