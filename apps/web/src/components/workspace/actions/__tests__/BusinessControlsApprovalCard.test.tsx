// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BusinessControlsApprovalCard } from "../BusinessControlsApprovalCard";
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));
const policy = {
  enabled: true,
  metric: "cpa",
  max_cpa_usd: 75,
  min_roas: 1,
  min_results: 10,
  min_spend_usd: 150,
  min_age_days: 7,
  exploration_percent: 10,
  step_percent: 20,
  reporting_delay_hours: 24,
  automatic_stops: false,
};
let snap: any;
const writes: any[] = [];
beforeEach(() => {
  writes.length = 0;
  snap = {
    proposal: {
      id: "d",
      status: "proposed",
      body: {
        policy: { ...policy },
        revision: 0,
        rationale: "Proposed limits; profit not verified.",
      },
    },
    current_policy: null,
    can_manage: true,
  };
  m.fetch.mockImplementation(async (_url: string, opts?: any) => {
    if (opts?.method) {
      if (_url.endsWith("reject")) {
        snap.proposal.status = "rejected";
      } else {
        const b = JSON.parse(opts.body);
        writes.push(b);
        snap = {
          ...snap,
          proposal: {
            ...snap.proposal,
            status: "acted",
            body: {
              ...snap.proposal.body,
              policy: b.business_controls.policy,
              saved_revision: 1,
            },
          },
          current_policy: { ...b.business_controls.policy, revision: 1 },
        };
      }
    }
    return { ok: true, json: async () => structuredClone(snap) };
  });
});
afterEach(cleanup);
const mount = async (
  onResolved?: (resolution: "approved" | "rejected") => void,
) => {
  render(
    <BusinessControlsApprovalCard decisionId="d" onResolved={onResolved} />,
  );
  await screen.findByText(
    "Proposed settings, not saved yet. Edit any value, then approve to save.",
  );
};
it("edits inline, submits the edited values plus original version, and verifies saved receipt", async () => {
  const resolved = vi.fn();
  await mount(resolved);
  fireEvent.change(screen.getByLabelText("Maximum cost per purchase ($)"), {
    target: { value: "80" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
  await screen.findByText(/Business controls saved. Revision 1/);
  expect(resolved).toHaveBeenCalledWith("approved");
  expect(writes).toHaveLength(1);
  expect(writes[0].business_controls).toEqual({
    policy: { ...policy, max_cpa_usd: 80 },
    expected_policy: policy,
    revision: 0,
  });
  expect(
    (screen.getByLabelText("Maximum cost per purchase ($)") as HTMLInputElement)
      .value,
  ).toBe("80");
  expect(
    (screen.getByLabelText(/Allow Autopilot/) as HTMLInputElement).checked,
  ).toBe(false);
});
it("requires explicit approval of automatic-stop permission", async () => {
  await mount();
  fireEvent.click(screen.getByLabelText(/Allow Autopilot/));
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
  await waitFor(() =>
    expect(writes[0].business_controls.policy.automatic_stops).toBe(true),
  );
});
it("reject does not save settings", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await screen.findByText(/Proposal rejected/);
  expect(writes).toHaveLength(0);
});
it("invalid or fractional evidence values do not send an approval", async () => {
  await mount();
  fireEvent.change(screen.getByLabelText("Minimum purchases"), {
    target: { value: "1.5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
  await screen.findByText("Check the numeric limits before saving.");
  expect(writes).toHaveLength(0);
});
it("stale policy blocks approval", async () => {
  snap.current_policy = { ...policy, revision: 2 };
  await mount();
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and save",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByText(/Saved settings changed after this proposal/),
  ).toBeTruthy();
});
it("members can read but cannot edit, approve or reject", async () => {
  snap.can_manage = false;
  await mount();
  expect(
    screen.getByLabelText("Maximum cost per purchase ($)").closest("fieldset")
      ?.disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and save",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("a failed approval preserves edits and does not claim success", async () => {
  await mount();
  m.fetch.mockResolvedValueOnce({
    ok: false,
    json: async () => ({
      error: { message: "Settings changed. Review again." },
    }),
  });
  fireEvent.change(screen.getByLabelText("Maximum cost per purchase ($)"), {
    target: { value: "90" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
  await screen.findByText("Settings changed. Review again.");
  expect(
    (screen.getByLabelText("Maximum cost per purchase ($)") as HTMLInputElement)
      .value,
  ).toBe("90");
  expect(screen.queryByText(/Business controls saved/)).toBeNull();
});
it("labels reasoning and the Pro requirement before approval", async () => {
  await mount();
  expect(
    screen.getByText("Zavi’s reasoning (not independently verified)"),
  ).toBeTruthy();
  expect(
    screen.getByText(/Enabling business-result controls requires a Pro plan/),
  ).toBeTruthy();
});
it("a load failure stops loading and Retry clears the error after a successful read", async () => {
  m.fetch.mockRejectedValueOnce(new Error("Could not load this proposal."));
  render(<BusinessControlsApprovalCard decisionId="d" />);
  await screen.findByText("Could not load this proposal.");
  expect(screen.queryByText("Loading proposal…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/Proposed settings, not saved yet/);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("shows the server's Pro refusal and keeps edits available", async () => {
  await mount();
  m.fetch.mockResolvedValueOnce({
    ok: false,
    json: async () => ({
      error: {
        code: "plan_required",
        message: "A Pro plan is required to enable business-result controls.",
      },
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "Pro plan is required",
  );
  expect(
    (screen.getByLabelText("Use business-result controls") as HTMLInputElement)
      .disabled,
  ).toBe(false);
});
