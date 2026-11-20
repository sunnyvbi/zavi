
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "discovery.ts"),
  "utf-8",
);

describe("mcp/discovery — platform-internal server registration", () => {
  it("imports listPraxisTools from internal/praxis", () => {
    expect(SRC).toMatch(/import \{ listPraxisTools \} from ['"]\.\/internal\/praxis['"]/);
  });

  it("registers 'praxis' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(SRC).toMatch(/server_id:\s*['"]praxis['"]/);
  });

  it("has a branch for server_id='praxis' in listToolsForServer", () => {
    expect(SRC).toMatch(/server\.server_id === ['"]praxis['"]/);
    expect(SRC).toMatch(/tools = listPraxisTools\(\)/);
  });

  it("every platform-internal server import has a matching listToolsForServer branch", () => {
    const imports = [...SRC.matchAll(/from ['"]\.\/internal\/([a-z_]+)['"]/g)].map((m) => m[1]);
    for (const id of imports) {
      const serverId = id.replace(/-/g, "_");
      const hasBranch = new RegExp(`server\\.server_id === ['"]${serverId}['"]`).test(SRC);
      expect(hasBranch, `import internal/${id} but no listToolsForServer branch for server_id='${serverId}'`).toBe(true);
    }
  });
});
