import { describe, it, expect, afterEach } from "vitest";
import {
  assertStreamableUrlAllowed,
  allowedStreamableHosts,
  redactSecrets,
  EgressBlockedError,
  encodeRemoteToolName,
  decodeRemoteToolName,
} from "../streamable-guards";

describe("allowedStreamableHosts — default", () => {
  const prevFresh = process.env.STREAMABLE_MCP_HOSTS;
  const prevLegacy = process.env.COMPOSIO_MCP_HOSTS;
  afterEach(() => {
    if (prevFresh === undefined) delete process.env.STREAMABLE_MCP_HOSTS;
    else process.env.STREAMABLE_MCP_HOSTS = prevFresh;
    if (prevLegacy === undefined) delete process.env.COMPOSIO_MCP_HOSTS;
    else process.env.COMPOSIO_MCP_HOSTS = prevLegacy;
  });

  it("allowlists the verified Composio v3 MCP host by default", () => {
    delete process.env.COMPOSIO_MCP_HOSTS;
    delete process.env.STREAMABLE_MCP_HOSTS;
    const hosts = allowedStreamableHosts();
    expect(hosts.has("backend.composio.dev")).toBe(true);
    expect(
      assertStreamableUrlAllowed("https://backend.composio.dev/v3/mcp/abc?user_id=u1").host,
    ).toBe("backend.composio.dev");
  });

  it("allowlists the Higgsfield MCP host by default (2026-05-24)", () => {
    delete process.env.COMPOSIO_MCP_HOSTS;
    delete process.env.STREAMABLE_MCP_HOSTS;
    expect(allowedStreamableHosts().has("mcp.higgsfield.ai")).toBe(true);
    expect(
      assertStreamableUrlAllowed("https://mcp.higgsfield.ai/mcp").host,
    ).toBe("mcp.higgsfield.ai");
  });

  it("reads the legacy COMPOSIO_MCP_HOSTS name as a fallback shim", () => {
    delete process.env.STREAMABLE_MCP_HOSTS;
    process.env.COMPOSIO_MCP_HOSTS = "self.example.com";
    const hosts = allowedStreamableHosts();
    expect(hosts.has("self.example.com")).toBe(true);
    expect(hosts.has("mcp.higgsfield.ai")).toBe(true);
  });

  it("STREAMABLE_MCP_HOSTS wins over the legacy name when both set", () => {
    process.env.STREAMABLE_MCP_HOSTS = "fresh.example.com";
    process.env.COMPOSIO_MCP_HOSTS = "legacy.example.com";
    const hosts = allowedStreamableHosts();
    expect(hosts.has("fresh.example.com")).toBe(true);
    expect(hosts.has("legacy.example.com")).toBe(false);
  });

  it("still blocks an unknown host after the rename (fail closed)", () => {
    process.env.STREAMABLE_MCP_HOSTS = "self.example.com";
    expect(() =>
      assertStreamableUrlAllowed("https://evil.example.com/x", allowedStreamableHosts()),
    ).toThrow(EgressBlockedError);
  });
});

describe("redactSecrets — secret-shaped strings never persist", () => {
  it("redacts a Bearer token", () => {
    const out = redactSecrets('{"message":"401 Authorization: Bearer hf_abc.DEF-123_xyz failed"}');
    expect(out).not.toContain("hf_abc.DEF-123_xyz");
    expect(out).toContain("[redacted]");
  });

  it("redacts header-shaped api keys + vault key names", () => {
    expect(redactSecrets("x-api-key: sk_live_abcdef123456")).not.toContain("sk_live_abcdef123456");
    expect(redactSecrets("read higgsfield.access_token from vault")).toContain("[redacted]");
    expect(redactSecrets("composio.api_key missing")).toContain("[redacted]");
  });

  it("leaves benign content untouched", () => {
    const benign = '{"status":"ok","video":"https://cdn.example.com/v/123.mp4"}';
    expect(redactSecrets(benign)).toBe(benign);
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});

const ALLOW = new Set(["mcp.composio.dev"]);

describe("assertStreamableUrlAllowed — egress allowlist", () => {
  it("allows the allowlisted https host", () => {
    const u = assertStreamableUrlAllowed("https://mcp.composio.dev/v1/abc", ALLOW);
    expect(u.host).toBe("mcp.composio.dev");
  });

  it("rejects a non-allowlisted host (even https)", () => {
    expect(() => assertStreamableUrlAllowed("https://evil.example.com/x", ALLOW)).toThrow(
      EgressBlockedError,
    );
  });

  it("rejects the IMDS internal IP", () => {
    expect(() => assertStreamableUrlAllowed("https://169.254.169.254/latest/meta-data", ALLOW)).toThrow(
      EgressBlockedError,
    );
  });

  it("rejects localhost + RFC1918", () => {
    expect(() => assertStreamableUrlAllowed("https://127.0.0.1:4000/", ALLOW)).toThrow(EgressBlockedError);
    expect(() => assertStreamableUrlAllowed("https://10.0.0.5/", ALLOW)).toThrow(EgressBlockedError);
  });

  it("rejects non-https even on the allowlisted host", () => {
    expect(() => assertStreamableUrlAllowed("http://mcp.composio.dev/x", ALLOW)).toThrow(EgressBlockedError);
  });

  it("rejects an unparseable url (fail closed)", () => {
    expect(() => assertStreamableUrlAllowed("not a url", ALLOW)).toThrow(EgressBlockedError);
  });
});

describe("remote tool-name codec — reversible", () => {
  it("passes through already-safe UPPER_SNAKE names (common Composio case)", () => {
    expect(encodeRemoteToolName("GITHUB_CREATE_AN_ISSUE")).toBe("GITHUB_CREATE_AN_ISSUE");
    expect(encodeRemoteToolName("notion_search")).toBe("notion_search");
  });

  it("round-trips names with dots, slashes, spaces, colons", () => {
    for (const raw of ["notion.search", "a/b/c", "hello world", "ns:tool", "weird.tool/v2 name"]) {
      const enc = encodeRemoteToolName(raw);
      expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeRemoteToolName(enc)).toBe(raw);
    }
  });

  it("round-trips a literal hyphen", () => {
    const raw = "tool-with-dashes";
    expect(decodeRemoteToolName(encodeRemoteToolName(raw))).toBe(raw);
  });
});
