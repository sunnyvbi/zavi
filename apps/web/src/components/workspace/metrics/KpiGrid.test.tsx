// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { KpiGrid } from "./KpiGrid";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
afterEach(cleanup);
it.each([
  { grounded: false, unmeasured: undefined, unverified: true },
  { grounded: true, unmeasured: undefined, unverified: false },
  { grounded: false, unmeasured: "Not measured yet", unverified: false },
])("keeps grounding visible: %j", ({ grounded, unmeasured, unverified }) => {
  const metric: ChannelMetric = { key: "visitors", value: 12, unit: "count", window_kind: "7d", day: "2026-11-12", grounded, unmeasured, prev_value: null, prev_day: null };
  render(<KpiGrid metrics={[metric]} display={{}} />);
  expect(!!screen.queryByText("unverified")).toBe(unverified);
  expect(screen.getByTestId("value-visitors").textContent).toBe(unmeasured ? "–" : "12");
});
