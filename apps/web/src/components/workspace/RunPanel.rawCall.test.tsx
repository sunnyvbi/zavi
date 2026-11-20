// @vitest-environment jsdom
import { humanizeToolName } from "@/lib/workspace/humanizeToolName";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { RunPanel as RunPanelModel } from "@zavi/shared";
import { RunPanel } from "./RunPanel";

const url =
  "http://localhost:3011/api/public/workspace-files/b92dcbf1-bac9-457a-af81-0bbe5984339b/cd9ec0c2-1c87-483f-9930-4a18bc701015/musashi.jpeg";

function panel(input: string, output: string): RunPanelModel {
  return {
    state: "finished",
    summary: "Brought in a specialist",
    toolCount: 1,
    items: [
      {
        type: "group",
        key: "g1",
        label: "Brought in a specialist",
        count: 1,
        state: "done",
        tools: [{ key: "t1", name: "handoff", input, output, ms: 0, state: "done" }],
      },
    ],
  };
}

afterEach(cleanup);

describe("RunPanel raw call", () => {
  it("reads a cut-off handoff as labelled fields, not JSON", () => {
    const input = `{"target_agent_slug":"engineer","intent":"Use this uploaded photo on the landing page.\\n\\nPhoto: ${url}\\nPlace it as the hero, will`;
    const output = JSON.stringify({ ok: true, routed_to: "refine_product", message: "I've started that change to your app." });
    render(<RunPanel model={panel(input, output)} agentSlug="operator" />);

    const card = screen.getByText(humanizeToolName("handoff")).closest("div.rounded-xl") as HTMLElement;
    expect(card.textContent).not.toMatch(/[{}]|\\n|→|←|"ok"|target_agent_slug/);
    const request = within(card).getByText("Request").parentElement!;
    expect(within(request).getByText("Target agent").nextElementSibling!.textContent).toMatch(/engineer/i);
    const intent = within(request).getByText("Intent").nextElementSibling as HTMLElement;
    expect(intent.textContent).toContain("Use this uploaded photo on the landing page.\n\nPlace it as the hero, will…");
    expect(within(intent).getByRole("list", { name: "Attached photo" }).querySelector("img")!.getAttribute("src")).toBe(url);

    const result = within(card).getByText("Result").parentElement!;
    expect(within(result).getByText("Routed to").nextElementSibling!.textContent).toBe("refine product");
    expect(within(result).getByText("Message").nextElementSibling!.textContent).toBe("I've started that change to your app.");
  });

  it("keeps a plain-text call exactly as it came", () => {
    render(<RunPanel model={panel("SELECT 1", "1 row")} agentSlug="operator" />);
    const card = screen.getByText(humanizeToolName("handoff")).closest("div.rounded-xl") as HTMLElement;
    expect(card.querySelector("pre")!.textContent).toBe("→ SELECT 1");
    expect(card.querySelectorAll("pre")[1]!.textContent).toBe("← 1 row");
  });

  it("QA l2.14: a build-step call shows its readable fields and never the raw JSON behind them", () => {
    const output = JSON.stringify({
      product_builds: 1,
      refines: 0,
      currently_live: false,
      live_reason: "None of the 1 apps is live yet.",
      apps: [{ kind: "site", id: "a1", status: "building" }],
      meta: { source: "builds" },
    });
    const model = panel("{}", output);
    const group = model.items[0] as Extract<RunPanelModel["items"][number], { type: "group" }>;
    group.label = "Ran a build step";
    group.tools[0]!.name = "praxis__list_product_builds";
    render(<RunPanel model={model} agentSlug="operator" />);

    const card = screen.getByText(humanizeToolName("praxis__list_product_builds")).closest("div.rounded-xl") as HTMLElement;
    expect(card.textContent).not.toMatch(/[{}[\]]|→|←|"kind"|"source"/);
    expect(within(card).queryByText("Request")).toBeNull();
    const result = within(card).getByText("Result").parentElement!;
    expect(within(result).getByText("Live reason").nextElementSibling!.textContent).toBe("None of the 1 apps is live yet.");
    expect(within(result).getByText("Product builds").nextElementSibling!.textContent).toBe("1");
    expect(within(result).queryByText("Apps")).toBeNull();
    expect(within(result).queryByText("Meta")).toBeNull();
  });

  it("QA l2.14: a cut-off JSON result or a bare JSON array draws nothing raw", () => {
    render(<RunPanel model={panel('[{"id":1,"kind":"site"}]', '{"apps":[{"kind":"site","id":"a1","sta')} agentSlug="operator" />);
    const card = screen.getByText(humanizeToolName("handoff")).closest("div.rounded-xl") as HTMLElement;
    expect(card.querySelector("pre")).toBeNull();
    expect(card.textContent).not.toMatch(/[{}[\]]|"kind"/);
  });

  it("a failed step whose error came back as cut-off JSON still says it failed, without the JSON", () => {
    const failed = panel("plain request", '[{"code":"timeout","message":"the step took too lo');
    const item = failed.items[0] as { tools: Array<{ state: string }> };
    item.tools[0]!.state = "failed";
    render(<RunPanel model={failed} agentSlug="operator" />);
    const card = screen.getByText(humanizeToolName("handoff")).closest("div.rounded-xl") as HTMLElement;
    expect(card.textContent).toContain("This step failed.");
    expect(card.textContent).not.toMatch(/[{}]|"code"/);
  });
  it("a cut-off list result shows only its top-level rows and logs no duplicate-key error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const output =
      '{"ok":true,"audiences":[{"id":"a","name":"N","member_count":6},{"id":"b","name":"M","member_count":3}],"next":"x';
    render(<RunPanel model={panel("{}", output)} agentSlug="operator" />);
    const card = screen.getByText(humanizeToolName("handoff")).closest("div.rounded-xl") as HTMLElement;
    const result = within(card).getByText("Result").parentElement!;
    expect(result.querySelectorAll("dt").length).toBe(1);
    expect(within(result).getByText("Next").nextElementSibling!.textContent).toContain("x");
    for (const label of ["Id", "Name", "Member count"]) expect(within(result).queryByText(label)).toBeNull();
    const duplicateKeyErrors = spy.mock.calls.filter((c) => String(c[0]).includes("same key"));
    spy.mockRestore();
    expect(duplicateKeyErrors).toEqual([]);
  });
});

