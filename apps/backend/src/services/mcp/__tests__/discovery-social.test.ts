
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listSocialTools } from "../internal/social";

const DISCOVERY = readFileSync(join(__dirname, "..", "discovery.ts"), "utf-8");
const EXECUTE = readFileSync(join(__dirname, "..", "execute.ts"), "utf-8");

describe("mcp/discovery — social server registration", () => {
  it("imports listSocialTools from internal/social", () => {
    expect(DISCOVERY).toMatch(/import \{ listSocialTools \} from ['"]\.\/internal\/social['"]/);
  });

  it("registers 'social' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(DISCOVERY).toMatch(/server_id:\s*['"]social['"]/);
  });

  it("has a listToolsForServer branch for server_id='social'", () => {
    expect(DISCOVERY).toMatch(/server\.server_id === ['"]social['"]/);
    expect(DISCOVERY).toMatch(/tools = listSocialTools\(\)/);
  });

  it("has an execute.ts branch for server_id='social' that plumbs emit_decision", () => {
    expect(EXECUTE).toMatch(/server_id === ['"]social['"]/);
    expect(EXECUTE).toMatch(
      /callSocialTool\(\s*\{\s*tenant_id:\s*ctx\.tenant_id,\s*emit_decision:\s*ctx\.emit_decision,/,
    );
    expect(EXECUTE).toMatch(/run_id:\s*ctx\.run_id,\s*agent_slug:\s*ctx\.agent_slug,\s*run_trigger:\s*ctx\.trigger/);
  });

  it("social is wired in BOTH execute.ts and PLATFORM_INTERNAL_SERVERS", () => {
    const inExecute = /server_id === ['"]social['"]/.test(EXECUTE);
    const inPlatform = /server_id:\s*['"]social['"]/.test(DISCOVERY);
    expect(
      inExecute && inPlatform,
      `social must be in BOTH execute.ts (${inExecute}) and PLATFORM_INTERNAL_SERVERS (${inPlatform}) or it is never discovered`,
    ).toBe(true);
  });
});

describe("social MCP server — propose-only invariant", () => {
  it("exposes propose tools and one ledger read, never a publish", () => {
    const names = listSocialTools().map((t) => t.tool_name);
    expect(names).toEqual(["propose_post", "propose_standing_order", "list_posts"]);
    for (const n of names) expect(n).toMatch(/^(propose_|list_)/);
  });

  it("is a separate facade from `growth`, whose zero-write assert must keep holding", () => {
    const GROWTH = readFileSync(join(__dirname, "..", "internal", "growth.ts"), "utf-8");
    expect(GROWTH).not.toMatch(/propose_post|socialProposePostTool/);
  });
});
