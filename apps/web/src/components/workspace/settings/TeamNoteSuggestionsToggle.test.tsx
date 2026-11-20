// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
import { TeamNoteSuggestionsToggle } from "./TeamNoteSuggestionsToggle";

const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b });
beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe("TeamNoteSuggestionsToggle", () => {
  it("shows OFF when suggestions were stopped; turning it on PUTs suggestions_off=false", async () => {
    apiFetch.mockResolvedValueOnce(json({ suggestions_off: true })).mockResolvedValueOnce(json({ suggestions_off: false }));
    render(<TeamNoteSuggestionsToggle />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(sw);
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith("/api/team-notes/prefs",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ suggestions_off: false }) })));
  });

  it("reverts and says so when the save fails", async () => {
    apiFetch.mockResolvedValueOnce(json({ suggestions_off: false })).mockResolvedValueOnce(json({}, false));
    render(<TeamNoteSuggestionsToggle />);
    const sw = await screen.findByRole("switch");
    fireEvent.click(sw);
    await screen.findByText("Not saved, try again");
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});
