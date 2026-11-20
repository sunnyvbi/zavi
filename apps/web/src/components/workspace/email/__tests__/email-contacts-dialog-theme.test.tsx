// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 12, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 12, sendable: 11, unsubscribed_or_bounced: 1 },
  needs_consent: false,
};

function body(url: string): unknown {
  if (url === "/api/workspace/email-lists") return { lists: [LIST] };
  if (url.startsWith("/api/workspace/email-contacts?")) return { rows: [], total: 0, counts: { contacts: 1234, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false };
  if (url === "/api/workspace/email-test-lists") return { routes: [], orphans: [] };
  return {};
}

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => ({ ok: true, status: 200, json: () => Promise.resolve(body(url)) }),
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));

import { EmailContactsSection } from "../EmailContactsSection";

const portalTargets = (node: Element) => Object.keys(node).filter((key) => key.startsWith("_reactListening"));

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  document.querySelectorAll(".workspace-shell").forEach((node) => node.remove());
});

describe("contacts dialog inside the dark workspace shell", () => {
  it("portals once, into the shell, and never makes document.body a portal container", async () => {
    document.documentElement.classList.add("dark");
    const shell = document.createElement("div");
    shell.className = "workspace-shell";
    document.body.append(shell);
    render(
      <div data-testid="pane" style={{ transform: "translate3d(-50%, 0, 0)" }}>
        <EmailContactsSection />
      </div>,
      { container: shell.appendChild(document.createElement("div")) },
    );
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    expect(portalTargets(document.body)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Upload CSV" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    expect(dialog.parentElement).toBe(shell);
    expect(dialog.closest("html.dark .workspace-shell:not([role=dialog])")).toBe(shell);
    expect(screen.getByTestId("pane").contains(dialog)).toBe(false);
    expect(portalTargets(shell)).not.toEqual([]);
    expect(portalTargets(document.body)).toEqual([]);
  });
});
