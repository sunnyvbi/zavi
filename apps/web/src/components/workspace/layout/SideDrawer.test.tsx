// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SideDrawer, SideDrawerHostContext } from "./SideDrawer";

afterEach(cleanup);

function inSection(fullPage: boolean) {
  const section = document.createElement("div");
  document.body.appendChild(section);
  render(
    <SideDrawerHostContext.Provider value={section}>
      <SideDrawer title="Find creators" onClose={() => {}} fullPage={fullPage}>
        body
      </SideDrawer>
    </SideDrawerHostContext.Provider>,
  );
  return { section, dialog: screen.getByRole("dialog") };
}

describe("SideDrawer placement", () => {
  it("a fullPage drawer opens inside the channel section, not over the window", () => {
    const { section, dialog } = inSection(true);
    expect(dialog.parentElement).toBe(section);
    expect(dialog.className).toContain("absolute inset-0");
    expect(dialog.className).not.toContain("fixed");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("a side drawer still opens over the window", () => {
    const { section, dialog } = inSection(false);
    expect(section.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).toContain("workspace-shell fixed inset-0");
  });

  it("shows the drawer title as a heading large enough to read at a glance", () => {
    inSection(false);
    const heading = screen.getByRole("heading", { name: "Find creators" });
    expect(heading.className).toContain("text-[17px]");
    expect(heading.className).toContain("font-bold");
  });

  it("a fullPage drawer with no section falls back to the window", () => {
    render(
      <SideDrawer title="Find creators" onClose={() => {}} fullPage>
        body
      </SideDrawer>,
    );
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
  });
});
