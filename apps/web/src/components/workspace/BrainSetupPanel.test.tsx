// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrainSetupPanel, type BrainState } from "./GettingStartedCard";

const openTab = vi.fn();
const apiFetch = vi.fn();

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab }),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [{ slug: "slack" }], error: null }),
      }),
    }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: async () => "tenant-1",
}));

vi.mock("@/app/connectors/ConnectButton", () => ({
  ConnectButton: ({ slug, connected }: { slug: string; connected: boolean }) => (
    <button type="button" data-testid={`connect-${slug}`}>
      {connected ? "Reconnect" : "Connect"}
    </button>
  ),
}));
vi.mock("@/app/connectors/OperatorDbConnectButton", () => ({
  OperatorDbForm: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="operator-db-form">
      <button type="button" onClick={onClose}>
        close-db-form
      </button>
    </div>
  ),
}));

vi.mock("@/lib/workspace/useBuildProduct", () => ({
  useBuildProduct: () => ({
    buildAppIntent: "existing",
    companyScaleSegment: null,
    status: "none",
    loaded: true,
    enabled: false,
  }),
}));

const HUMAN_GAPS = ["disputes", "gtm_growth", "metrics_north_star"];
const OTHER_SLUGS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

function brainWithGaps(gaps: string[] = HUMAN_GAPS): BrainState {
  return {
    filled: 10 - gaps.length,
    total: 10,
    slots: [
      ...OTHER_SLUGS.map((slug) => ({ slug, status: "filled" as const })),
      ...HUMAN_GAPS.map((slug) => ({
        slug,
        status: gaps.includes(slug) ? ("missing" as const) : ("filled" as const),
      })),
    ],
  };
}

function okGapAnswer() {
  return {
    ok: true,
    json: async () => ({ ok: true, slot: { slug: "x", status: "filled" } }),
  };
}

beforeEach(() => {
  openTab.mockReset();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(okGapAnswer());
});

afterEach(cleanup);

describe("BrainSetupPanel — Figma Finish Setup card", () => {
  it("renders header title, N/10 Setups counter, and all four connect tiles", async () => {
    render(
      <BrainSetupPanel brain={brainWithGaps()} onDismiss={() => {}} defaultExpanded />,
    );
    expect(screen.getByText("Finish setting up your company")).toBeTruthy();
    expect(screen.getByText("7/10 Setups")).toBeTruthy();
    for (const label of ["Slack", "GitHub", "Jira", "Database"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    await waitFor(() =>
      expect(screen.getByTestId("connect-slack").textContent).toBe("Reconnect"),
    );
    expect(screen.getByTestId("connect-github").textContent).toBe("Connect");
  });

  it("Browse Tools opens the Settings tab", () => {
    render(
      <BrainSetupPanel brain={brainWithGaps()} onDismiss={() => {}} defaultExpanded />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse Tools" }));
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "settings" }),
    );
  });

  it("Database tile toggles the inline operator-db form (Connect ↔ Cancel)", () => {
    render(
      <BrainSetupPanel brain={brainWithGaps()} onDismiss={() => {}} defaultExpanded />,
    );
    const dbButtons = screen.getAllByRole("button", { name: "Connect" });
    const dbBtn = dbButtons[dbButtons.length - 1];
    fireEvent.click(dbBtn);
    expect(screen.getByTestId("operator-db-form")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByText("close-db-form"));
    expect(screen.queryByTestId("operator-db-form")).toBeNull();
  });

  it("steps through the gaps with Save & continue, supports Back with preserved drafts", async () => {
    render(
      <BrainSetupPanel brain={brainWithGaps()} onDismiss={() => {}} defaultExpanded />,
    );

    expect(screen.getByText(/Disputes · 3 left/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const save = screen.getByRole("button", { name: /Save & continue/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
      target: { value: "We refund within 48h." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save & continue/ }));

    await waitFor(() =>
      expect(screen.getByText(/Go-to-market & growth · 2 left/)).toBeTruthy(),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/onboarding/gap-answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ slug: "disputes", answer: "We refund within 48h." }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      (screen.getByPlaceholderText("Type your answer…") as HTMLTextAreaElement).value,
    ).toBe("We refund within 48h.");
    expect(screen.getByText(/Disputes · 2 left/)).toBeTruthy();
  });

  it("shows the all-set state after every gap is answered", async () => {
    render(
      <BrainSetupPanel brain={brainWithGaps()} onDismiss={() => {}} defaultExpanded />,
    );
    for (let i = 0; i < HUMAN_GAPS.length; i++) {
      fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
        target: { value: `answer ${i}` },
      });
      fireEvent.click(screen.getByRole("button", { name: /Save & continue/ }));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(i + 1));
    }
    await waitFor(() => expect(screen.getByText(/All set/)).toBeTruthy());
  });

  it("close button dismisses; collapsed mount expands via the teaser link", () => {
    const onDismiss = vi.fn();
    render(<BrainSetupPanel brain={brainWithGaps()} onDismiss={onDismiss} />);
    expect(screen.queryByText("Connect your tools")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Finish setup/ }));
    expect(screen.getByText("Connect your tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss brain setup" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
