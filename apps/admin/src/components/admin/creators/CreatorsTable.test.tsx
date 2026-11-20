import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));

import { CreatorsRows, queuePath, type CreatorRow } from "./CreatorsTable";

const live: CreatorRow = {
  id: "11111111-1111-1111-1111-111111111111",
  display_name: "Ada Test",
  slug: "ada",
  city: "Austin",
  country_code: "US",
  vetting_state: "approved",
  rejected_reason: null,
  created_at: "2026-09-20T00:00:00Z",
};
const gone: CreatorRow = { ...live, id: "22222222-2222-2222-2222-222222222222", display_name: "Bo", vetting_state: "rejected", rejected_reason: "Test creator" };

const noop = () => {};
const base = { confirmingId: null, reason: "Test creator", busyId: null, onDisable: noop, onReasonChange: noop, onConfirm: noop, onCancel: noop };

describe("queuePath", () => {
  it("lists creators newest first and filters by state except for All", () => {
    expect(queuePath("approved", 0)).toBe(
      "/api/admin/humans?discipline=ugc_creator&sort=newest&limit=100&offset=0&vetting_state=approved",
    );
    expect(queuePath("all", 100)).not.toContain("vetting_state");
  });
});

describe("CreatorsRows", () => {
  it("shows Disable for a live creator and none for a disabled one", () => {
    const html = renderToStaticMarkup(<CreatorsRows {...base} rows={[live, gone]} />);
    expect(html).toContain("Ada Test");
    expect(html).toContain("Austin, US");
    expect(html.match(/>Disable</g)?.length).toBe(1);
    expect(html).toContain("disabled");
    expect(html).toContain("Test creator");
  });

  it("asks for a reason before disabling", () => {
    const html = renderToStaticMarkup(<CreatorsRows {...base} rows={[live]} confirmingId={live.id} />);
    expect(html).toContain('aria-label="Reason"');
    expect(html).toContain(">Confirm<");
    expect(html).not.toContain(">Disable<");
  });
});
