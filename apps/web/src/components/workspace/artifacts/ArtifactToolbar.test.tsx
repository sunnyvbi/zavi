import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactToolbar } from "./ArtifactToolbar";

describe("ArtifactToolbar", () => {
  it("renders the server-safe custom artifact filter trigger", () => {
    const html = renderToString(
      <ArtifactToolbar
        query=""
        filter="all"
        view="grid"
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(html).toContain("Search artifacts");
    expect(html).toContain('aria-label="Filter artifacts by type"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<select");
  });

  it("says which filter is applied, and which view is selected", () => {
    const html = renderToString(
      <ArtifactToolbar
        query=""
        filter="website"
        view="list"
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Filter artifacts by type (Websites &amp; Apps selected)"');
    expect(html).toContain('aria-label="List view" title="List view" aria-pressed="true"');
    expect(html).toContain('aria-label="Grid view" title="Grid view" aria-pressed="false"');
  });
});
