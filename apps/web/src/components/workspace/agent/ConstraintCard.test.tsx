
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConstraintCard, ConfirmMappingForm, DiagnosedView } from "./ConstraintCard";

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ rpc: vi.fn(async () => ({ error: null })) }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ status: "disabled" }) })),
}));

describe("ConstraintCard", () => {
  it("renders the loading shell on first paint (effect has not fired under SSR)", () => {
    const html = renderToStaticMarkup(<ConstraintCard />);
    expect(html).toContain("Binding constraint");
    expect(html).toContain("Diagnosing your binding constraint");
  });

  it("confirm-map form renders dropdowns from the live schema + probe warnings", () => {
    const html = renderToStaticMarkup(
      <ConfirmMappingForm
        data={{
          status: "requires_mapping_confirmation",
          catalog_hash: "h1",
          proposed_map: {
            bookings: { table: "trips", created_at_field: "additionalPhotoTimestamps" },
            listings: { table: "carlistings", id_field: "_id" },
          },
          probes: [
            {
              role: "bookings",
              field_key: "created_at_field",
              field: "additionalPhotoTimestamps",
              kind: "date",
              ok: false,
              reason: "field has no real timestamps in the sample",
            },
          ],
          looks_wrong: true,
          probes_available: true,
          cancel_leak_mappable: false,
          message: "Confirm or correct this mapping.",
          schema: {
            tables: [
              { name: "trips", columns: ["carId", "createdAt", "additionalPhotoTimestamps"] },
              { name: "carlistings", columns: ["_id", "createdAt"] },
            ],
          },
          tenant_id: "t-1",
        }}
        onConfirmed={() => {}}
      />,
    );
    expect(html).toContain("carId");
    expect(html).toContain("<select");
    expect(html).toContain("look wrong");
    expect(html).toContain("additionalPhotoTimestamps");
    expect(html).toContain("cancellation reason field is mapped");
    expect(html).toContain("Confirm mapping and run diagnosis");
  });

  it("diagnosed view renders ranked constraints + evidence + abstained reasons", () => {
    const html = renderToStaticMarkup(
      <DiagnosedView
        data={{
          status: "diagnosed",
          catalog_hash: "h1",
          confirmed_at: "2026-07-05T00:00:00Z",
          window_days: 30,
          probes: [],
          constraints: [
            {
              constraint: "verification-cancel-leak",
              rank: 1,
              rate: 0.234,
              bucket_volume: 812,
              evidence: {
                numerator: 190,
                denominator: 812,
                source: "measured",
                query_id: "q_abc123",
              },
              elasticity_hint: "high",
              build_cost_hint: "medium",
            },
          ],
          abstained: [{ constraint: "idle-supply", reason: "join_unavailable" }],
          note: "Ranked by measured volume × rate from your data.",
          tenant_id: "t-1",
        }}
      />,
    );
    expect(html).toContain("Verification Cancel Leak");
    expect(html).toContain("23.4%");
    expect(html).toContain("812");
    expect(html).toContain("190 / 812");
    expect(html).toContain("measured");
    expect(html).toContain("q_abc123");
    expect(html).toContain("Idle Supply");
    expect(html).toContain("Join Unavailable");
  });
});
