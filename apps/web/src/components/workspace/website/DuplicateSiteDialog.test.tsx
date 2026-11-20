// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DuplicateSiteDialog } from "./DuplicateSiteDialog";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

function open() {
  const onDuplicated = vi.fn();
  const onClose = vi.fn();
  render(<DuplicateSiteDialog siteId="site-1" siteName="Harbor Yoga" onClose={onClose} onDuplicated={onDuplicated} />);
  return { onDuplicated, onClose };
}

describe("DuplicateSiteDialog", () => {
  it("says what is and is not copied, and opens the copy when it is made", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ site_id: "s2", conductor_run_id: "run-2", name: "Harbor Yoga (copy)" }) });
    const { onDuplicated } = open();
    expect(screen.getByText("Data saved on the site, and its users")).toBeTruthy();
    expect(screen.getByText("Custom domains")).toBeTruthy();
    expect(screen.getByText("Scheduled jobs, paused until you turn them on")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/sites/site-1/duplicate", {
      method: "POST",
      idempotent: true,
      headers: { "Idempotency-Key": expect.any(String) },
    });
    expect(onDuplicated).toHaveBeenCalledWith({ site_id: "s2", conductor_run_id: "run-2", name: "Harbor Yoga (copy)" });
  });

  it("shows the server's reason and lets the founder try again", async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: "A build is running. Duplicate the site when it finishes." } }),
    });
    const { onDuplicated } = open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("A build is running");
    expect(onDuplicated).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Duplicate" }) as HTMLButtonElement).disabled).toBe(false);
    apiFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ site_id: "s2", conductor_run_id: "run-2", name: "X" }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    const keys = apiFetch.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("Escape and Cancel close it without a request", () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
