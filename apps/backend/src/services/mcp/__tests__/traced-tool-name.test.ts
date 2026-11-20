
import { describe, it, expect } from "vitest";
import { fromAnthropicName, fromTracedToolName, toAnthropicName } from "../types";

describe("fromTracedToolName", () => {
  it("strips the SDK's mcp__server__ wrapper", () => {
    expect(fromTracedToolName("mcp__server__github__search_code")).toEqual({
      server_id: "github",
      tool_name: "search_code",
    });
  });

  it("strips the single-segment mcp__ wrapper (in-process servers)", () => {
    expect(fromTracedToolName("mcp__sandbox__run_bash")).toEqual({
      server_id: "sandbox",
      tool_name: "run_bash",
    });
  });

  it("leaves legacy bare <server>__<tool> names untouched", () => {
    expect(fromTracedToolName("slack__chat_postMessage")).toEqual({
      server_id: "slack",
      tool_name: "chat_postMessage",
    });
  });

  it("returns null for a name with no server segment", () => {
    expect(fromTracedToolName("ToolSearch")).toBeNull();
    expect(fromTracedToolName("")).toBeNull();
  });

  it("preserves a tool-name tail that itself contains the separator", () => {
    expect(fromTracedToolName("mcp__server__jira__issue__transition")).toEqual({
      server_id: "jira",
      tool_name: "issue__transition",
    });
  });

  it("round-trips names built by toAnthropicName", () => {
    const name = toAnthropicName("pipedream_posthog", "query_events");
    expect(fromTracedToolName(name)).toEqual({
      server_id: "pipedream_posthog",
      tool_name: "query_events",
    });
  });

  it("does not spin on a pathological all-wrapper name", () => {
    expect(fromTracedToolName("mcp__server__mcp__server__x")).toEqual({
      server_id: "mcp",
      tool_name: "server__x",
    });
  });

  it("does not strip a bare leading `server__` (a legacy server_id, not a wrapper)", () => {
    expect(fromTracedToolName("server__github__search")).toEqual({
      server_id: "server",
      tool_name: "github__search",
    });
  });

  it("does not strip a provider that merely starts with the wrapper text", () => {
    expect(fromTracedToolName("mcpserver__do_thing")).toEqual({
      server_id: "mcpserver",
      tool_name: "do_thing",
    });
  });

  it("differs from fromAnthropicName exactly where the prod bug was", () => {
    const traced = "mcp__server__github__search_code";
    expect(fromAnthropicName(traced)?.server_id).toBe("mcp");
    expect(fromTracedToolName(traced)?.server_id).toBe("github");
  });
});
