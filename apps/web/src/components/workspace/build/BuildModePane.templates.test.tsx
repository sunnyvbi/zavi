// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const startBuildSession = vi.fn();
let sessionState: Record<string, unknown> = {};

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
vi.mock("@/components/voice/MicButton", () => ({
  MicButton: () => null,
}));

vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => false,
  isBuilderClarifyDynamicEnabled: () => false,
}));

import { BuildModePane } from "./BuildModePane";
import { resetSiteTemplatesCache } from "@/lib/workspace/siteTemplates";
import { TEMPLATES_USE } from "./TemplateGallery";

const THEME = ":root { --background: 255 255 255; }";
const CATALOG = {
  version: 1,
  templates: [
    {
      id: "book-a-service",
      label: "Book a service",
      blurb: "Show what you offer and let people book a time.",
      good_for: "Salons, trades, clinics",
      idea: "A website for my [type of business] in [town]. We offer [services and their prices]. People in [town] book a time online.",
      layout: "split",
      fonts: { display: "DM Sans", body: "Inter" },
      theme_css: THEME,
      preview: { name: "Your business", headline: "Book your next visit", hero_variant: "split", sections: [{ title: "Services", body: "What we offer", kind: "Features", variant: "cards" }] },
    },
    { id: "BAD ID", label: "x", idea: "y", theme_css: THEME, preview: null },
  ],
};

const IDEA = "A landing page for my bakery";

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
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(
  sessionId: string | null,
  onOpenSession = vi.fn(),
  onPreviewProgress = vi.fn(),
  active = true,
) {
  const pane = (isActive: boolean) => (
    <BuildModePane
      sessionId={sessionId}
      active={isActive}
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={onPreviewProgress}
      onOpenSession={onOpenSession}
      onNewBuild={vi.fn()}
    />
  );
  const view = render(pane(active));
  return {
    onOpenSession,
    onPreviewProgress,
    rerenderActive: (isActive: boolean) => view.rerender(pane(isActive)),
  };
}

function typeAndSend(text: string) {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  return box;
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  startBuildSession.mockReset();
  sessionState = baseSession();
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

function dialog() {
  return screen.getByRole("dialog");
}
function answer(text: string, how: "enter" | "next") {
  const input = within(dialog()).getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  if (how === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
}
function composer() {
  return screen.getAllByRole("textbox").find((el) => !el.closest("dialog")) as HTMLTextAreaElement;
}

describe("BuildModePane template dialog", () => {
  it("opens a dialog, asks each blank once, and Use puts the filled idea in the composer and starts the build from the template", async () => {
    resetSiteTemplatesCache();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    startBuildSession.mockResolvedValue({ id: "run-1" });
    renderPane(null);
    fireEvent.change(composer(), { target: { value: IDEA } });
    fireEvent.click(screen.getByTestId("templates-open"));
    expect(screen.getByRole("dialog", { name: "Start from a template" })).toBeTruthy();
    const card = await screen.findByTestId("template-book-a-service");
    expect(screen.queryByTestId("template-BAD ID")).toBeNull();
    fireEvent.click(card);
    expect(composer().value).toBe(IDEA);
    expect(screen.queryByTestId("template-chip")).toBeNull();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(within(dialog()).getByRole("textbox"), { key: "Enter" });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    answer("bike repair shop", "enter");
    answer("Leeds", "next");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Back" }));
    expect((within(dialog()).getByRole("textbox") as HTMLInputElement).value).toBe("Leeds");
    fireEvent.keyDown(within(dialog()).getByRole("textbox"), { key: "Enter" });
    answer("Tune-ups from £30", "enter");
    expect(composer().value).toBe(IDEA);
    fireEvent.click(within(dialog()).getByRole("button", { name: TEMPLATES_USE }));
    const filled = "A website for my bike repair shop in Leeds. We offer Tune-ups from £30. People in Leeds book a time online.";
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe(filled);
    expect(composer().value).not.toMatch(/[[\]]/);
    expect(within(screen.getByTestId("template-chip")).getByText("Template: Book a service")).toBeTruthy();
    expect(screen.queryByText(/Fill in the parts in brackets first/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledWith({ idea: filled, companyName: "Acme", template: "book-a-service" }));
  });

  it("cancelling at any step (Escape, the close button, a scrim click) leaves the draft and the template untouched", async () => {
    resetSiteTemplatesCache();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    startBuildSession.mockResolvedValue({ id: "run-3" });
    renderPane(null);
    fireEvent.change(composer(), { target: { value: IDEA } });
    const trigger = screen.getByTestId("templates-open");

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("template-book-a-service"));
    answer("bike repair shop", "enter");
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(composer().value).toBe(IDEA);
    expect(screen.queryByTestId("template-chip")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("template-book-a-service"));
    answer("bike repair shop", "enter");
    answer("Leeds", "enter");
    answer("Tune-ups", "enter");
    expect(within(dialog()).getByRole("button", { name: TEMPLATES_USE })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close templates" }));
    expect(composer().value).toBe(IDEA);
    expect(screen.queryByTestId("template-chip")).toBeNull();

    fireEvent.click(trigger);
    await screen.findByTestId("template-book-a-service");
    const box = dialog();
    box.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(box, { clientX: 5, clientY: 5 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe(IDEA);
    expect(screen.queryByTestId("template-chip")).toBeNull();

    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledWith({ idea: IDEA, companyName: "Acme" }));
  });

  it("brackets typed back into a template idea still hold Send; removing the chip builds without a template; a failed catalog read can retry", async () => {
    resetSiteTemplatesCache();
    let ok = false;
    vi.stubGlobal("fetch", vi.fn(async () => (ok ? { ok: true, json: async () => CATALOG } : { ok: false, json: async () => ({}) })));
    startBuildSession.mockResolvedValue({ id: "run-2" });
    renderPane(null);
    fireEvent.click(screen.getByTestId("templates-open"));
    expect(await screen.findByText(/Templates could not load/)).toBeTruthy();
    ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByTestId("template-book-a-service"));
    answer("bakery", "enter");
    answer("York", "enter");
    answer("bread", "enter");
    fireEvent.click(within(dialog()).getByRole("button", { name: TEMPLATES_USE }));
    fireEvent.change(composer(), { target: { value: "A website for my [type of business] in York." } });
    expect(screen.getByText(/Fill in the part in brackets first: \[type of business\]/)).toBeTruthy();
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(startBuildSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the Book a service template" }));
    expect(screen.queryByTestId("template-chip")).toBeNull();
    typeAndSend(IDEA);
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledWith({ idea: IDEA, companyName: "Acme" }));
  });
});
