// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ERROR_CLEAR_MS, useTransientError } from "./ui";

function Harness() {
  const [error, setError] = useTransientError();
  return (
    <>
      <button type="button" onClick={() => setError("Couldn't save.")}>fail</button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTransientError", () => {
  it("clears a Reddit channel error after two seconds", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "fail" }));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save.");
    act(() => {
      vi.advanceTimersByTime(ERROR_CLEAR_MS - 1);
    });
    expect(screen.queryByRole("alert")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ERROR_CLEAR_MS).toBe(2000);
  });
});
