// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { PaneViewSwitch } from "./PaneViewSwitch";

afterEach(cleanup);

const read = (f: string) =>
  readFileSync(join(process.cwd(), "src/components/workspace", f), "utf8");

describe("the board/chat switch", () => {
  it("marks exactly one half pressed, and flips on tap", () => {
    const onChange = vi.fn();
    render(
      <PaneViewSwitch
        label="Growth view"
        boardLabel="Growth plan"
        chatOpen={false}
        onChange={onChange}
        controls="p"
      />,
    );
    const board = screen.getByRole("button", { name: "Growth plan" });
    const chat = screen.getByRole("button", { name: "Chat" });
    expect(board.getAttribute("aria-pressed")).toBe("true");
    expect(chat.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chat);
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.click(board);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("gives both halves identical geometry, whichever is active", () => {
    const { rerender } = render(
      <PaneViewSwitch
        label="l"
        boardLabel="Board"
        chatOpen={false}
        onChange={() => {}}
        controls="p"
      />,
    );
    const geom = (name: string) =>
      screen
        .getByRole("button", { name })
        .className.split(/\s+/)
        .filter((c) => !/^(bg-|text-)/.test(c))
        .sort()
        .join(" ");
    const boardOff = geom("Board");
    const chatOff = geom("Chat");
    expect(boardOff).toBe(chatOff);

    rerender(
      <PaneViewSwitch
        label="l"
        boardLabel="Board"
        chatOpen
        onChange={() => {}}
        controls="p"
      />,
    );
    expect(geom("Board")).toBe(boardOff);
    expect(geom("Chat")).toBe(chatOff);
  });

  it("points aria-controls at the chat panel it governs", () => {
    render(
      <PaneViewSwitch
        label="l"
        boardLabel="Board"
        chatOpen
        onChange={() => {}}
        controls="agent-chat-7"
      />,
    );
    for (const n of ["Board", "Chat"]) {
      expect(
        screen.getByRole("button", { name: n }).getAttribute("aria-controls"),
      ).toBe("agent-chat-7");
    }
  });
});

describe("the agent pages use it, and do not keep the phone icon", () => {
  it("the agent pages render it", () => {
    expect(read("AgentPageTab.tsx")).toContain("<PaneViewSwitch");
  });

  it("the agent pages hide the desktop icon on a phone", () => {
    const src = read("AgentPageTab.tsx");
    const i = src.indexOf("absolute left-3 top-3");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 60)).toContain("compact:hidden");
  });
});
