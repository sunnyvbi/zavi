// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; method: string }> = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: { method?: string }) => {
    calls.push({ path, method: opts?.method ?? "GET" });
    const body =
      opts?.method === "DELETE"
        ? { removed: true }
        : {
            notes: [
              {
                id: "n1",
                metric_id: "net_revenue",
                metric_label: "Net revenue",
                note_text: "Revenue excludes test orders",
                created_at: "2026-09-28T10:00:00Z",
              },
            ],
          };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));

import { DataNotesPanel } from "./DataNotesPanel";

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("DataNotesPanel", () => {
  it("lists notes and removes one", async () => {
    render(<DataNotesPanel />);
    await waitFor(() => screen.getByText("Revenue excludes test orders"));
    expect(screen.getByText(/Applies to Net revenue/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove data note: Revenue excludes test orders" }));
    await waitFor(() => expect(screen.queryByText("Revenue excludes test orders")).toBeNull());
    expect(calls).toContainEqual({ path: "/api/tenant/me/data-notes/n1", method: "DELETE" });
    expect(screen.getByText("No data notes yet.")).toBeDefined();
  });

  it("read-only viewers see the notes without a Remove button", async () => {
    render(<DataNotesPanel readOnly />);
    await waitFor(() => screen.getByText("Revenue excludes test orders"));
    expect(screen.queryByRole("button", { name: /Remove data note/ })).toBeNull();
  });
});
