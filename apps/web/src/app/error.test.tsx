// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import RouteError from "./error";
import { ERROR_HEADLINE } from "@/lib/errorCopy";

afterEach(() => cleanup());

describe("route error screen", () => {
  it("shows a plain message without error details and retries on click", () => {
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RouteError error={Object.assign(new Error("db 522 secret detail"), { digest: "d1" })} reset={reset} />);
    expect(screen.getByRole("heading").textContent).toBe(ERROR_HEADLINE);
    expect(document.body.textContent).not.toContain("secret detail");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
