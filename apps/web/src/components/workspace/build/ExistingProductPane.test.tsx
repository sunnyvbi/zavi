// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const seedComposer = vi.hoisted(() => vi.fn());
const tree = vi.hoisted(() => ({
  agents: [{ slug: "engineer", locked_tier: null }] as Array<{ slug: string; locked_tier: string | null }>,
}));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ seedComposer, treeAgents: tree.agents }) }));
vi.mock("../ConnectRows", () => ({ ConnectRows: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("../CreditWallNotice", () => ({
  CreditWallNotice: ({ wall }: { wall: { message: string } }) => <div role="alert">{wall.message}</div>,
}));

import { ExistingProductPane } from "./ExistingProductPane";

afterEach(() => {
  cleanup();
  seedComposer.mockClear();
  tree.agents = [{ slug: "engineer", locked_tier: null }];
});

describe("ExistingProductPane", () => {
  it("renders the build chips plus Fix something on my site, and no Connect GitHub button", () => {
    render(<ExistingProductPane />);
    for (const label of ["Landing page", "Customer portal", "Analytics dashboard", "Fix something on my site"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Connect GitHub")).toBeNull();
  });

  it("a chip auto-sends its prompt in the engineer chat, exactly once", () => {
    render(<ExistingProductPane />);
    fireEvent.click(screen.getAllByRole("button", { name: "Fix a bug on my site" })[0]!);
    expect(seedComposer).toHaveBeenCalledTimes(1);
    expect(seedComposer).toHaveBeenCalledWith({
      agentSlug: "engineer",
      text: "Fix a bug on my site",
      autoSend: true,
    });
  });

  it("a typed send auto-sends the text in the engineer chat, exactly once", () => {
    render(<ExistingProductPane />);
    const box = screen.getByLabelText("Describe what you want to build or fix");
    fireEvent.change(box, { target: { value: "Make the footer links work" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(seedComposer).toHaveBeenCalledTimes(1);
    expect(seedComposer).toHaveBeenCalledWith({
      agentSlug: "engineer",
      text: "Make the footer links work",
      autoSend: true,
    });
  });

  it("engineer locked: Send does not seed or navigate; the text stays and the plan notice shows", () => {
    tree.agents = [{ slug: "engineer", locked_tier: "pro" }];
    render(<ExistingProductPane />);
    const box = screen.getByLabelText("Describe what you want to build or fix") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Make the footer links work" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(seedComposer).not.toHaveBeenCalled();
    expect(box.value).toBe("Make the footer links work");
    expect(screen.getByRole("alert").textContent).toBe("This needs the Pro plan. Upgrade to use it.");
  });

  it("tier unknown (tree not loaded): a chip fills the composer, no seed, notice shown", () => {
    tree.agents = [];
    render(<ExistingProductPane />);
    fireEvent.click(screen.getAllByRole("button", { name: "Fix a bug on my site" })[0]!);
    expect(seedComposer).not.toHaveBeenCalled();
    const box = screen.getByLabelText("Describe what you want to build or fix") as HTMLTextAreaElement;
    expect(box.value).toBe("Fix a bug on my site");
    expect(screen.getByRole("alert").textContent).toBe("Your plan doesn't include this. Upgrade to use it.");
  });

  it("runnable: no notice before or after a send", () => {
    render(<ExistingProductPane />);
    fireEvent.click(screen.getAllByRole("button", { name: "Fix a bug on my site" })[0]!);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
