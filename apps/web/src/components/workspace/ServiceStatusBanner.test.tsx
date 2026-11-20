// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const health = vi.hoisted(() => ({ value: "up" as "up" | "down" | "recovered" }));
vi.mock("@/lib/serviceHealth", () => ({ useServiceHealth: () => health.value }));

import {
  ServiceStatusBanner,
  SERVICE_DOWN_COPY,
  SERVICE_BACK_COPY,
  SERVICE_BANNER_HEIGHT_VAR,
} from "./ServiceStatusBanner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(SERVICE_BANNER_HEIGHT_VAR);
});

describe("ServiceStatusBanner", () => {
  it("renders nothing when Zavi is up", () => {
    health.value = "up";
    const { container } = render(<ServiceStatusBanner />);
    expect(container.innerHTML).toBe("");
  });
  it("says Zavi is having trouble when down", () => {
    health.value = "down";
    render(<ServiceStatusBanner />);
    expect(screen.getByRole("status").textContent).toBe(SERVICE_DOWN_COPY);
  });
  it("says Zavi is back after recovery", () => {
    health.value = "recovered";
    render(<ServiceStatusBanner />);
    expect(screen.getByRole("status").textContent).toBe(SERVICE_BACK_COPY);
  });

  it("reserves its own height so the workspace header under it stays clickable, and gives it back when Zavi is up", () => {
    let height = 54;
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "status" ? height : 0;
      });
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    const root = document.documentElement;
    health.value = "down";
    const { rerender } = render(<ServiceStatusBanner />);
    expect(root.style.getPropertyValue(SERVICE_BANNER_HEIGHT_VAR)).toBe("54px");

    height = 92;
    observers[observers.length - 1]();
    expect(root.style.getPropertyValue(SERVICE_BANNER_HEIGHT_VAR)).toBe("92px");

    height = 36;
    health.value = "recovered";
    rerender(<ServiceStatusBanner />);
    expect(root.style.getPropertyValue(SERVICE_BANNER_HEIGHT_VAR)).toBe("36px");

    health.value = "up";
    rerender(<ServiceStatusBanner />);
    expect(root.style.getPropertyValue(SERVICE_BANNER_HEIGHT_VAR)).toBe("");
    heightSpy.mockRestore();
  });
});
