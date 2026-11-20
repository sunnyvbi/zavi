// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectAppsView, type ConnectAppsViewProps } from "./ConnectAppsView";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "onboarding-font" }) }));
vi.mock("../settings/connectorErrorDialog", () => ({ ConnectorErrorHost: () => null }));
vi.mock("./ConnectAppsGuide", () => ({ ConnectAppsGuide: () => null }));
afterEach(cleanup);

const apps = (names: string[] = []) => ({
  query: "", setQuery: vi.fn(), readOnly: false, returnError: false, error: null, refresh: vi.fn(),
  loading: false, names, apps: [], hasMore: false, showMore: vi.fn(), busy: null,
}) as unknown as ConnectAppsViewProps["apps"];

function view(busy: boolean, names: string[] = []) {
  const props = { apps: apps(names), onContinue: vi.fn(), onSkip: vi.fn(), onBack: vi.fn() };
  const result = render(<ConnectAppsView {...props} busy={false} />);
  return { ...props, settle: (next: boolean) => result.rerender(<ConnectAppsView {...props} busy={next} />), busy };
}
const spins = (name: RegExp) => !!screen.getByRole("button", { name }).querySelector(".animate-spin");

describe("Connect apps footer", () => {
  it("spins the Skip button while skipping, with no workspace message", () => {
    const v = view(false);
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(v.onSkip).toHaveBeenCalledOnce();
    v.settle(true);
    expect(spins(/Skip/)).toBe(true);
    expect(screen.queryByText(/Preparing your workspace/)).toBeNull();
  });

  it("announces skipping, including when setup is closed with Escape (no button pressed)", () => {
    const v = view(false);
    v.settle(true);
    expect(screen.getByRole("button", { name: /Skipping/ })).toBeTruthy();
    expect(spins(/Skipping/)).toBe(true);
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Skipping app setup…")).toBe(true);
  });

  it("spins only the button that was pressed", () => {
    const v = view(false, ["Gmail"]);
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    v.settle(true);
    expect(spins(/Skip/)).toBe(true);
    expect(screen.queryByText("Preparing…")).toBeNull();
  });
});

describe("Connect apps groups", () => {
  it("renders a heading per group with its apps", () => {
    const a = { ...apps(), isConnected: () => false, needsMore: () => false, availability: () => "ready", open: null, connect: vi.fn(), request: vi.fn(),
      groups: [{ title: "Analytics", apps: [{ slug: "google_analytics", name: "Google Analytics", category: "Analytics", what: "Traffic", via: "launch" }],
        more: [{ slug: "posthog", name: "PostHog", category: "Analytics", what: "Funnels", via: "row" }] },
        { title: "Ads", apps: [{ slug: "meta_ads", name: "Meta Ads", category: "Ads", what: "Ads", via: "launch" }], more: [] }] } as unknown as ConnectAppsViewProps["apps"];
    render(<ConnectAppsView apps={a} onContinue={vi.fn()} onSkip={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Analytics" });
    expect(list.textContent).toContain("Google Analytics");
    expect(list.textContent).not.toContain("PostHog");
    expect(screen.getAllByRole("button", { name: /See more/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "See more (1)" }));
    expect(list.textContent).toContain("PostHog");
    fireEvent.click(screen.getByRole("button", { name: "See less" }));
    expect(list.textContent).not.toContain("PostHog");
  });
});
