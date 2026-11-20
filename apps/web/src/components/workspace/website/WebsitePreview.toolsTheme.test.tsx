// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "theme-tools-key" }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

import { WebsitePreview } from "./WebsitePreview";

const APP_URL = "https://5173-sbx.e2b.app";
let seq = 0;

const THEME = {
  name: "clean",
  colors: { primary: "#2563eb", background: "#ffffff", foreground: "#0f172a", accent: "#dce6fc" },
  fonts: { display: "Plus Jakarta Sans", body: "Inter" },
  radius: "rounded",
};

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

function mount() {
  const appId = `site:5f0c2a1e-1111-4222-8333-${String(++seq).padStart(12, "0")}`;
  apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => ({
    ok: true,
    status: 200,
    json: async () =>
      path.startsWith("/api/website/site-design-edit")
        ? { theme: THEME, fonts: ["Inter", "Plus Jakarta Sans"], radii: ["rounded"], section: null, section_message: null, image_ai: false, image_ai_mask: false }
        : path.startsWith("/api/website/edits?")
          ? { edits: [] }
          : path === "/api/website/edits" && init?.method === "POST"
            ? { edit: { selector: JSON.parse(init.body ?? "{}").selector, id: "edit-1", updated_at: "2026-10-09T00:00:00Z" } }
            : { ok: true },
  }));
  const view = render(
    <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={appId} builtApp siteApp editPlacement="dock" onSendEdits={vi.fn(async () => ({ ok: true as const }))} editsBusy={false} />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Array<{ type?: string; theme?: unknown }> = [];
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (m: { type?: string }) => posted.push(m) } });
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: APP_URL, source: frame.contentWindow as Window }));
    });
  return { frame, send, appId, posted };
}

const themeLoads = () => apiFetch.mock.calls.filter(([p]) => String(p).startsWith("/api/website/site-design-edit"));

describe("the preview tool bar waits for the page", () => {
  it("is not shown while the preview is still loading, and appears once the page has loaded", () => {
    const { frame } = mount();
    expect(screen.queryByRole("toolbar", { name: "Preview tools" })).toBeNull();
    fireEvent.load(frame);
    expect(screen.getByRole("toolbar", { name: "Preview tools" })).toBeTruthy();
  });
});

