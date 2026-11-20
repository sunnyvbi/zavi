// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SettingsSubNav } from "./SettingsSubNav";

const sections = [
  { id: "email", label: "Email" },
  { id: "ai-clients", label: "AI clients" },
];

afterEach(cleanup);

describe("SettingsSubNav", () => {
  for (const variant of ["rail", "pills"] as const) {
    it(`renders the AI clients icon in the ${variant} variant`, () => {
      render(
        <SettingsSubNav
          sections={sections}
          activeId="email"
          onSelect={() => {}}
          variant={variant}
        />,
      );
      const button = screen.getByRole("button", { name: "AI clients" });
      const icon = button.querySelector("svg");
      expect(icon).toBeTruthy();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    });
  }
});

describe("SettingsSubNav pills follow the active section", () => {
  const many = [
    { id: "company", label: "Company" },
    { id: "setup", label: "Setup checklist" },
    { id: "notifications", label: "Notifications" },
    { id: "team", label: "Team" },
    { id: "billing", label: "Billing & Credits" },
    { id: "feedback", label: "Feedback" },
  ];

  const rect = (left: number, width: number) =>
    ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  function layOut(row: HTMLElement, pills: Record<string, DOMRect>) {
    row.getBoundingClientRect = () => rect(0, 320);
    for (const button of Array.from(row.querySelectorAll("button"))) {
      const box = pills[button.textContent ?? ""];
      if (box) button.getBoundingClientRect = () => box;
    }
  }

  const mount = (activeId: string) => (
    <SettingsSubNav sections={many} activeId={activeId} onSelect={() => {}} variant="pills" />
  );

  it("does not scroll anything on first mount, and later scrolls only the row, only when the pill is off screen", () => {
    const view = render(mount("company"));
    const row = view.container.firstElementChild as HTMLElement;
    const scrollTo = vi.fn();
    row.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    Object.defineProperty(row, "scrollLeft", { configurable: true, value: 40, writable: true });
    layOut(row, {
      Company: rect(8, 96),
      Team: rect(200, 60),
      "Billing & Credits": rect(400, 120),
    });
    expect(scrollTo).not.toHaveBeenCalled();

    view.rerender(mount("team"));
    expect(scrollTo).not.toHaveBeenCalled();

    view.rerender(mount("billing"));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 40 + 400 - (320 - 120) / 2, behavior: "smooth" });

    view.rerender(mount("billing"));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("never reaches for scrollIntoView, which would drag every scrollable ancestor along", () => {
    expect(typeof HTMLElement.prototype.scrollIntoView).toBe("undefined");
    const view = render(mount("company"));
    const row = view.container.firstElementChild as HTMLElement;
    row.scrollTo = vi.fn() as unknown as HTMLElement["scrollTo"];
    layOut(row, { "Billing & Credits": rect(400, 120) });
    expect(() => view.rerender(mount("billing"))).not.toThrow();
  });

  it("gives every pill a thumb-sized hit area", () => {
    render(
      <SettingsSubNav
        sections={many}
        activeId="company"
        onSelect={() => {}}
        variant="pills"
      />,
    );
    for (const s of many) {
      const pill = screen.getByRole("button", { name: s.label });
      expect(pill.className).toContain("min-h-[40px]");
      expect(pill.className).toContain("touch-manipulation");
    }
  });
});
