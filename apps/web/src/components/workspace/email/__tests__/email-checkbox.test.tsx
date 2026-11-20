// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmailCheckbox } from "../EmailCheckbox";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../../../../app/globals.css"), "utf8");

function forcedShellBackgrounds(): Set<string> {
  const forced = new Set<string>();
  for (const m of css.matchAll(/\.workspace-shell\s+\.([\w-]+)\s*\{([^}]*)\}/g)) {
    if (/background(-color)?\s*:[^;]*!important/.test(m[2])) forced.add(m[1]);
  }
  return forced;
}

describe("EmailCheckbox inside the workspace shell", () => {
  it("has no unchecked fill that the shell forces with !important over its checked fill", () => {
    render(<div className="workspace-shell"><EmailCheckbox aria-label="Test list" defaultChecked /></div>);
    const input = screen.getByRole("checkbox", { name: "Test list" }) as HTMLInputElement;
    expect(input.checked).toBe(true);
    const classes = input.className.split(/\s+/);
    expect(classes).toContain("checked:bg-ink");
    const forced = forcedShellBackgrounds();
    expect(forced.has("bg-cream")).toBe(true);
    expect(classes.filter((c) => forced.has(c))).toEqual([]);
  });
});
