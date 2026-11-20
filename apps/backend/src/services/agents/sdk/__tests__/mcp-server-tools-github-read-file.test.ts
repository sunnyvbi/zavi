import { describe, it, expect } from "vitest";
import { isBackendResidentTool } from "../mcp-server-tools";

describe("isBackendResidentTool", () => {
  it("KEEPS github__read_file — the real GitHub-connector read tool (the bug)", () => {
    expect(isBackendResidentTool("github__read_file")).toBe(true);
  });

  it("keeps the other github read tools that already worked", () => {
    expect(isBackendResidentTool("github__search_code")).toBe(true);
    expect(isBackendResidentTool("github__list_files")).toBe(true);
    expect(isBackendResidentTool("github__list_open_prs")).toBe(true);
  });

  it("still DROPS the sandbox's own read_file / run_bash (served by mcp-sandbox)", () => {
    expect(isBackendResidentTool("sandbox__read_file")).toBe(false);
    expect(isBackendResidentTool("sandbox__write_file")).toBe(false);
    expect(isBackendResidentTool("sandbox__run_bash")).toBe(false);
  });

  it("still drops the legacy daytona server entirely", () => {
    expect(isBackendResidentTool("daytona__read_file")).toBe(false);
    expect(isBackendResidentTool("daytona__run_tests")).toBe(false);
  });

  it("keeps other backend connector tools, and bare/unprefixed names", () => {
    expect(isBackendResidentTool("slack__send_message")).toBe(true);
    expect(isBackendResidentTool("memory__search")).toBe(true);
    expect(isBackendResidentTool("read_file")).toBe(true);
  });
});
