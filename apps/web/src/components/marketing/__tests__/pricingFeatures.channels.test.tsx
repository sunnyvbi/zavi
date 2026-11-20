// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { FeatureRow, PRICING_FEATURES } from "../pricingFeatures";

afterEach(cleanup);

describe("FeatureRow channel rows", () => {
  const channelRows = PRICING_FEATURES.filter((f) => f.channels);

  it("renders every channel as a visible line, not behind a disclosure", () => {
    expect(channelRows.length).toBeGreaterThan(0);
    for (const f of channelRows) {
      const { container } = render(<FeatureRow feature={f} included />);
      expect(container.querySelector("details")).toBeNull();
      const names = [...container.querySelectorAll("[data-channel]")].map((el) => el.getAttribute("data-channel"));
      expect(names).toEqual(f.channels!.map((c) => c.name));
      cleanup();
    }
  });

  it("never marks a channel as coming soon", () => {
    for (const f of channelRows) {
      const { container } = render(<FeatureRow feature={f} included />);
      expect(container.textContent).not.toMatch(/soon/i);
      cleanup();
    }
  });
});
