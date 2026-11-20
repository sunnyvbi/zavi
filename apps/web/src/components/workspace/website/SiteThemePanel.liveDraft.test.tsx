// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
  posts: [] as unknown[],
  applyGate: null as null | Promise<void>,
  getGate: null as null | Promise<void>,
  getTheme: null as null | {
    name: string;
    colors: { primary: string; background: string; foreground: string; accent: string };
    fonts: { display: string; body: string };
    radius: string;
  },
}));

vi.mock("@/lib/api", () => ({
  IDEMPOTENCY_HEADER: "Idempotency-Key",
  newIdempotencyKey: () => "site-theme-panel-key",
  apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith("/api/website/site-design-edit?")) {
      if (api.getGate) await api.getGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ theme: api.getTheme ?? THEME, fonts: ["Inter", "Lato", "Fraunces"], radii: ["0", "0.5rem", "1rem"], section: null, section_message: null, image_ai: false }),
      } as Response;
    }
    const body = init?.body ? JSON.parse(init.body) : null;
    api.posts.push(body);
    if (api.applyGate) await api.applyGate;
    const op = body.op;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, theme: { ...THEME, colors: { ...THEME.colors, ...(op.colors ?? {}) }, fonts: { ...THEME.fonts, ...(op.fonts ?? {}) }, radius: op.radius ?? THEME.radius } }),
    } as Response;
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));

import { preloadSiteTheme, SiteThemePanel } from "./SiteThemePanel";

const THEME = { name: "clean", colors: { primary: "#2563eb", background: "#ffffff", foreground: "#0f172a", accent: "#dbeafe" }, fonts: { display: "Inter", body: "Inter" }, radius: "0.5rem" };
let seq = 0;
let frames: Array<FrameRequestCallback> = [];

beforeEach(() => {
  api.posts = [];
  api.applyGate = null;
  api.getGate = null;
  api.getTheme = null;
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames[id - 1] = () => {};
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pick(control: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: control }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function flushFrame() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((cb) => cb(0)));
}

