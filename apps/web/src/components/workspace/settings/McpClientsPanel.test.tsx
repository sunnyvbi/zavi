// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ pats: [] }) })),
}));

import { McpClientsPanel } from "./McpClientsPanel";

const html = (props: { showTokens?: boolean } = {}) =>
  renderToStaticMarkup(React.createElement(McpClientsPanel, props));

describe("McpClientsPanel", () => {
  it("renders without throwing", () => {
    expect(typeof html()).toBe("string");
  });

  it("shows the live MCP server URL", () => {
    expect(html()).toContain("https://api.zaviagent.com/mcp");
  });

  it("does NOT reference the dead thepraxis.ai domain", () => {
    expect(html()).not.toContain("thepraxis.ai");
  });

  it("gives a copy-pasteable Claude Code command", () => {
    expect(html()).toContain("claude mcp add --transport http zavi");
  });

  it("names all three supported clients", () => {
    const out = html();
    for (const client of ["Claude Code", "claude.ai", "ChatGPT"]) {
      expect(out).toContain(client);
    }
  });

  it("lists the tools the server advertises", () => {
    const out = html();
    for (const tool of [
      "zavi_ask",
      "zavi_list_agents",
      "zavi_run_agent",
      "zavi_get_run_status",
      "zavi_recent_runs",
      "zavi_read_brain",
      "zavi_search",
      "zavi_fetch",
      "zavi_next_step",
      "zavi_mark_step_done",
      "zavi_report_number",
    ]) {
      expect(out).toContain(tool);
    }
  });

  it("leads with the no-credential OAuth path, not tokens", () => {
    const out = html();
    expect(out.indexOf("Connect your AI client")).toBeLessThan(out.indexOf("Access tokens"));
  });

  it("hides the whole token surface when showTokens is false", () => {
    const out = html({ showTokens: false });
    expect(out).toContain("Connect your AI client");
    expect(out).toContain("https://api.zaviagent.com/mcp");
    for (const s of ["Access tokens", "New token", "No tokens yet", "treat it like a password", "pat-name"]) {
      expect(out).not.toContain(s);
    }
  });
});

describe("McpClientsPanel layout", () => {
  const view = () => render(React.createElement(McpClientsPanel, { showTokens: false }));
  afterEach(cleanup);

  it("shows the connection URL once, in its own copy field, instead of repeating it in every client", () => {
    view();
    const hero = screen.getByTestId("mcp-url-hero");
    expect(within(hero).getByTestId("mcp-copy-field").textContent).toContain("https://api.zaviagent.com/mcp");
    const urlFields = screen.getAllByTestId("mcp-copy-field").filter((f) => f.textContent === "https://api.zaviagent.com/mcp");
    expect(urlFields).toHaveLength(1);
  });

  it("switches one client panel at a time from a tab row, and keeps Claude Code's command in its own copy field", () => {
    view();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Claude Code", "claude.ai", "ChatGPT", "Other app"]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    const code = within(screen.getByTestId("mcp-client-claude-code")).getByTestId("mcp-copy-field");
    expect(code.textContent).toContain("claude mcp add --transport http zavi https://api.zaviagent.com/mcp");
    expect(within(code).getByRole("button").getAttribute("aria-label")).toBe("Copy Claude Code command");
    fireEvent.click(screen.getByTestId("mcp-tab-chatgpt"));
    expect(screen.getByTestId("mcp-tab-chatgpt").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("mcp-client-claude-code")).toBeNull();
    expect(screen.getByTestId("mcp-client-chatgpt").querySelectorAll("ol > li").length).toBe(3);
  });

  it("draws a menu path as chips joined by a visible chevron, not a thin › character", () => {
    view();
    fireEvent.click(screen.getByTestId("mcp-tab-claude-ai"));
    const path = screen.getByTestId("mcp-menu-path");
    expect(path.textContent).toBe("SettingsConnectorsAdd custom connector");
    const seps = within(path).getAllByTestId("mcp-path-sep");
    expect(seps).toHaveLength(2);
    expect(seps[0]!.getAttribute("class")).toMatch(/h-4 w-4/);
    expect(screen.getByTestId("mcp-client-claude-ai").textContent).not.toContain("›");
  });

  it("opens the tools list from a right-hand chevron, not the browser's triangle", () => {
    view();
    const summary = screen.getByTestId("mcp-tools").querySelector("summary")!;
    expect(summary.className).toContain("list-none");
    expect(summary.lastElementChild!.getAttribute("class")).toContain("group-open/tools:rotate-90");
  });
});
