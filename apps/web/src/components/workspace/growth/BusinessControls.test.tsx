// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BusinessControls } from "./BusinessControls";
const defaults = {
  enabled: false,
  metric: "cpa",
  max_cpa_usd: 25,
  min_roas: 1,
  min_results: 10,
  min_spend_usd: 50,
  min_age_days: 7,
  exploration_percent: 10,
  step_percent: 20,
  reporting_delay_hours: 24,
  automatic_stops: false,
};
let snapshot: any;
const writes: any[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (_path: string, opts?: any) => {
    if (opts?.method) {
      writes.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ revision: 2 }) };
    }
    return { ok: true, json: async () => snapshot };
  },
}));
beforeEach(() => {
  writes.length = 0;
  snapshot = {
    policy: null,
    recommendation: {
      policy: defaults,
      explanation: "Editable starting values",
    },
    can_manage: true,
    objects: [],
    experiments: [],
    limitations: "Reporting is delayed.",
  };
});
afterEach(cleanup);
it("prefills recommendations and saves edits only after explicit save", async () => {
  render(<BusinessControls />);
  const cpa = await screen.findByLabelText("Maximum cost per purchase ($)");
  expect((cpa as HTMLInputElement).value).toBe("25");
  expect(
    (screen.getByLabelText(/Allow Autopilot/) as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.change(cpa, { target: { value: "32" } });
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByText("Save controls"));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    revision: 0,
    policy: { max_cpa_usd: 32, automatic_stops: false },
  });
});
it("round-trips saved controls without sending server metadata", async () => {
  snapshot.policy = {
    ...defaults,
    enabled: true,
    automatic_stops: true,
    revision: 7,
    updated_at: "2026-10-09T00:00:00Z",
  };
  render(<BusinessControls />);
  await screen.findByText("Save controls");
  fireEvent.click(screen.getByLabelText(/Allow Autopilot/));
  fireEvent.click(screen.getByText("Save controls"));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].revision).toBe(7);
  expect(writes[0].policy.automatic_stops).toBe(false);
  expect(writes[0].policy).not.toHaveProperty("updated_at");
  expect(writes[0].policy).not.toHaveProperty("revision");
});
it("does not save a blank or invalid numeric limit", async () => {
  render(<BusinessControls />);
  fireEvent.change(
    await screen.findByLabelText("Maximum cost per purchase ($)"),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByText("Save controls"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Check the numeric limits",
  );
  expect(writes).toHaveLength(0);
});
it("restoring recommendations does not silently enable stop permission", async () => {
  snapshot.policy = {
    ...defaults,
    enabled: true,
    automatic_stops: true,
    revision: 1,
  };
  render(<BusinessControls />);
  fireEvent.click(await screen.findByText("Restore recommendations"));
  expect(
    (screen.getByLabelText(/Allow Autopilot/) as HTMLInputElement).checked,
  ).toBe(false);
  expect(writes).toHaveLength(0);
});
it("members can inspect controls and pending stops but cannot save", async () => {
  snapshot.can_manage = false;
  snapshot.experiments = [
    {
      id: "e1",
      name: "Acquisition test",
      state: "stop_failed",
      spent_usd: 40,
      exposure_usd: 61,
      budget_usd: 60,
      reason: "Provider pause failed",
    },
  ];
  render(<BusinessControls />);
  expect(await screen.findByText("Acquisition test: stop failed")).toBeTruthy();
  expect(screen.getByText("Save controls").closest("fieldset")?.disabled).toBe(
    true,
  );
  expect(screen.getByText("Provider pause failed")).toBeTruthy();
});
