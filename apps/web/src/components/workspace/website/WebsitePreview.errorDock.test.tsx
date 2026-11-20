// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";
import { setPreviewErrorGate, type PreviewFixOutcome } from "./previewErrorGate";

vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: async () => ({ edits: [] }) }),
}));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ openTab: () => "t" }) }));

const APP_URL = "https://5173-sbx.e2b.app";
const APP_ID = "site:5f0c2a1e-1111-4222-8333-444455556666";
const VITE_ERROR = {
  kind: "compile",
  message: '[plugin:vite:import-analysis] Failed to resolve import "lucide-react" from "src/App.tsx". Does the file exist?',
  stack: "",
  page: "/",
  count: 1,
};
type Msg = { type?: string; enabled?: boolean; tool?: string };

let clock = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
});
afterEach(() => {
  cleanup();
  setPreviewErrorGate(null);
  vi.useRealTimers();
});

function mount(extra: { armEditOnLoad?: boolean } = {}) {
  const props = {
    liveUrl: APP_URL,
    cacheKey: null,
    appId: APP_ID,
    builtApp: true,
    siteApp: true,
    editPlacement: "dock" as const,
    onSendEdits: async () => ({ ok: true as const }),
    editsBusy: false,
  };
  const view = render(<WebsitePreview {...props} armEditOnLoad={extra.armEditOnLoad ?? false} />);
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Msg[] = [];
  const contentWindow = { postMessage: (m: Msg) => posted.push(m) };
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: contentWindow as unknown as Window }));
    });
  const editorReady = () => send({ type: "zavi:editor-ready", protocol: 3 });
  const errors = (list: Array<typeof VITE_ERROR>) => {
    clock += 1000;
    vi.setSystemTime(clock);
    send({ type: "zavi:preview-errors", errors: list.map((e) => ({ ...e, at: clock })) });
  };
  const rerender = (armEditOnLoad: boolean) => view.rerender(<WebsitePreview {...props} armEditOnLoad={armEditOnLoad} />);
  return { posted, send, editorReady, errors, rerender, view };
}

const tools = () => screen.queryByRole("toolbar", { name: "Preview tools" });
const pill = () => screen.queryByRole("toolbar", { name: "Preview errors" });
const modes = (posted: Msg[]) => posted.filter((m) => m.type === "zavi:editor-mode");

describe("the preview dock while the site preview is broken", () => {
  it("with no error the edit tools show and there is no error pill", () => {
    const app = mount();
    app.editorReady();
    expect(tools()).not.toBeNull();
    expect(within(tools()!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(tools()!).getByRole("button", { name: "Edit text" })).toBeTruthy();
    expect(within(tools()!).getByRole("button", { name: "Annotate" })).toBeTruthy();
    expect(pill()).toBeNull();
  });

  it("a Vite error from the frame removes the edit tools and puts the pill in their slot with See log and a working Fix error", async () => {
    const fix = vi.fn(async (_message: string): Promise<PreviewFixOutcome> => ({ ok: true }));
    act(() => setPreviewErrorGate({ active: true, busy: false, failed: false, fix, openBilling: () => {} }));
    const app = mount();
    app.editorReady();
    const slot = tools()!.parentElement!;
    app.errors([VITE_ERROR]);
    expect(tools()).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annotate" })).toBeNull();
    expect(within(pill()!).getByRole("status").textContent).toBe("Something broke in your preview (1)");
    const wrapper = screen.getByTestId("preview-error-pill");
    expect(wrapper.parentElement).toBe(slot);
    expect(wrapper.className).not.toMatch(/\babsolute\b|bottom-full/);
    expect(Array.from(slot.children).filter((c) => c.getAttribute("role") === "toolbar")).toHaveLength(0);
    fireEvent.click(within(pill()!).getByRole("button", { name: "See log" }));
    expect(within(screen.getByRole("dialog", { name: "Preview error log" })).getByText(VITE_ERROR.message)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(pill()!).getByRole("button", { name: "Fix error" }));
    });
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix.mock.calls[0][0]).toContain("lucide-react");
  });

  it("when the frame reports the error is gone the tools come back and the pill goes", () => {
    const app = mount();
    app.editorReady();
    app.errors([VITE_ERROR]);
    expect(tools()).toBeNull();
    expect(pill()).not.toBeNull();
    app.errors([]);
    expect(pill()).toBeNull();
    expect(within(tools()!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(tools()!).getByRole("button", { name: "Annotate" })).toBeTruthy();
  });

  it("dismissing the pill brings the tools back", () => {
    const app = mount();
    app.editorReady();
    app.errors([VITE_ERROR]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss preview errors" }));
    expect(pill()).toBeNull();
    expect(tools()).not.toBeNull();
  });

  it("an active select tool is switched off in the frame when the error arrives and is off when the tools return", () => {
    const app = mount();
    app.editorReady();
    fireEvent.click(within(tools()!).getByRole("button", { name: "Edit" }));
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true });
    expect(screen.getByTestId("edit-frame-ring").className).toContain("opacity-100");
    app.errors([VITE_ERROR]);
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
    expect(screen.getByTestId("edit-frame-ring").className).toContain("opacity-0");
    app.errors([]);
    expect(within(tools()!).getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("false");
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
  });

  it("an active text tool is switched off in the frame when the error arrives", () => {
    const app = mount();
    app.editorReady();
    fireEvent.click(within(tools()!).getByRole("button", { name: "Edit text" }));
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true, tool: "text" });
    app.errors([VITE_ERROR]);
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
    app.errors([]);
    expect(within(tools()!).getByRole("button", { name: "Edit text" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("an active draw tool is closed and its canvas removed when the error arrives", () => {
    const app = mount();
    app.editorReady();
    fireEvent.click(within(tools()!).getByRole("button", { name: "Annotate" }));
    expect(screen.getByTestId("annotation-canvas")).toBeTruthy();
    app.errors([VITE_ERROR]);
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    expect(screen.getByTestId("edit-frame-ring").className).toContain("opacity-0");
    app.errors([]);
    expect(screen.queryByTestId("annotation-canvas")).toBeNull();
    expect(within(tools()!).getByRole("button", { name: "Annotate" })).toBeTruthy();
  });

  it("an edit swap that arms the select tool while the preview is broken does not turn it on", () => {
    const app = mount();
    app.editorReady();
    app.errors([VITE_ERROR]);
    app.rerender(true);
    expect(modes(app.posted).at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
    expect(screen.getByTestId("edit-frame-ring").className).toContain("opacity-0");
    expect(tools()).toBeNull();
  });
});
