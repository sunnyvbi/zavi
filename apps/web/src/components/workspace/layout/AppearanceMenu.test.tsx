// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceMenu } from "./AppearanceMenu";

afterEach(cleanup);

describe("AppearanceMenu", () => {
  it("opens a compact right-side menu on hover", () => {
    render(
      <AppearanceMenu
        theme="system"
        onSetTheme={() => {}}
        menuItemClassName="flex w-full"
      />,
    );

    const trigger = screen.getByRole("menuitem", { name: "Appearance" });
    expect(screen.queryByRole("menu", { name: "Appearance" })).toBeNull();

    fireEvent.mouseEnter(trigger.parentElement!);

    const menu = screen.getByRole("menu", { name: "Appearance" });
    expect(menu.className).toContain("w-32");
    expect(menu.parentElement?.className).toContain("fixed");
    expect(menu.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeTruthy();
  });

  it("supports keyboard focus and applies the selected theme", () => {
    const onSetTheme = vi.fn();
    render(
      <AppearanceMenu
        theme="light"
        onSetTheme={onSetTheme}
        menuItemClassName="flex w-full"
      />,
    );

    fireEvent.focus(screen.getByRole("menuitem", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));

    expect(onSetTheme).toHaveBeenCalledWith("dark");
  });

  it("carries the workspace theme scope into its viewport-level portal", () => {
    render(
      <div className="workspace-shell">
        <AppearanceMenu
          theme="dark"
          onSetTheme={() => {}}
          menuItemClassName="flex w-full"
        />
      </div>,
    );

    const trigger = screen.getByRole("menuitem", { name: "Appearance" });
    fireEvent.mouseEnter(trigger.parentElement!);

    expect(screen.getByRole("menu", { name: "Appearance" }).parentElement?.className).toContain(
      "workspace-shell",
    );
  });
});
