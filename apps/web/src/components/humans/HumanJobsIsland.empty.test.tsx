import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("./useHumanResource", () => ({
  useHumanResource: () => ({ data: { jobs: [] }, loading: false, error: null, sessionExpired: false, notBuilt: false, reload: () => {} }),
}));

vi.mock("@zavi/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zavi/shared")>()),
  CREATOR_MARKETPLACE_ENABLED: false,
}));

import { HumanJobsIsland } from "./HumanJobsIsland";

describe("the jobs list with the creator marketplace retired", () => {
  it("says there are no existing jobs and offers no way to book or brief a creator", () => {
    const html = renderToString(<HumanJobsIsland />);
    expect(html).toContain("No existing jobs");
    expect(html).not.toContain("Open your briefs");
    expect(html).not.toContain("book a creator");
    expect(html).not.toContain('href="/humans"');
  });
});
