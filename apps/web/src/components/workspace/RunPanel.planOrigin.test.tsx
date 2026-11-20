// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { RunPanel as RunPanelModel } from "@zavi/shared";
import { RunPanel } from "./RunPanel";

const PLAN = "Read the booking flow code, then explain the guest steps.";

function model(): RunPanelModel {
  return {
    state: "running",
    summary: "Read your project…",
    toolCount: 0,
    items: [
      { type: "thought", key: "p", text: PLAN, origin: "plan" },
      { type: "thought", key: "s", text: "Looking at the checkout page first." },
      { type: "group", key: "g", label: "Read your project", count: 1, state: "running", tools: [{ key: "t", name: "file_read", input: "", output: "", ms: 0, state: "running" }] },
    ],
  };
}

afterEach(cleanup);

describe("RunPanel — plan-origin thought", () => {
  it("draws the plan summary muted and the agent's own sentence at full strength", () => {
    const { container } = render(<RunPanel model={model()} agentSlug="engineer" state="running" />);
    const planLine = [...container.querySelectorAll("p")].find((p) => p.textContent === PLAN);
    const ownLine = [...container.querySelectorAll("p")].find((p) => p.textContent === "Looking at the checkout page first." && !p.closest(".sr-only"));
    expect(planLine?.className).toContain("text-ink/55");
    expect(ownLine?.className).toContain("text-ink/85");
  });

  it("does not announce the plan summary as the agent speaking", () => {
    const { container } = render(<RunPanel model={model()} agentSlug="engineer" state="running" />);
    const spoken = container.querySelector(".sr-only:not(span)")?.textContent ?? "";
    expect(spoken).toContain("Looking at the checkout page first.");
    expect(spoken).not.toContain(PLAN);
  });
});
