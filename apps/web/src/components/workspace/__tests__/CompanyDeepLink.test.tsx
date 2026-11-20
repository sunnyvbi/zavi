// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let active: string | null = "A";
let switchResult: "ok" | "refused" | "not_converged" = "ok";
const switched: string[] = [];
const signOut = vi.fn(async (): Promise<{ error: unknown }> => ({ error: null }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut } }) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => active }));
vi.mock("@/lib/workspace/tenantSwitch", () => ({
  switchToTenantDetailed: async (id: string) => (switched.push(id), switchResult),
}));

import { CompanyDeepLink } from "../CompanyDeepLink";

const replace = vi.fn();
beforeEach(() => {
  active = "A";
  switchResult = "ok";
  switched.length = 0;
  replace.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "https://www.zaviagent.com/workspace?tab=growth-strategy&company=B", replace },
  });
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
});
afterEach(cleanup);

describe("CompanyDeepLink", () => {
  it("a sign-out that fails does not leave the holder (it would land back in a mixed workspace)", async () => {
    switchResult = "not_converged";
    signOut.mockResolvedValueOnce({ error: new Error("network") });
    render(<CompanyDeepLink holder />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Couldn't sign you out. Try again.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("another company: switches, then reloads without the parameter", async () => {
    render(<CompanyDeepLink holder />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace?tab=growth-strategy"));
    expect(switched).toEqual(["B"]);
  });

  it("a refused switch (not a member, bad link) changed nothing: opens the current company", async () => {
    switchResult = "refused";
    render(<CompanyDeepLink holder />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace?tab=growth-strategy"));
  });

  it("a mute link for another company: after the switch, reloads KEEPING company so the mute can prove it", async () => {
    window.location.href = "https://www.zaviagent.com/workspace?company=B&mute_alert=net_revenue";
    render(<CompanyDeepLink holder />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace?company=B&mute_alert=net_revenue"));
  });

  it("a mute link whose switch is refused drops the mute too (it was for another company)", async () => {
    switchResult = "refused";
    window.location.href = "https://www.zaviagent.com/workspace?company=B&mute_alert=net_revenue";
    render(<CompanyDeepLink holder />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
  });

  it("a switch whose token never updated does not reload; it says so and offers a way out", async () => {
    switchResult = "not_converged";
    render(<CompanyDeepLink holder />);
    expect(await screen.findByText(/Couldn.t open that company/)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each(["A", "B"])("keeps plan-ready tags when opening company B from company %s", async (company) => {
    active = company;
    const path = "/workspace?tab=growth-strategy&company=B&utm_source=email&utm_medium=zavi&utm_campaign=plan_ready";
    window.location.href = `https://www.zaviagent.com${path}`;
    render(<CompanyDeepLink holder={company !== "B"} />);
    const expected = path.replace("&company=B", "");
    if (company === "B") {
      await waitFor(() => expect(window.history.replaceState).toHaveBeenCalledWith(null, "", expected));
    } else {
      await waitFor(() => expect(replace).toHaveBeenCalledWith(expected));
    }
  });

  it("already that company: just drops the parameter", async () => {
    active = "B";
    render(<CompanyDeepLink />);
    await waitFor(() => expect(window.history.replaceState).toHaveBeenCalled());
    expect(switched).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  });
});
