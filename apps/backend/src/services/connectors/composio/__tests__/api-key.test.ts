import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getComposioApiKey,
  getComposioMcpServerId,
  getComposioAuthConfigId,
  listComposioToolkits,
  buildComposioMcpUrl,
} from "../api-key";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_MCP_SERVER_ID",
  "COMPOSIO_AUTH_CONFIGS",
] as const;

describe("composio api-key helpers (pure, env-driven)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("getComposioApiKey throws (and references AWS Secrets Manager) when missing", () => {
    expect(() => getComposioApiKey()).toThrow(/COMPOSIO_API_KEY missing/);
    expect(() => getComposioApiKey()).toThrow(/AWS Secrets Manager/);
  });

  it("getComposioMcpServerId throws when missing", () => {
    expect(() => getComposioMcpServerId()).toThrow(/COMPOSIO_MCP_SERVER_ID missing/);
  });

  it("getComposioAuthConfigId returns null without env", () => {
    expect(getComposioAuthConfigId("notion")).toBeNull();
  });

  it("parses COMPOSIO_AUTH_CONFIGS as toolkit=auth_config_id pairs", () => {
    process.env.COMPOSIO_AUTH_CONFIGS = "notion=ac_notion_1, linear=ac_lin_2, HUBSPOT=ac_hs_3";
    expect(getComposioAuthConfigId("notion")).toBe("ac_notion_1");
    expect(getComposioAuthConfigId("LINEAR")).toBe("ac_lin_2");
    expect(getComposioAuthConfigId("hubspot")).toBe("ac_hs_3");
    expect(getComposioAuthConfigId("notconfigured")).toBeNull();
    expect(listComposioToolkits().sort()).toEqual(["hubspot", "linear", "notion"]);
  });

  it("buildComposioMcpUrl produces the verified v3 shape with encoded user_id", () => {
    process.env.COMPOSIO_MCP_SERVER_ID = "srv_abc123";
    const u = buildComposioMcpUrl("tenant-uuid-1234");
    expect(u).toBe(
      "https://backend.composio.dev/v3/mcp/srv_abc123?user_id=tenant-uuid-1234",
    );
  });

  it("buildComposioMcpUrl encodes a hostile tenant id (defense)", () => {
    process.env.COMPOSIO_MCP_SERVER_ID = "srv";
    const u = buildComposioMcpUrl("a b/c?d");
    expect(u.startsWith("https://backend.composio.dev/v3/mcp/srv?user_id=")).toBe(true);
    expect(u).toContain("a%20b%2Fc%3Fd");
  });
});
