import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));
import {
  TenantsGrowthView,
  GrowthChart,
  rowClickOpensTenant,
} from "./TenantsGrowthView";
import { fixture } from "@/lib/tenants-growth-fixture";
it("renders staff customer columns, comp expiry and unknown location without example data", () => {
  const html = renderToStaticMarkup(
    <TenantsGrowthView initialData={fixture} />,
  );
  for (const text of [
    "All times in IST",
    "Person",
    "Plan start",
    "Plan end",
    "Last active",
    "Integrations",
    "Socials",
    "Country",
    "City",
    "Show test workspaces",
    "Usage columns",
    "ends 12 Nov 2026",
    "comp",
    "1 comped (excluded)",
    "1 signup without a workspace",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("test@yopmail.com");
  expect(html).toContain("overflow-x-auto");
  expect(html).not.toContain(">Cost</th>");
});
it("renders every day including zero days with accessible counts", () => {
  const html = renderToStaticMarkup(
    <GrowthChart
      rows={[
        { day: "2026-10-01", signups: 0, active: 0 },
        { day: "2026-10-02", signups: 3, active: 1 },
      ]}
      metric="signups"
      type="bar"
    />,
  );
  expect(html).toContain("2026-10-01: 0 signups");
  expect(html).toContain("2026-10-02: 3 signups");
});
it("opens the tenant from a row click, except on controls or while selecting text", () => {
  const plainCell = { closest: () => null };
  const checkbox = {
    closest: (sel: string) => (sel.includes("input") ? {} : null),
  };
  expect(rowClickOpensTenant(plainCell, "")).toBe(true);
  expect(rowClickOpensTenant(checkbox, "")).toBe(false);
  expect(rowClickOpensTenant(plainCell, "acme@example.com")).toBe(false);
});
it("links both the person and the workspace name to the tenant page", () => {
  const html = renderToStaticMarkup(
    <TenantsGrowthView initialData={fixture} />,
  );
  const id = fixture.tenants.find((t) => !t.is_test)?.id;
  expect(id).toBeTruthy();
  const links = html.split(`href="/tenants/${id}"`).length - 1;
  expect(links).toBe(2);
});

it("shows signup source and an affiliate account link in the workspace table", () => {
  const data = structuredClone(fixture);
  const tenant = data.tenants.find((t) => !t.is_test)!;
  Object.assign(tenant, {
    source: {
      source: "QA Creator",
      kind: "affiliate",
      creator_id: "creator-demo",
    },
  });
  const html = renderToStaticMarkup(<TenantsGrowthView initialData={data} />);
  expect(html).toContain("Signup source");
  expect(html).toContain("QA Creator");
  expect(html).toContain('href="/creator-network/creators/creator-demo"');
});

it("keeps missing sources distinct from an unavailable read and shows a retry", () => {
  const unavailable = renderToStaticMarkup(
    <TenantsGrowthView
      initialData={{ ...fixture, sources_available: false }}
    />,
  );
  expect(unavailable).toContain("Source unavailable");
  expect(unavailable).toContain("Retry sources");
  const data = structuredClone(fixture);
  Object.assign(data.tenants.find((t) => !t.is_test)!, {
    source: { source: "Unknown", kind: "unknown" },
    source_detail: "No recorded source",
  });
  const missing = renderToStaticMarkup(
    <TenantsGrowthView initialData={data} />,
  );
  expect(missing).toContain("No recorded source");
  expect(missing).not.toContain("Retry sources");
});
it("labels a creator channel without falsely linking it to an affiliate account", () => {
  const data = structuredClone(fixture);
  Object.assign(data.tenants.find((t) => !t.is_test)!, {
    source: { source: "cr-demo", kind: "from" },
  });
  const html = renderToStaticMarkup(<TenantsGrowthView initialData={data} />);
  expect(html).toContain("Channel code");
  expect(html).toContain("cr-demo");
  expect(html).not.toContain("/creator-network/creators/");
});
