// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const state: { rows: unknown[]; error: unknown; tenantId: string | null } = {
  rows: [],
  error: null,
  tenantId: "tenant-1",
};

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: state.rows, error: state.error }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: () => Promise.resolve(state.tenantId),
}));

const role = { current: "owner" };
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role: role.current }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("./SettingsTab", () => ({
  ConnectorRowView: ({
    row,
    readOnly,
    showConnectAffordance,
  }: {
    row: { slug: string; connected: boolean };
    readOnly?: boolean;
    showConnectAffordance?: boolean;
  }) => (
    <div
      data-testid={`row-${row.slug}`}
      data-connected={String(row.connected)}
      data-readonly={String(!!readOnly)}
      data-affordance={String(!!showConnectAffordance)}
    />
  ),
}));

import { MessagingTab } from "./MessagingTab";

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.tenantId = "tenant-1";
  role.current = "owner";
});
afterEach(cleanup);

describe("MessagingTab", () => {
  it("names the page while the tiles are still loading", async () => {
    render(<MessagingTab />);
    expect(screen.getByRole("heading", { name: "Messaging" })).toBeDefined();
    expect(screen.getByText("Chat with Zavi in other messaging apps")).toBeDefined();
    await waitFor(() =>
      expect(screen.getByTestId("row-slack")).toBeDefined(),
    );
  });

  it("renders every app when NONE are connected", async () => {
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByTestId("row-slack")).toBeDefined(),
    );
    for (const slug of ["slack", "whatsapp", "imessage", "telegram", "discord"]) {
      expect(screen.getByTestId(`row-${slug}`).dataset.connected).toBe("false");
    }
  });

  it("keeps the connected Slack card in one grid column", async () => {
    render(<MessagingTab />);
    const slack = await screen.findByTestId("row-slack");
    expect(slack.parentElement?.className).toContain("[&>#connector-slack]:col-span-1");
  });

  it("reflects a live connection without dropping the others", async () => {
    state.rows = [{ slug: "whatsapp", connected_at: "2026-09-04T01:03:26Z" }];
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByTestId("row-whatsapp").dataset.connected).toBe("true"),
    );
    expect(screen.getByTestId("row-slack").dataset.connected).toBe("false");
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(5);
  });

  it("asks for a VISIBLE connect affordance, unlike Toolkit", async () => {
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByTestId("row-slack").dataset.affordance).toBe("true"),
    );
  });

  it("passes readOnly for members so connect controls stay admin-only", async () => {
    role.current = "member";
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByTestId("row-slack").dataset.readonly).toBe("true"),
    );
  });

  it("shows a retry banner when the read fails, not an empty page", async () => {
    state.error = { message: "boom" };
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined(),
    );
    expect(screen.queryByTestId("row-slack")).toBeNull();
  });

  it("surfaces the same banner when the active tenant can't be resolved", async () => {
    state.tenantId = null;
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined(),
    );
  });

  it("does not show the notification prefs entry on this page", async () => {
    render(<MessagingTab />);
    await waitFor(() =>
      expect(screen.getByTestId("row-slack")).toBeDefined(),
    );
    expect(screen.queryByText("When Zavi messages you")).toBeNull();
  });
});
