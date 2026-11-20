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

function renderInSlidingPane() {
  render(
    <div data-testid="pane" className="w-[200%]" style={{ transform: "translate3d(-50%, 0, 0)" }}>
      <EmailContactsSection />
    </div>,
  );
  return screen.getByTestId("pane");
}

function transformedAncestors(node: Element) {
  const found: Element[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el instanceof HTMLElement && el.style.transform) found.push(el);
  }
  return found;
}

afterEach(cleanup);

describe("contacts dialogs escape the sliding channel pane", () => {
  it("mounts the Upload CSV dialog under document.body, outside the transformed pane, and keeps Escape and Close working", async () => {
    const pane = renderInSlidingPane();
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    const opener = screen.getByRole("button", { name: "Upload CSV" });
    expect(pane.contains(opener)).toBe(true);
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    expect(document.body.contains(dialog)).toBe(true);
    expect(pane.contains(dialog)).toBe(false);
    expect(transformedAncestors(dialog)).toEqual([]);
    expect(dialog.className).toContain("fixed");
    expect(dialog.className).toContain("inset-0");
    expect(dialog.className).toContain("workspace-shell");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Upload contacts" })).toBeNull());
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    const again = await screen.findByRole("dialog", { name: "Upload contacts" });
    expect(pane.contains(again)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("mounts the Import from database dialog outside the transformed pane too", async () => {
    const pane = renderInSlidingPane();
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Import from database" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.body.contains(dialog)).toBe(true);
    expect(pane.contains(dialog)).toBe(false);
    expect(transformedAncestors(dialog)).toEqual([]);
  });

  it("removes the portaled dialog from document.body when the section unmounts while it is open", async () => {
    const { unmount } = render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Upload CSV" }));
    await screen.findByRole("dialog", { name: "Upload contacts" });
    unmount();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
