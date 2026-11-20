
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listGrowthTools } from "../internal/growth";

const DISCOVERY = readFileSync(join(__dirname, "..", "discovery.ts"), "utf-8");
const EXECUTE = readFileSync(join(__dirname, "..", "execute.ts"), "utf-8");

describe("mcp/discovery — growth server registration", () => {
  it("imports listGrowthTools from internal/growth", () => {
    expect(DISCOVERY).toMatch(
      /import \{ listGrowthTools \} from ['"]\.\/internal\/growth['"]/,
    );
  });

  it("registers 'growth' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(DISCOVERY).toMatch(/server_id:\s*['"]growth['"]/);
  });

  it("has a listToolsForServer branch for server_id='growth'", () => {
    expect(DISCOVERY).toMatch(/server\.server_id === ['"]growth['"]/);
    expect(DISCOVERY).toMatch(/tools = listGrowthTools\(\)/);
  });

  it("has an execute.ts branch for server_id='growth'", () => {
    expect(EXECUTE).toMatch(/server_id === ['"]growth['"]/);
    expect(EXECUTE).toMatch(/callGrowthTool\(/);
  });

  it("forwards ctx.run_id into callGrowthTool (provenance contract — codex P1)", () => {
    expect(EXECUTE).toMatch(/callGrowthTool\(ctx\.tenant_id, tool_name, args, ctx\.run_id[,)]/);
    const GROWTH = readFileSync(join(__dirname, "..", "internal", "growth.ts"), "utf-8");
    expect(GROWTH).toMatch(/run_id\?:\s*string/);
    expect(GROWTH).toMatch(/const ctx: ToolContext = \{\s*\.\.\.\(identity \?\? \{\}\),\s*tenant_id,\s*run_id,/);
  });

  it("growth is wired in BOTH execute.ts and PLATFORM_INTERNAL_SERVERS (the plan's grep-guard)", () => {
    const inExecute = /server_id === ['"]growth['"]/.test(EXECUTE);
    const inPlatform = /server_id:\s*['"]growth['"]/.test(DISCOVERY);
    expect(
      inExecute && inPlatform,
      `growth must be in BOTH execute.ts (${inExecute}) and PLATFORM_INTERNAL_SERVERS (${inPlatform}) or it is never discovered`,
    ).toBe(true);
  });
});

describe("growth MCP server — read-only invariant (Codex-C14 boundary)", () => {
  it("exposes exactly 31 tools, all server_id 'growth'", () => {
    const tools = listGrowthTools();
    expect(tools).toHaveLength(31);
    expect(tools.every((t) => t.server_id === "growth")).toBe(true);
  });

  it("has ZERO write tools — every write is a markdown bet → post-run → /approvals", () => {
    const WRITE_HINT = /(draft|create|publish|send|spend|update|delete|post_)/i;
    const offenders = listGrowthTools()
      .map((t) => t.tool_name)
      .filter((n) => WRITE_HINT.test(n));
    expect(
      offenders,
      `growth MCP must hold no callable write tool (found: ${offenders.join(", ")}). Drafts/spend are Tier-1 markdown bets parsed by post-run, never tools.`,
    ).toEqual([]);
  });
});
