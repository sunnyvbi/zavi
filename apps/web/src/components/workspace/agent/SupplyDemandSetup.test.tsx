// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member" | null,
  openTab: vi.fn(),
  fetchCalls: [] as Array<{ path: string; body: unknown }>,
  response: { ok: true, status: 200, body: { ok: true } as unknown },
}));

vi.mock("../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: m.role, openTab: m.openTab }),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ rpc: vi.fn(async () => ({ error: null })) }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, opts: { body?: string }) => {
    m.fetchCalls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: m.response.ok, status: m.response.status, json: async () => m.response.body };
  }),
}));

import { SupplyDemandSetup, type SupplyDemandSetupState } from "./SupplyDemandSetup";

afterEach(() => {
  cleanup();
  m.role = "owner";
  m.fetchCalls = [];
  m.response = { ok: true, status: 200, body: { ok: true } };
  m.openTab.mockReset();
});

const NEEDS: SupplyDemandSetupState = {
  state: "needs_confirm",
  catalog_hash: "h1",
  proposed: {
    bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city", listing_ref_field: "itemId" },
    listings: { table: "items", id_field: "_id", geo_field: "state" },
  },
  roles: {
    bookings: ["created_at_field", "geo_field", "listing_ref_field"],
    listings: ["id_field", "geo_field"],
  },
  schema: {
    tables: [
      { name: "orders", columns: ["createdAt", "city", "itemId"] },
      { name: "items", columns: ["_id", "state"] },
    ],
  },
};

