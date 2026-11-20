
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

import { TeamsConnectPanel } from "./TeamsConnectPanel";

describe("TeamsConnectPanel", () => {
  it("renders without throwing (initial loading state in SSR)", () => {
    const html = renderToStaticMarkup(React.createElement(TeamsConnectPanel, {}));
    expect(html).toContain("Microsoft Teams");
  });

  it("renders read-only without throwing", () => {
    const html = renderToStaticMarkup(
      React.createElement(TeamsConnectPanel, { readOnly: true }),
    );
    expect(typeof html).toBe("string");
  });
});
