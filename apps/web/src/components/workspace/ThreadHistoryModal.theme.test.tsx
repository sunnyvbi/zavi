// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadHistoryModal } from "./ThreadHistoryModal";

afterEach(cleanup);

const THREADS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Car Rental Landing Page Design",
    last_message_at: new Date().toISOString(),
    created_at: null,
    last_message: "Already built today",
    run_status: null,
    pending: null,
  },
];

function open() {
  render(
    <ThreadHistoryModal
      threads={THREADS}
      currentThreadId={THREADS[0]!.id}
      mainThreadId={null}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  return screen.getByRole("dialog");
}

describe("the history modal follows the workspace theme", () => {
  it("portals inside a workspace-shell so dark mode reaches it outside the app tree", () => {
    const dialog = open();
    expect(dialog.closest(".workspace-shell")).not.toBeNull();
    expect(document.querySelector("main .workspace-shell, #root .workspace-shell")).toBeNull();
  });

  it("paints every surface and text colour from theme tokens, not fixed light hex", () => {
    const dialog = open();
    const classes = [dialog, ...Array.from(dialog.querySelectorAll("*"))]
      .map((el) => el.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\bbg-white\b/);
    expect(classes).not.toMatch(/(?:text|bg|border|ring)-\[#(?:[0-9a-f]{3}|[0-9a-f]{6})\]/i);
    expect(classes).not.toMatch(/bg-\[rgba\(25,25,25/);
    expect(dialog.className).toContain("bg-cream");
  });
});
