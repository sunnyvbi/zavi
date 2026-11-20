// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const startBuildSession = vi.fn();
const apiFetch = vi.fn();
let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: (...args: unknown[]) => startBuildSession(...args),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => true,
  isBuilderClarifyDynamicEnabled: () => false,
}));

import { BuildModePane } from "./BuildModePane";

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    loaded: false,
    notFound: false,
    loadError: null,
    run: null,
    isCurrent: true,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(async () => null),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(sessionId: string | null) {
  const onOpenSession = vi.fn();
  render(
    <BuildModePane
      sessionId={sessionId}
      active
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={onOpenSession}
      onNewBuild={vi.fn()}
    />,
  );
  return { onOpenSession };
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: /describe/i }) as HTMLTextAreaElement;
}

function typeAndSend(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
}

function planReply(markdown: string) {
  return { ok: true, status: 200, json: async () => ({ plan_markdown: markdown }) };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  startBuildSession.mockReset();
  apiFetch.mockReset();
  sessionState = baseSession();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("a new build asks its questions first", () => {
  it("asks the name first and starts the build with the answers folded in", async () => {
    startBuildSession.mockResolvedValue({ id: "run-1" });
    const { onOpenSession } = renderPane(null);

    typeAndSend("A site for a neighbourhood bike repair shop");
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(screen.getByText("What do you have in mind for the name?")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Type the name you want…"), { target: { value: "Spoke & Chain" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("run-1", true));
    const { idea } = startBuildSession.mock.calls[0][0] as { idea: string };
    expect(idea.startsWith("A site for a neighbourhood bike repair shop\n\nAdditional context:\n")).toBe(true);
    expect(idea).toContain('- Name: The business is called "Spoke & Chain".');
    expect(idea).not.toMatch(/logo/i);
  });

  it("an idea that already gives the name, the customers and what they do starts at once, with no questions step ever on screen", async () => {
    startBuildSession.mockResolvedValue({ id: "run-kk" });
    const idea = "I want to make my own biscuit shop where people can come and buy biscuits and order them. I have a biscuit shop of mine called Kuki Kaka";
    const seen: boolean[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof Element) seen.push(n.matches('[data-testid="build-clarify"]') || !!n.querySelector('[data-testid="build-clarify"]') || (n.textContent ?? "").includes("A few quick questions"));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    renderPane(null);
    typeAndSend(idea);
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    observer.disconnect();
    expect(startBuildSession).toHaveBeenCalledWith({ idea, companyName: "Acme" });
    expect(seen.some(Boolean)).toBe(false);
    expect(screen.queryByText("What do you have in mind for the name?")).toBeNull();
  });

  it("a detailed brief with no recognisable name or customer words starts at once, with no questions step ever on screen", async () => {
    startBuildSession.mockResolvedValue({ id: "run-crumb" });
    const idea =
      "Build a landing page for a neighbourhood bakery caled Crumb & Co. Style: warm, minimal, cream and browncolours, serif headings. Sections: hero with order btton, our breads, opening hours, contact.";
    const seen: boolean[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof Element) seen.push((n.textContent ?? "").includes("A few quick questions") || (n.textContent ?? "").includes("Who is this app for?"));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    renderPane(null);
    typeAndSend(idea);
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    observer.disconnect();
    expect(startBuildSession).toHaveBeenCalledWith({ idea, companyName: "Acme" });
    expect(seen.some(Boolean)).toBe(false);
    expect(apiFetch).not.toHaveBeenCalledWith("/api/workspace/autopilot/clarify-questions", expect.anything());
  });

  it("a short idea still asks before building", () => {
    renderPane(null);
    typeAndSend("A bakery website");
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(screen.getByText("What do you have in mind for the name?")).toBeTruthy();
  });

  it("Skip all starts the build with the idea as typed", async () => {
    startBuildSession.mockResolvedValue({ id: "run-2" });
    renderPane(null);
    typeAndSend("An online store for handmade candles");
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    expect(startBuildSession).toHaveBeenCalledWith({ idea: "An online store for handmade candles", companyName: "Acme" });
  });

  it("Edit my idea goes back to the composer with the idea kept and nothing started", () => {
    renderPane(null);
    typeAndSend("A booking page for a tutoring service");
    fireEvent.click(screen.getByRole("button", { name: "Edit my idea" }));
    expect(composer().value).toBe("A booking page for a tutoring service");
    expect(screen.queryByTestId("build-clarify")).toBeNull();
    expect(startBuildSession).not.toHaveBeenCalled();
  });

  it("a refused start after the questions shows the error and keeps the idea", async () => {
    startBuildSession.mockResolvedValue({ error: "Not enough credits to start this build." });
    renderPane(null);
    typeAndSend("A site for a neighbourhood bike repair shop");
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not enough credits to start this build.");
    expect(composer().value).toBe("A site for a neighbourhood bike repair shop");
  });
});

describe("a refused start keeps what the founder answered", () => {
  it("sending the same idea again reuses the answers instead of asking again", async () => {
    startBuildSession.mockResolvedValueOnce({ error: "Not enough credits to start this build." }).mockResolvedValueOnce({ id: "run-5" });
    const { onOpenSession } = renderPane(null);
    typeAndSend("A site for a neighbourhood bike repair shop");
    fireEvent.change(screen.getByPlaceholderText("Type the name you want…"), { target: { value: "Spoke & Chain" } });
    for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");

    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("run-5", true));
    expect(screen.queryByTestId("build-clarify")).toBeNull();
    expect((startBuildSession.mock.calls[1][0] as { idea: string }).idea).toContain('- Name: The business is called "Spoke & Chain".');
  });
});

describe("Plan mode in the Build view", () => {
  it("a new build has no Plan toggle: Send asks the questions, then builds (no plan step)", async () => {
    startBuildSession.mockResolvedValue({ id: "run-3" });
    renderPane(null);
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    typeAndSend("A portfolio for a wedding photographer");
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    expect(apiFetch).not.toHaveBeenCalledWith("/api/workspace/autopilot/plan", expect.anything());
    expect(screen.queryByTestId("plan-review")).toBeNull();
  });

  it("plans a change on a finished site and applies it as one change", async () => {
    const sendRefine = vi.fn(async () => null);
    sessionState = baseSession({
      loaded: true,
      sendRefine,
      liveUrl: "https://site.example.com",
      previewUrl: "https://site.example.com",
      previewKind: "final",
      run: {
        id: "run-9",
        objective: "A site for a dog grooming salon",
        status: "done",
        createdAt: null,
        updatedAt: null,
        stages: [{ stage: "provision", status: "done" }],
        failure: null,
      },
    });
    apiFetch.mockImplementation(async (url: string) =>
      url === "/api/workspace/autopilot/plan" ? planReply("1. Add a prices section") : { ok: true, status: 200, json: async () => ({}) },
    );
    renderPane("run-9");

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    typeAndSend("Add a prices section");
    await screen.findByTestId("plan-review");
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/autopilot/plan", {
      method: "POST",
      body: JSON.stringify({ idea: "Add a prices section", mode: "refine", build_session_id: "run-9" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve & apply" }));
    await waitFor(() => expect(sendRefine).toHaveBeenCalledWith("Add a prices section\n\nApproved plan:\n1. Add a prices section"));
    expect(startBuildSession).not.toHaveBeenCalled();
  });
});
