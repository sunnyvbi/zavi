// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

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
          order: () => ({
            limit: () => Promise.resolve({ data: state.rows, error: state.error }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: () => Promise.resolve(state.tenantId),
}));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./PostPreview", () => ({
  PostPreview: ({ channel }: { channel: string }) => <div data-testid="post-preview">{channel}</div>,
}));

import { CalendarTab } from "./CalendarTab";

const inThisWeek = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

const row = (o: Record<string, unknown>) => ({
  id: "p1",
  channel: "linkedin",
  status: "scheduled",
  scheduled_at: inThisWeek(),
  created_at: "2026-09-01T10:00:00.000Z",
  external_url: null,
  last_error: null,
  approved_payload_snapshot: { payload: { text: "Launch day post" } },
  ...o,
});

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.tenantId = "tenant-1";
  apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});

describe("CalendarTab", () => {
  it("shows the empty state when the tenant has no posts", async () => {
    const { container } = render(<CalendarTab />);
    expect(await within(container).findByText("Nothing on the calendar")).toBeTruthy();
  });

  it("a scheduled post appears in the week; picking it offers Reschedule + Cancel", async () => {
    state.rows = [row({})];
    const { container } = render(<CalendarTab />);
    const card = await within(container).findByText("Launch day post");
    fireEvent.click(card.closest("button")!);
    expect(within(container).getByTestId("post-preview").textContent).toBe("linkedin");
    expect(within(container).getByRole("button", { name: "Reschedule" })).toBeTruthy();
    expect(within(container).getByRole("button", { name: "Cancel post" })).toBeTruthy();
  });

  it("a published post shows Posted ↗ and no Cancel", async () => {
    state.rows = [row({ status: "published", external_url: "https://li/x" })];
    const { container } = render(<CalendarTab />);
    fireEvent.click((await within(container).findByText("Launch day post")).closest("button")!);
    const link = within(container).getByRole("link", { name: "Posted ↗" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://li/x");
    expect(within(container).queryByRole("button", { name: "Cancel post" })).toBeNull();
  });

  it("Cancel confirms, calls the cancel route, and reloads", async () => {
    state.rows = [row({})];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<CalendarTab />);
    fireEvent.click((await within(container).findByText("Launch day post")).closest("button")!);
    fireEvent.click(within(container).getByRole("button", { name: "Cancel post" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][0]).toBe("/api/social/posts/p1/cancel");
  });

  it("Reschedule sends the picked time as ISO and surfaces a server refusal", async () => {
    state.rows = [row({})];
    apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: "This post can't be moved any more" } }),
    });
    const { container } = render(<CalendarTab />);
    fireEvent.click((await within(container).findByText("Launch day post")).closest("button")!);
    const input = within(container).getByLabelText("New publish time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2099-01-02T09:30" } });
    fireEvent.click(within(container).getByRole("button", { name: "Reschedule" }));
    const alert = await within(container).findByRole("alert");
    expect(alert.textContent).toMatch(/can't be moved/);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/social/posts/p1/reschedule");
    expect(JSON.parse(init.body)).toEqual({ scheduled_at: new Date("2099-01-02T09:30").toISOString() });
  });

  it("a failed post explains why in plain words", async () => {
    state.rows = [row({ status: "failed", last_error: "disconnected" })];
    const { container } = render(<CalendarTab />);
    fireEvent.click((await within(container).findByText("Launch day post")).closest("button")!);
    expect(within(container).getByText(/no longer connected/)).toBeTruthy();
  });

  it("a load error shows the banner with Retry", async () => {
    state.error = { message: "boom" };
    const { container } = render(<CalendarTab />);
    expect(await within(container).findByText("Couldn’t load your calendar")).toBeTruthy();
    expect(within(container).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
