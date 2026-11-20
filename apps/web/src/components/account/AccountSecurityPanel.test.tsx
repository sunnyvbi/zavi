// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));
const signOut = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "tok" } } }),
      refreshSession: async () => ({ data: { session: { access_token: "tok" } }, error: null }),
      signOut,
    },
  }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({ track: vi.fn(), resetAnalyticsIdentity: vi.fn() }));

import { AccountSecurityPanel } from "./AccountSecurityPanel";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";

function renderPanel(props: Parameters<typeof AccountSecurityPanel>[0] = {}) {
  return render(
    <>
      <AccountSecurityPanel email="me@example.com" {...props} />
      <ConfirmDialogHost />
    </>,
  );
}

async function confirmInDialog(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the role line", () => {
  it.each(["owner", "admin"])("does not tell an %s that someone else manages invites", (role) => {
    renderPanel({ role });
    expect(screen.getByText(/Your role in this workspace/).textContent).not.toContain("managed by");
  });

  it("tells a member who manages invites", () => {
    renderPanel({ role: "member" });
    expect(screen.getByText(/Your role in this workspace/).textContent).toContain(
      "Invites and roles are managed by your workspace owner or admin.",
    );
  });
});

describe("Delete account", () => {
  it("reaches DELETE /api/account on the backend and signs out", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await confirmInDialog("Delete account");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/account");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await confirmInDialog("Cancel");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's refusal (sole owner) and stays signed in", async () => {
    const message = "You are the only owner of Acme, which still has other members.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: 409 })),
    );
    signOut.mockClear();
    push.mockClear();

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await confirmInDialog("Delete account");

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(signOut).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

});

function stubWorkspace(memberCount: number, credits: Record<string, unknown>) {
  const members = Array.from({ length: memberCount }, (_, i) => ({ user_id: `u${i}`, role: "owner" }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/members") return new Response(JSON.stringify({ members }), { status: 200 });
    if (path === "/api/billing/credits") return new Response(JSON.stringify(credits), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CANCEL_LINE = "Deleting does not cancel a paid plan.";

describe("Cancel-the-plan-first line", () => {
  it("shows to the sole member of a paid workspace, with a working Billing link", async () => {
    stubWorkspace(1, { manage_via_portal: true, managed_in_store: false });
    const onOpenBilling = vi.fn();
    renderPanel({ onOpenBilling });
    const line = await screen.findByTestId("account-cancel-plan-first");
    expect(line.textContent).toContain(CANCEL_LINE);
    expect(line.textContent).toContain("Cancel it in Billing first.");
    fireEvent.click(within(line).getByRole("button", { name: "Billing" }));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it("shows for a live App Store / Play plan too", async () => {
    stubWorkspace(1, { manage_via_portal: false, managed_in_store: true });
    renderPanel({ onOpenBilling: vi.fn() });
    expect(await screen.findByTestId("account-cancel-plan-first")).toBeTruthy();
  });

  it("is hidden for the sole member of a free workspace", async () => {
    const fetchMock = stubWorkspace(1, { manage_via_portal: false, managed_in_store: false });
    renderPanel({ onOpenBilling: vi.fn() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("account-cancel-plan-first")).toBeNull();
  });

  it("is hidden for one of two members of a paid workspace", async () => {
    const fetchMock = stubWorkspace(2, { manage_via_portal: true, managed_in_store: false });
    renderPanel({ onOpenBilling: vi.fn() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("account-cancel-plan-first")).toBeNull();
  });

  it("is hidden when a read fails", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel({ onOpenBilling: vi.fn() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("account-cancel-plan-first")).toBeNull();
  });

  it("makes no reads and shows nothing where Billing is not available", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("account-cancel-plan-first")).toBeNull();
  });
});
