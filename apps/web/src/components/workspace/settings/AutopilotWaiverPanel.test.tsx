// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type ClassRow = {
  slug: string;
  description: string | null;
  default_autonomy: string;
  tenant_override: string | null;
  effective: string;
  never_auto?: boolean;
  max_daily_usd: number | null;
  max_per_action_usd: number | null;
};
const classes: ClassRow[] = [
  {
    slug: "meta_ads.create_ad_set",
    description: "engineer-facing text",
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    max_daily_usd: 25,
    max_per_action_usd: null,
  },
  {
    slug: "bulk_outbound.send",
    description: null,
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    never_auto: true,
    max_daily_usd: null,
    max_per_action_usd: null,
  },
  {
    slug: "pm.ship_change",
    description: null,
    default_autonomy: "approval",
    tenant_override: null,
    effective: "forbidden",
    max_daily_usd: null,
    max_per_action_usd: null,
  },
];
classes.push(
  {
    slug: "linkedin_ads.launch_campaign",
    description:
      "One new LinkedIn Ads campaign from a launch plan, spending from the shared ad budget. Body: services/ads-wallet/linkedin-growth.ts.",
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    never_auto: true,
    max_daily_usd: 40,
    max_per_action_usd: null,
  },
  {
    slug: "linkedin_ads.create_campaign_bundle",
    description: null,
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    max_daily_usd: null,
    max_per_action_usd: null,
  },
  {
    slug: "snapchat_ads.new_thing",
    description: "Does a snapchat thing. Body: services/x.ts.",
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    max_daily_usd: null,
    max_per_action_usd: null,
  },
  {
    slug: "snapchat_ads.only_path",
    description: "Body: services/y.ts.",
    default_autonomy: "approval",
    tenant_override: null,
    effective: "approval",
    max_daily_usd: null,
    max_per_action_usd: null,
  },
);
const waivers = [
  {
    decision_class: "meta_ads.create_ad_set",
    expires_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    max_daily_usd: 10,
    cooling_off_seconds: 0,
  },
];

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    const body =
      path === "/api/workspace/autopilot"
        ? { classes, fleet_halted: false, autopilot_enabled: true }
        : path === "/api/workspace/autopilot/waivers"
          ? { waivers }
          : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));

import { AutopilotWaiverPanel } from "./AutopilotWaiverPanel";

afterEach(cleanup);

describe("AutopilotWaiverPanel layout", () => {
  it("renders each action as a titled card with its state, cap and waiver, not a table", async () => {
    const { container } = render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("meta_ads.create_ad_set")).closest("li")!;

    expect(container.querySelector("table")).toBeNull();
    expect(within(card).getByText("Money")).toBeTruthy();
    expect(within(card).getByText("Needs approval")).toBeTruthy();
    expect(within(card).getByText("$25.00/day")).toBeTruthy();
    expect(within(card).getByText(/Active · \dh left/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(within(card).queryByText("engineer-facing text")).toBeNull();
  });

  it("says a forbidden action can't be waived instead of offering a grant button", async () => {
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("pm.ship_change")).closest("li")!;

    expect(within(card).getByText("Can't be waived")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Grant waiver" })).toBeNull();
    expect(within(card).getByText("n/a")).toBeTruthy();
  });

  it("never offers a waiver on an action that always needs approval, even though it reads Needs approval", async () => {
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("bulk_outbound.send")).closest("li")!;

    expect(within(card).getByText("Needs approval")).toBeTruthy();
    expect(within(card).getByText("Can't be waived")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Grant waiver" })).toBeNull();
  });

  it("opens the grant dialog with labelled fields from the shared form controls", async () => {
    classes[0].effective = "approval";
    waivers.length = 0;
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("meta_ads.create_ad_set")).closest("li")!;

    fireEvent.click(within(card).getByRole("button", { name: "Grant waiver" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("dialog-scrim");
    expect(dialog.className).not.toContain("bg-ink/40");
    expect(within(dialog).getByLabelText("Ends at (up to 7 days from now)")).toBeTruthy();
    expect(within(dialog).getByLabelText("Max daily spend (USD, 0–100)")).toBeTruthy();
    expect(within(dialog).getByLabelText(/Cooling-off seconds/)).toBeTruthy();
  });
});

describe("AutopilotWaiverPanel founder-facing copy", () => {
  it("titles LinkedIn Ads correctly and shows the plain blurb with no source path", async () => {
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("linkedin_ads.launch_campaign")).closest("li")!;

    expect(card.textContent).toContain("LinkedIn Ads");
    expect(card.textContent).not.toContain("Linkedin Ads");
    expect(card.textContent).toContain("Switches on one of your paused LinkedIn campaigns");
    expect(card.textContent).not.toContain("Body:");
    expect(card.textContent).not.toContain(".ts");
  });

  it("describes a LinkedIn launch as switching on a paused campaign with its approved total, and offers no daily cap that nothing enforces", async () => {
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("linkedin_ads.launch_campaign")).closest("li")!;
    expect(card.textContent).toContain("total budget");
    expect(card.textContent).toContain("own LinkedIn ad account");
    expect(card.textContent).not.toMatch(/daily cap|new LinkedIn campaign|shared ad budget/i);
    expect(within(card).queryByText("Daily cap")).toBeNull();
    expect(within(card).queryByText("$40.00/day")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(card).queryByLabelText(/Daily cap for/)).toBeNull();
    const meta = (await screen.findByText("meta_ads.create_ad_set")).closest("li")!;
    expect(within(meta).getByText("Daily cap")).toBeTruthy();
    expect(within(meta).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("sends a paused LinkedIn campaign to Review launch in Zavi, not to Campaign Manager", async () => {
    render(<AutopilotWaiverPanel />);
    const card = (await screen.findByText("linkedin_ads.create_campaign_bundle")).closest("li")!;
    expect(card.textContent).toContain("Review launch on your LinkedIn Ads page in Zavi");
    expect(card.textContent).not.toContain("Campaign Manager");
  });

  it("strips source paths from an unmapped class description, and falls back when nothing is left", async () => {
    render(<AutopilotWaiverPanel />);
    const stripped = (await screen.findByText("snapchat_ads.new_thing")).closest("li")!;
    const empty = screen.getByText("snapchat_ads.only_path").closest("li")!;

    expect(stripped.textContent).toContain("Does a snapchat thing.");
    expect(stripped.textContent).not.toContain("Body:");
    expect(stripped.textContent).not.toContain(".ts");
    expect(empty.textContent).toContain("No description available. Review before granting a waiver.");
    expect(empty.textContent).not.toContain("Body:");
    expect(empty.textContent).not.toContain(".ts");
  });
});
