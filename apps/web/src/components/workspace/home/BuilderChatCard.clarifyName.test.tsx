// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => true,
  isBuilderClarifyDynamicEnabled: () => false,
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tenantName: "Acme",
    creditsEnforced: false,
    builderRetryNonce: 0,
    ackBuilderRetry: () => {},
  }),
}));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
}));
vi.mock("./LiveAppCard", () => ({ LiveAppCard: () => null }));
vi.mock("./BuildStatusPanel", () => ({ BuildStatusPanel: () => null }));
vi.mock("./BuilderThread", () => ({ BuilderThread: () => null }));
vi.mock("./ThemeControls", () => ({ ThemeControls: () => null }));
vi.mock("@/components/workspace/Markdown", () => ({ Markdown: () => null }));

import { BuilderChatCard } from "./BuilderChatCard";
import { IDEA_MAX_CHARS } from "@/lib/workspace/useBuildProduct";

const BUILD_PATH = "/api/workspace/autopilot/build-product";
const NAME = "Lumen & Pine";
const NAME_LINE = `- Name: The business is called "${NAME}".`;
const CONTEXT = `\n\nAdditional context:\n${NAME_LINE}`;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  window.sessionStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/workspace/autopilot")
      return json({ resources: [], product_builder_enabled: true, build_app_intent: "fresh" });
    if (path.startsWith("/api/workspace/autopilot/build-status")) return json({ run: null });
    if (path === BUILD_PATH) return json({ ok: true, conductor_run_id: "run-1" });
    return { ok: false, status: 404, json: async () => ({}) };
  });
});
afterEach(cleanup);

function buildCalls() {
  return apiFetch.mock.calls.filter(([path]) => path === BUILD_PATH);
}

async function buildWithPickedName(idea: string): Promise<string> {
  render(<BuilderChatCard />);
  const composer = await screen.findByLabelText("Describe the app you want your AI team to build");
  fireEvent.change(composer, { target: { value: idea } });
  fireEvent.click(screen.getByRole("button", { name: "Build it" }));
  fireEvent.change(screen.getByLabelText("Type a name"), { target: { value: NAME } });
  for (let i = 0; i < 4 && !screen.queryByRole("button", { name: "Yes, build it" }); i++)
    fireEvent.click(screen.getByRole("button", { name: /^(Next|Continue)/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Yes, build it" }));
  });
  await waitFor(() => expect(buildCalls()).toHaveLength(1));
  const init = buildCalls()[0][1] as { method: string; body: string };
  expect(init.method).toBe("POST");
  return (JSON.parse(init.body) as { idea: string }).idea;
}

describe("the founder's picked name survives a long idea", () => {
  it("a 4000-char idea of a few long words still asks, and is trimmed so the posted build keeps the exact Name line within the cap", async () => {
    const idea = Array.from({ length: 10 }, (_, i) => `w${i}${"x".repeat(410)} `).join("").slice(0, IDEA_MAX_CHARS);
    expect(idea.length).toBe(IDEA_MAX_CHARS);
    const posted = await buildWithPickedName(idea);
    expect(posted.length).toBeLessThanOrEqual(IDEA_MAX_CHARS);
    expect(posted.endsWith(CONTEXT)).toBe(true);
    expect(posted.split("\n")).toContain(NAME_LINE);
    const head = posted.slice(0, posted.length - CONTEXT.length);
    expect(idea.startsWith(head)).toBe(true);
    expect(head.length).toBeGreaterThan(IDEA_MAX_CHARS - CONTEXT.length - 2);
  });

  it("an emoji idea cut at the boundary keeps the Name line and never leaves half a surrogate pair", async () => {
    const prefix = "Stable ";
    expect((IDEA_MAX_CHARS - CONTEXT.length - prefix.length) % 2).toBe(1);
    const idea = `${prefix}${"🐎".repeat(1996)}`;
    expect(idea.length).toBe(IDEA_MAX_CHARS - 1);
    expect(LONE_SURROGATE.test(idea)).toBe(false);
    const posted = await buildWithPickedName(idea);
    expect(posted.length).toBeLessThanOrEqual(IDEA_MAX_CHARS);
    expect(posted.endsWith(CONTEXT)).toBe(true);
    expect(LONE_SURROGATE.test(posted)).toBe(false);
    expect(posted.startsWith("Stable 🐎")).toBe(true);
    expect(posted.length).toBe(IDEA_MAX_CHARS - 1);
  });

  it("a short idea goes out exactly as clarified", async () => {
    const posted = await buildWithPickedName("Horse tinder for stable owners");
    expect(posted).toBe(`Horse tinder for stable owners${CONTEXT}`);
  });
});

describe("an idea that answers every question", () => {
  it("goes straight to the build confirm with no questions step and the idea unchanged", async () => {
    const idea = "I want to make my own biscuit shop where people can come and buy biscuits and order them. I have a biscuit shop of mine called Kuki Kaka";
    render(<BuilderChatCard />);
    const composer = await screen.findByLabelText("Describe the app you want your AI team to build");
    fireEvent.change(composer, { target: { value: idea } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(screen.queryByLabelText("Type a name")).toBeNull();
    expect(screen.queryByText("What do you have in mind for the name?")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, build it" }));
    });
    await waitFor(() => expect(buildCalls()).toHaveLength(1));
    expect((JSON.parse((buildCalls()[0][1] as { body: string }).body) as { idea: string }).idea).toBe(idea);
  });
});
