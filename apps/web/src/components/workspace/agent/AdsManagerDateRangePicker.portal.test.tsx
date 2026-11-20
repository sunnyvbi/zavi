// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const compact = { value: false };
vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value,
}));

import {
  AdsManagerDateRangePicker,
  presetRange,
  resolveWindow,
} from "./AdsManagerDateRangePicker";

const now = new Date("2026-09-21T00:00:00.000Z");
const range = () => {
  const { start, end } = presetRange("last_7d", now);
  return resolveWindow(start, end, now);
};

const shell = () => {
  const el = document.createElement("div");
  el.className = "workspace-shell";
  document.body.appendChild(el);
  return el;
};

const openPicker = (host: HTMLElement) => {
  render(
    <AdsManagerDateRangePicker value={range()} onChange={() => {}} now={now} compact />,
    { container: host },
  );
  fireEvent.click(screen.getByRole("button", { name: /2026/ }));
  return screen.getByRole("dialog", { name: "Select date range" });
};

afterEach(() => {
  cleanup();
  compact.value = false;
  document.body.innerHTML = "";
});

describe("where the icon-only picker's popover is portalled", () => {
  it("lands inside the workspace shell on a phone, so the dark rules reach it", () => {
    compact.value = true;
    const host = shell();

    expect(host.contains(openPicker(host))).toBe(true);
  });

  it("stays on document.body at desktop width, exactly as before", () => {
    const host = shell();
    const dialog = openPicker(host);

    expect(dialog.parentElement).toBe(document.body);
    expect(host.contains(dialog)).toBe(false);
  });
});