describe("the Theme panel", () => {
  it("fetches the site's theme as soon as the preview is ready, before Theme is pressed, and opens already filled", async () => {
    const { frame, send } = mount();
    fireEvent.load(frame);
    send({ type: "zavi:editor-ready", protocol: 3 });
    await act(async () => {});
    expect(themeLoads()).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Theme" }));
    const panel = screen.getByRole("dialog", { name: "Site theme" });
    expect(within(panel).queryByText(/Loading the site's look/)).toBeNull();
    expect(within(panel).getByDisplayValue("#2563eb")).toBeTruthy();
    expect(themeLoads()).toHaveLength(1);
  });

  it("does not pop open by itself after a text edit takes over the bar", async () => {
    const { frame, send } = mount();
    fireEvent.load(frame);
    send({ type: "zavi:editor-ready", protocol: 3 });
    await act(async () => {});
    const bar = () => screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Theme" }));
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Edit text" }));
    const activeTextTool = within(bar()).getByRole("button", { name: "Stop editing text" });
    expect(activeTextTool.className).toContain("bg-ink");
    expect(activeTextTool.className).toContain("text-cream");
    expect(activeTextTool.className).not.toContain("bg-[#3d6fe5]");
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    fireEvent.click(within(bar()).getByRole("button", { name: "Stop editing text" }));
    expect(within(bar()).getByRole("button", { name: "Theme" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
  });
});

const drafts = (posted: Array<{ type?: string; theme?: unknown }>) => posted.filter((m) => m.type === "zavi:editor-theme-draft");

async function readyBar() {
  const app = mount();
  fireEvent.load(app.frame);
  app.send({ type: "zavi:editor-ready", protocol: 5 });
  await act(async () => {});
  return app;
}

describe("the Theme panel previews live and closes cleanly", () => {
  it("restyles the page while the colour is dragged, before Apply, through the frame's own origin", async () => {
    const app = await readyBar();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Theme" }));
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(drafts(app.posted)).toEqual([{ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#ff0000" } } }]);
    expect(apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "POST")).toEqual([]);
  });

  it("a click outside the panel closes it and puts the page back on the saved theme; a click inside does not", async () => {
    const app = await readyBar();
    const bar = () => screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Body font" }));
    fireEvent.click(screen.getByRole("option", { name: "Plus Jakarta Sans" }));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    fireEvent.mouseDown(screen.getByLabelText("Body font"));
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
    expect(within(bar()).getByRole("button", { name: "Theme" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking into the preview page closes the panel and discards the draft", async () => {
    const app = await readyBar();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Theme" }));
    fireEvent.change(screen.getByLabelText("Page colour"), { target: { value: "#101010" } });
    app.frame.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("Apply removes the temporary override, closes the panel and reloads the committed page", async () => {
    const app = await readyBar();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Theme" }));
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull());
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
    expect(document.querySelector("iframe")).not.toBe(app.frame);
  });
});

describe("the pill in text mode", () => {
  it("keeps Theme and Annotate while there is no text change, and opening Theme leaves text mode", async () => {
    const app = await readyBar();
    const bar = () => screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Edit text" }));
    expect(within(bar()).getByRole("button", { name: "Stop editing text" })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Theme" })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Annotate" })).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Theme" }));
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Edit text" }).getAttribute("aria-pressed")).toBe("false");
    expect(app.posted.filter((m) => m.type === "zavi:editor-mode").at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
  });

  it("Annotate from text mode leaves text mode", async () => {
    await readyBar();
    const bar = () => screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Edit text" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Annotate" }));
    expect(screen.queryByRole("button", { name: "Stop editing text" })).toBeNull();
  });

  it("hides Theme and Annotate once a text change shows Send and Clear", async () => {
    const app = await readyBar();
    const bar = () => screen.getByRole("toolbar", { name: "Preview tools" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Edit text" }));
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "Spring", before: "Winter", protocol: 5 });
    await within(bar()).findByRole("button", { name: "Send" });
    expect(within(bar()).getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(within(bar()).queryByRole("button", { name: "Theme" })).toBeNull();
    expect(within(bar()).queryByRole("button", { name: "Annotate" })).toBeNull();
  });
});

describe("an outside click peels the Theme panel one layer at a time", () => {
  async function openTheme() {
    const app = await readyBar();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Preview tools" })).getByRole("button", { name: "Theme" }));
    fireEvent.change(screen.getByLabelText("Page colour"), { target: { value: "#101010" } });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: { colors: { background: "#101010" } } });
    return app;
  }

  it("with the colour picker open, the first click closes only the picker and keeps the draft; the second closes the panel and discards", async () => {
    const app = await openTheme();
    fireEvent.click(screen.getByRole("button", { name: "Pick brand colour" }));
    expect(screen.getByRole("dialog", { name: "Brand colour picker" })).toBeTruthy();
    const sent = app.posted.length;
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Brand colour picker" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(app.posted.slice(sent)).toEqual([]);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("with a font list open, the first click closes only the list; the second closes the panel and discards", async () => {
    const app = await openTheme();
    fireEvent.click(screen.getByRole("button", { name: "Body font" }));
    expect(screen.getByRole("listbox", { name: "Body font options" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: { colors: { background: "#101010" } } });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("a click into the preview page with the picker open closes only the picker, and the next click into the page closes the panel", async () => {
    const app = await openTheme();
    fireEvent.click(screen.getByRole("button", { name: "Pick accent colour" }));
    app.frame.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("dialog", { name: "Accent colour picker" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    expect(document.activeElement).not.toBe(app.frame);
    app.frame.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("dialog", { name: "Site theme" })).toBeNull();
    expect(drafts(app.posted).at(-1)).toEqual({ type: "zavi:editor-theme-draft", theme: null });
  });
});
