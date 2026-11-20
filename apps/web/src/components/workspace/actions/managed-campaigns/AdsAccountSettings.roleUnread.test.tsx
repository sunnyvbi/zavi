import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: null, tenantId: "t1" }) }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: () => <div>Shared balance</div> }));
vi.mock("./BoundAdsCampaigns", () => ({ BoundAdsCampaigns: () => <div>Bound campaign list</div> }));
const db = vi.hoisted(() => ({ answer: { data: null, error: { message: "timeout" } } as { data: { role: string } | null; error: { message: string } | null } }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => db.answer };
      return q;
    },
  }),
}));

import { AdsAccountSettings } from "./AdsAccountSettings";

const AVAILABLE = "/api/ads/accounts/linkedin/available";
const BINDING = "10000000-0000-4000-8000-000000000001";
const list = { accounts: [{ id: "559880687", name: "Old Co", currency: "USD" }], fetched_at: new Date().toISOString(), just_refreshed: false };
const availableReads = () => h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE)).length;

beforeEach(() => {
  db.answer = { data: null, error: { message: "timeout" } };
  h.api.mockReset();
  h.api.mockImplementation(async (path: string) => {
    if (path.startsWith(AVAILABLE)) return list;
    if (path.endsWith("/consent")) return { version: "v1", text: "Authorize", accepted: true };
    return { accounts: [{ id: BINDING, provider_account_id: "559880687", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: BINDING };
  });
});
afterEach(cleanup);

it("when the role cannot be read, the account panel is not editable, does not claim the founder is not an owner, and recovers on Try again", async () => {
  render(<AdsAccountSettings platform="linkedin" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  const note = await screen.findByTestId("account-role-unread");
  await waitFor(() => expect(note.textContent).toContain("could not check your workspace role"));
  expect(document.body.textContent).not.toContain("Only a workspace owner or admin can change the ad account");
  const withdraw = screen.getByRole("button", { name: "Withdraw shared-wallet permission" }) as HTMLButtonElement;
  expect(withdraw.disabled).toBe(true);
  expect(withdraw.title).toBe("Zavi could not check your workspace role just now.");
  expect(h.api.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "POST")).toHaveLength(0);
  expect(availableReads()).toBe(0);
  db.answer = { data: { role: "owner" }, error: null };
  fireEvent.click(within(note).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(availableReads()).toBe(1));
  await waitFor(() => expect(screen.queryByTestId("account-role-unread")).toBeNull());
  expect((screen.getByRole("button", { name: "Withdraw shared-wallet permission" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
});