describe("SupplyDemandSetup", () => {
  it("no database → connect prompt that opens Toolkit", () => {
    const v = render(<SupplyDemandSetup setup={{ state: "no_db" }} onChanged={() => {}} />);
    expect(v.getByText("Connect your database to see supply and demand by location")).toBeTruthy();
    fireEvent.click(v.getByRole("button", { name: "Connect database" }));
    expect(m.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "brain" }));
  });

  it("finished with nothing in the window → says so instead of calculating", () => {
    const v = render(
      <SupplyDemandSetup setup={{ state: "no_recent_bookings", window_weeks: 13 }} onChanged={() => {}} />,
    );
    expect(v.getByText("No bookings in the last 13 weeks")).toBeTruthy();
  });

  it("names the unsupported database", () => {
    const v = render(
      <SupplyDemandSetup setup={{ state: "unsupported_db", db_type: "dynamodb" }} onChanged={() => {}} />,
    );
    expect(v.getByText(/Your connected database is DynamoDB/)).toBeTruthy();
    expect(v.getByText(/Postgres, MySQL and MongoDB/)).toBeTruthy();
  });

  it("member (or unknown role) is told to ask an admin, no form", () => {
    for (const role of ["member", null] as const) {
      m.role = role;
      const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
      expect(v.getByText("Ask a workspace admin to finish setup")).toBeTruthy();
      expect(v.queryByRole("button", { name: "Confirm and calculate" })).toBeNull();
      cleanup();
    }
  });

  it("admin sees the two questions and exactly the fields the answers need", () => {
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    expect(v.getByText("Where does an order's location live?")).toBeTruthy();
    expect(v.getByText("What counts as supply?")).toBeTruthy();
    expect(v.getByText("Orders")).toBeTruthy();
    expect(v.getAllByText("Location (city, region or area)")).toHaveLength(2);
    expect(v.getByText("When the listing went up (optional)")).toBeTruthy();
    expect(v.getByText("Listing ID on the order (optional)")).toBeTruthy();
    expect(v.queryByText("Customer ID on the order")).toBeNull();
    expect(v.queryByText(/Cancellation/i)).toBeNull();
  });

  it("switching to location on the customer and providers as supply asks for the customers table instead of listings", () => {
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    fireEvent.click(v.getByLabelText("On the customer's account"));
    fireEvent.click(v.getByLabelText("Sellers or providers taking orders"));
    expect(v.getByText("Customers")).toBeTruthy();
    expect(v.getByText("Customer ID on the order")).toBeTruthy();
    expect(v.getByText("Seller or provider ID on the order")).toBeTruthy();
    expect(v.queryByText("Listings")).toBeNull();
  });

  it("changing one answer keeps the fields already picked", () => {
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    const orderDate = v.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "createdAt");
    expect(orderDate).toBeTruthy();
    fireEvent.change(orderDate as HTMLSelectElement, { target: { value: "city" } });
    fireEvent.click(v.getByLabelText("Sellers or providers taking orders"));
    expect(v.getAllByRole("combobox").some((el) => (el as HTMLSelectElement).value === "city")).toBe(true);
    expect(v.getByText("Seller or provider ID on the order")).toBeTruthy();
  });

  it("asks what the backend says each pair of answers needs, not its own copy", () => {
    const withOptions = {
      ...NEEDS,
      options: {
        location_source: ["order", "listing"],
        supply_source: ["listings", "none"],
        roles_by_pair: {
          "order|listings": { bookings: ["created_at_field", "geo_field"], listings: ["id_field"] },
          "order|none": { bookings: ["created_at_field", "geo_field"] },
          "listing|listings": { bookings: ["created_at_field"], listings: ["id_field"] },
          "listing|none": { bookings: ["created_at_field"] },
        },
      },
    } as SupplyDemandSetupState;
    const v = render(<SupplyDemandSetup setup={withOptions} onChanged={() => {}} />);
    expect(v.queryByLabelText("On the customer's account")).toBeNull();
    expect(v.getByLabelText("On the order")).toBeTruthy();
    expect(v.queryByText("Listing ID on the order")).toBeNull();
  });

  it("names the answer the backend rejected instead of 'fill in every field'", async () => {
    m.response = { ok: false, status: 400, body: { error: "invalid_answers", field: "listings.geo_field", reason: "unknown_column" } };
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    fireEvent.click(v.getByRole("button", { name: /confirm and calculate/i }));
    await waitFor(() => {
      expect(v.getByText(/Listings "Location \(city, region or area\)"/)).toBeTruthy();
    });
    expect(v.queryByText("Fill in every field, then try again.")).toBeNull();
  });

  it("takes the server's answers when polling moves the page from discovering into the form", () => {
    const v = render(<SupplyDemandSetup setup={{ state: "discovering" }} onChanged={() => {}} />);
    v.rerender(
      <SupplyDemandSetup
        setup={{ ...NEEDS, choices: { location_source: "user", supply_source: "sellers_on_orders" } } as SupplyDemandSetupState}
        onChanged={() => {}}
      />,
    );
    expect((v.getByLabelText("On the customer's account") as HTMLInputElement).checked).toBe(true);
    expect(v.getByText("Customer ID on the order")).toBeTruthy();
  });

  it("with location on the listing, the listing id is required and named without (optional)", () => {
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    fireEvent.click(v.getByLabelText("On the listing (item, property, stall...)"));
    expect(v.getByText("Listing ID on the order")).toBeTruthy();
    expect(v.queryByText("Listing ID on the order (optional)")).toBeNull();
  });

  it("no location and no supply asks only for the orders table and date", () => {
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={() => {}} />);
    fireEvent.click(v.getByLabelText("We don't store a location"));
    fireEvent.click(v.getByLabelText("Skip supply, show demand only"));
    expect(v.getByText("Order date")).toBeTruthy();
    expect(v.queryByText("Location (city, region or area)")).toBeNull();
    expect(v.queryByText("Listings")).toBeNull();
  });

  it("confirm posts the answers + catalog hash to the setup route, then refetches", async () => {
    const onChanged = vi.fn();
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={onChanged} />);
    fireEvent.click(v.getByRole("button", { name: "Confirm and calculate" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(m.fetchCalls[0].path).toBe("/api/agents/marketplace-intelligence/confirm-setup");
    expect(m.fetchCalls[0].body).toMatchObject({
      catalog_hash: "h1",
      answers: {
        location_source: "order",
        supply_source: "listings",
        bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city" },
        listings: { table: "items", id_field: "_id", geo_field: "state" },
      },
    });
    expect(m.fetchCalls[0].body).not.toHaveProperty("answers.supply_demand_location");
  });

  it("names the empty field instead of a generic error, and does not call the server", async () => {
    const setup = { ...NEEDS, proposed: { ...NEEDS.proposed, listings: { table: "items", id_field: "_id" } } } as SupplyDemandSetupState;
    const v = render(<SupplyDemandSetup setup={setup} onChanged={() => {}} />);
    fireEvent.click(v.getByRole("button", { name: "Confirm and calculate" }));
    await waitFor(() =>
      expect(v.getByText('Pick the Listings "Location (city, region or area)" field, then try again.')).toBeTruthy(),
    );
    expect(m.fetchCalls).toHaveLength(0);
  });

  it("a failed calculation explains it and re-offers the form for a bad date field", () => {
    const v = render(
      <SupplyDemandSetup
        setup={{ state: "calculation_failed", code: "bad_date_field", form: NEEDS as never }}
        onChanged={() => {}}
      />,
    );
    expect(v.getByText("We couldn't read your booking dates")).toBeTruthy();
    expect(v.getByRole("button", { name: "Confirm and calculate" })).toBeTruthy();
    cleanup();
    const w = render(
      <SupplyDemandSetup setup={{ state: "calculation_failed", code: "connection" }} onChanged={() => {}} />,
    );
    expect(w.getByText("We couldn't reach your database")).toBeTruthy();
    expect(w.queryByRole("button", { name: "Confirm and calculate" })).toBeNull();
  });

  it("a refused read says a data-access rule stopped it, not that there is too much data", () => {
    const v = render(<SupplyDemandSetup setup={{ state: "calculation_failed", code: "refused" }} onChanged={() => {}} />);
    expect(v.getByText("A data-access rule stopped the calculation")).toBeTruthy();
    expect(v.queryByText("Too much data to calculate")).toBeNull();
    expect(v.queryByRole("button", { name: "Confirm and calculate" })).toBeNull();
  });

  it("a rejected save shows a plain message and does not refetch", async () => {
    m.response = { ok: false, status: 403, body: { error: "admin_required" } };
    const onChanged = vi.fn();
    const v = render(<SupplyDemandSetup setup={NEEDS} onChanged={onChanged} />);
    fireEvent.click(v.getByRole("button", { name: "Confirm and calculate" }));
    await waitFor(() => expect(v.getByText("Only a workspace admin can confirm this setup.")).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