async function open(onApplied?: (change: unknown) => void) {
  const onDraft = vi.fn();
  const onClose = vi.fn();
  const appId = `site:aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const view = render(<SiteThemePanel appId={appId} onClose={onClose} onDraft={onDraft} onApplied={onApplied} />);
  await screen.findByRole("button", { name: "Apply" });
  return { onDraft, onClose, view };
}

describe("SiteThemePanel live preview", () => {
  it("joins an eager refresh instead of showing stale cached theme values", async () => {
    const appId = `site:aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    await preloadSiteTheme(appId);
    let release: () => void = () => {};
    api.getTheme = { ...THEME, colors: { ...THEME.colors, primary: "#dc2626" } };
    api.getGate = new Promise<void>((resolve) => (release = resolve));
    const refresh = preloadSiteTheme(appId);
    render(<SiteThemePanel appId={appId} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading the site's look");
    await act(async () => release());
    await refresh;
    expect(await screen.findByDisplayValue("#dc2626")).toBe(screen.getByLabelText("Brand colour"));
  });

  it("posts nothing until something changes, then one draft per animation frame with the latest drag value only", async () => {
    const { onDraft } = await open();
    flushFrame();
    expect(onDraft).not.toHaveBeenCalled();
    const brand = screen.getByLabelText("Brand colour");
    fireEvent.change(brand, { target: { value: "#ff0000" } });
    fireEvent.change(brand, { target: { value: "#ee1100" } });
    fireEvent.change(brand, { target: { value: "#dd2200" } });
    expect(onDraft).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    flushFrame();
    expect(onDraft.mock.calls).toEqual([[{ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#dd2200" } } }]]);
    pick("Headings font", "Fraunces");
    pick("Body font", "Lato");
    pick("Corners", "Round");
    fireEvent.change(screen.getByLabelText("Page colour"), { target: { value: "#101010" } });
    flushFrame();
    expect(onDraft).toHaveBeenLastCalledWith({
      type: "zavi:editor-theme-draft",
      theme: { colors: { primary: "#dd2200", background: "#101010" }, fonts: { display: "Fraunces", body: "Lato" }, radius: "1rem" },
    });
    expect(onDraft).toHaveBeenCalledTimes(2);
  });

  it("Reset puts the page back on the saved theme", async () => {
    const { onDraft } = await open();
    fireEvent.change(screen.getByLabelText("Text colour"), { target: { value: "#333333" } });
    flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    flushFrame();
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("has no close button, and closing from outside discards the unapplied draft, even one still waiting for its frame", async () => {
    const { onDraft, onClose, view } = await open();
    expect(screen.queryByRole("button", { name: "Close theme" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "#00ff00" } });
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
    flushFrame();
    expect(onDraft.mock.calls).toEqual([[{ type: "zavi:editor-theme-draft", theme: null }]]);
  });

  it("an unmount with no change posts nothing, so the page is not touched", async () => {
    const { onDraft, view } = await open();
    view.unmount();
    flushFrame();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("Apply clears the temporary draft and closes the panel only after saving", async () => {
    let release: () => void = () => {};
    api.applyGate = new Promise<void>((resolve) => (release = resolve));
    const { onDraft, onClose, view } = await open();
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
    flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release());
    await screen.findByText(/goes live when you publish/);
    expect(onClose).toHaveBeenCalledTimes(1);
    flushFrame();
    view.unmount();
    flushFrame();
    expect(api.posts).toHaveLength(1);
    expect(onDraft.mock.calls).toEqual([
      [{ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#ff0000" } } }],
      [{ type: "zavi:editor-theme-draft", theme: null }],
    ]);
  });

  it("disables theme controls while Apply is saving", async () => {
    let release: () => void = () => {};
    api.applyGate = new Promise<void>((resolve) => (release = resolve));
    const onApplied = vi.fn();
    const { onDraft, onClose } = await open(onApplied);
    const brand = screen.getByLabelText("Brand colour");
    fireEvent.change(brand, { target: { value: "#ff0000" } });
    flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(brand.matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Corners" }).matches(":disabled")).toBe(true);
    await act(async () => release());
    await screen.findByText(/goes live when you publish/);
    expect(api.posts).toEqual([{ app_id: expect.any(String), op: { kind: "theme", colors: { primary: "#ff0000" } } }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("closing while Apply is still in flight discards, since nothing was saved yet", async () => {
    let release: () => void = () => {};
    api.applyGate = new Promise<void>((r) => (release = r));
    const { onDraft, view } = await open();
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
    flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    view.unmount();
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: null });
    await act(async () => release());
  });

  it("an Apply from a closed panel cannot close a newly opened panel when its save finishes", async () => {
    let release: () => void = () => {};
    api.applyGate = new Promise<void>((resolve) => (release = resolve));
    const onClose = vi.fn();
    const firstAppId = `site:aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    const first = render(<SiteThemePanel appId={firstAppId} onClose={onClose} />);
    await screen.findByRole("button", { name: "Apply" });
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    first.unmount();

    api.applyGate = null;
    const secondAppId = `site:aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    render(<SiteThemePanel appId={secondAppId} onClose={onClose} />);
    await screen.findByRole("button", { name: "Apply" });
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#00aa00" } });

    await act(async () => release());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("#00aa00")).toBe(screen.getByLabelText("Brand colour"));
  });

  it("never posts a value outside the panel's own options", async () => {
    const { onDraft } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Corners" }));
    const corners = screen.getByRole("listbox", { name: "Corners options" });
    const bad = document.createElement("li");
    bad.setAttribute("role", "option");
    bad.textContent = "1rem; } body { display: none";
    corners.appendChild(bad);
    fireEvent.click(bad);
    fireEvent.keyDown(corners, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Headings font" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Inter", "Lato", "Fraunces"]);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Headings font options" }), { key: "Escape" });
    fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#00aa00" } });
    fireEvent.change(screen.getByLabelText("Text colour"), { target: { value: "#12345" } });
    flushFrame();
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#00aa00" } } });
  });
});

describe("SiteThemePanel themed controls", () => {
  it("drives a font list from the keyboard: arrows move, Home/End jump, Enter picks and posts a draft, Escape closes without one", async () => {
    const { onDraft } = await open();
    const button = screen.getByRole("button", { name: "Headings font" });
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "Headings font options" });
    expect(document.activeElement).toBe(list);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const active = () => document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent;
    expect(active()).toBe("Inter");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe("Fraunces");
    fireEvent.keyDown(list, { key: "Home" });
    expect(active()).toBe("Inter");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(active()).toBe("Lato");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Lato");
    flushFrame();
    expect(onDraft.mock.calls).toEqual([[{ type: "zavi:editor-theme-draft", theme: { fonts: { display: "Lato" } } }]]);

    fireEvent.keyDown(button, { key: "Enter" });
    const again = screen.getByRole("listbox", { name: "Headings font options" });
    expect(screen.getByRole("option", { name: "Lato" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(again, { key: "ArrowDown" });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Lato");
    flushFrame();
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it("clicking an option posts a draft with that value, and re-picking the saved value takes it back", async () => {
    const { onDraft } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Corners" }));
    fireEvent.click(screen.getByRole("option", { name: "Square" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    flushFrame();
    expect(onDraft.mock.calls).toEqual([[{ type: "zavi:editor-theme-draft", theme: { radius: "0" } }]]);
    fireEvent.click(screen.getByRole("button", { name: "Corners" }));
    fireEvent.click(screen.getByRole("option", { name: "Soft" }));
    flushFrame();
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: null });
  });

  it("the colour picker moves the colour from the keyboard, live, and the hex field follows", async () => {
    const { onDraft } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Pick brand colour" }));
    const area = screen.getByRole("slider", { name: "Brand saturation and brightness" });
    expect(document.activeElement).toBe(area);
    fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
    flushFrame();
    const hex = (screen.getByLabelText("Brand colour") as HTMLInputElement).value;
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex).not.toBe("#2563eb");
    expect(onDraft.mock.calls).toEqual([[{ type: "zavi:editor-theme-draft", theme: { colors: { primary: hex } } }]]);
    fireEvent.change(screen.getByLabelText("Brand hue"), { target: { value: "0" } });
    flushFrame();
    const red = (screen.getByLabelText("Brand colour") as HTMLInputElement).value;
    expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(parseInt(red.slice(5, 7), 16));
    expect(onDraft).toHaveBeenLastCalledWith({ type: "zavi:editor-theme-draft", theme: { colors: { primary: red } } });
  });

  it("inside the panel, a click off the open layer closes only that layer, and Escape closes the picker back to its swatch", async () => {
    const { onClose } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Body font" }));
    expect(screen.getByRole("listbox", { name: "Body font options" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("Theme"));
    expect(screen.queryByRole("listbox")).toBeNull();
    const swatch = screen.getByRole("button", { name: "Pick page colour" });
    fireEvent.click(swatch);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Page saturation and brightness" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Page colour picker" })).toBeNull();
    expect(document.activeElement).toBe(swatch);
    expect(screen.getByRole("dialog", { name: "Site theme" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands the applied change to onApplied once the save succeeds", async () => {
    const onApplied = vi.fn();
    const appId = `site:aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    render(<SiteThemePanel appId={appId} onClose={() => {}} onApplied={onApplied} />);
    await screen.findByRole("button", { name: "Apply" });
    fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/goes live when you publish/);
    expect(onApplied.mock.calls).toEqual([[{ kind: "theme", colors: { accent: "#00ff00" } }]]);
  });
});
