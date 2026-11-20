// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";
import { setPreviewErrorGate, usePreviewErrorFix, usePreviewErrorGate, type PreviewErrorGate, type PreviewFixOutcome } from "./previewErrorGate";
import { FIX_BUILD_FAILED, FIX_NO_BUILD, PreviewErrorPill } from "./PreviewErrorPill";
import { FIX_MESSAGE_MAX, buildFixMessage, type PreviewError } from "./previewErrors";

const shell = vi.hoisted(() => ({ opened: [] as unknown[] }));
vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: async () => ({ edits: [] }) }),
}));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    openTab: (tab: unknown) => {
      shell.opened.push(tab);
      return "t";
    },
  }),
}));

const APP_URL = "https://5173-sbx.e2b.app";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
let clock = 1_800_000_000_000;
const tick = (ms = 1000) => {
  clock += ms;
  vi.setSystemTime(clock);
};

type Entry = { kind: string; message: string; stack?: string; page?: string; count?: number; at?: number };

function gate(over: Partial<PreviewErrorGate> = {}): PreviewErrorGate {
  return {
    active: true,
    busy: false,
    failed: false,
    fix: vi.fn(async (): Promise<PreviewFixOutcome> => ({ ok: true })),
    openBilling: vi.fn(),
    ...over,
  };
}

function mount() {
  const view = render(
    <WebsitePreview liveUrl={APP_URL} cacheKey={null} appId="site:1" builtApp siteApp editPlacement="dock" />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Array<{ data: unknown; target: string }> = [];
  const contentWindow = { postMessage: (data: unknown, target: string) => posted.push({ data, target }) };
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: contentWindow });
  const send = (data: unknown, origin = APP_URL, source: unknown = contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
    });
  const ready = () => send({ type: "zavi:preview-errors-ready" });
  const errors = (list: Entry[]) => {
    tick();
    send({
      type: "zavi:preview-errors",
      errors: list.map((e) => ({ stack: "", page: "/", count: 1, at: clock, ...e })),
    });
  };
  return { posted, send, ready, errors, frame };
}

const pill = () => screen.queryByRole("toolbar", { name: "Preview errors" });
const label = () => within(pill()!).getByRole("status").textContent;
const setGate = (g: PreviewErrorGate | null) => act(() => setPreviewErrorGate(g));

const CRASH: Entry = {
  kind: "error",
  message: "TypeError: Cannot read properties of undefined (reading 'map')",
  stack: "TypeError: Cannot read properties of undefined (reading 'map')\n    at Classes (https://5173-sbx.e2b.app/src/pages/Classes.tsx:12:5)\n    at renderWithHooks (https://5173-sbx.e2b.app/node_modules/.vite/deps/react-dom.js:1:1)",
  page: "/classes",
};
const REJECTION: Entry = { kind: "rejection", message: "Error: Failed to fetch dynamically imported module", page: "/" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  tick();
  shell.opened.length = 0;
  setPreviewErrorGate(gate());
});
afterEach(() => {
  cleanup();
  setPreviewErrorGate(null);
  vi.useRealTimers();
});

describe("the preview error pill", () => {
  it("asks the framed app for its errors and shows a pill with the count", () => {
    const app = mount();
    app.posted.length = 0;
    app.ready();
    expect(app.posted).toEqual([{ data: { type: "zavi:preview-errors-hello" }, target: APP_URL }]);
    expect(pill()).toBeNull();
    app.errors([CRASH, REJECTION]);
    expect(label()).toBe("Something broke in your preview (2)");
    expect(screen.queryByRole("toolbar", { name: "Preview tools" })).toBeNull();
  });

  it("ignores error reports from another origin or another window", () => {
    const app = mount();
    app.send({ type: "zavi:preview-errors", errors: [{ kind: "error", message: "Error: forged", page: "/", count: 1 }] }, "https://evil.example");
    app.send({ type: "zavi:preview-errors", errors: [{ kind: "error", message: "Error: forged", page: "/", count: 1 }] }, APP_URL, window);
    expect(pill()).toBeNull();
  });

  it("stays hidden while a build runs, then shows only errors that are still happening once it is quiet", () => {
    setPreviewErrorGate(gate({ busy: true }));
    const app = mount();
    app.errors([CRASH]);
    expect(pill()).toBeNull();
    tick();
    setGate(gate({ busy: false }));
    expect(pill()).toBeNull();
    app.errors([CRASH, REJECTION]);
    expect(label()).toBe("Something broke in your preview (1)");
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    const log = screen.getByRole("dialog", { name: "Preview error log" });
    expect(within(log).getByText(REJECTION.message)).toBeTruthy();
    expect(within(log).queryByText(CRASH.message)).toBeNull();
  });

  it("clears the errors when a new build starts", () => {
    const app = mount();
    app.errors([CRASH]);
    expect(pill()).not.toBeNull();
    tick();
    setGate(gate({ busy: true }));
    expect(pill()).toBeNull();
    tick();
    setGate(gate({ busy: false }));
    expect(pill()).toBeNull();
  });

  it("clears the errors when the preview loads a fresh page", () => {
    const app = mount();
    app.errors([CRASH]);
    expect(pill()).not.toBeNull();
    app.ready();
    expect(pill()).toBeNull();
  });

  it("ignores React dev warnings and detail-less script errors", () => {
    const app = mount();
    app.errors([
      { kind: "console", message: "Warning: Each child in a list should have a unique \"key\" prop." },
      { kind: "console", message: "Error: Each child in a list should have a unique \"key\" prop." },
      { kind: "error", message: "Script error." },
    ]);
    expect(pill()).toBeNull();
    app.errors([{ kind: "console", message: "Warning: validateDOMNesting(...): <div> cannot appear" }, CRASH]);
    expect(label()).toBe("Something broke in your preview (1)");
  });

  it("collapses the same error into one entry", () => {
    const app = mount();
    app.errors([{ ...CRASH, count: 3 }, { ...CRASH, page: "/other" }]);
    expect(label()).toBe("Something broke in your preview (1)");
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    expect(screen.getByText(/3 times/)).toBeTruthy();
  });

  it("Fix error sends one change request naming the error and the page, with no tokens in it", async () => {
    let resolve: (v: PreviewFixOutcome) => void = () => {};
    const fix = vi.fn((_message: string) => new Promise<PreviewFixOutcome>((r) => (resolve = r)));
    setPreviewErrorGate(gate({ fix }));
    const app = mount();
    app.errors([
      {
        ...CRASH,
        message: `TypeError: Cannot read properties of undefined (reading 'map') loading https://abc.supabase.co/storage/v1/object/sign/a.png?token=${JWT}`,
        stack: `TypeError: boom\n    at Classes (https://5173-sbx.e2b.app/src/pages/Classes.tsx:12:5)\n    at fetchKey (apiKey=sk_live_abcdef1234567890 Bearer ${JWT})`,
      },
    ]);
    const button = screen.getByRole("button", { name: "Fix error" });
    act(() => {
      button.click();
      button.click();
    });
    fireEvent.click(screen.getByRole("button", { name: "Sending..." }));
    expect(fix).toHaveBeenCalledTimes(1);
    const text = fix.mock.calls[0]![0];
    expect(text).toContain("Fix this error in the preview:");
    expect(text).toContain("On /classes: TypeError: Cannot read properties of undefined (reading 'map')");
    expect(text).toContain("Classes.tsx:12:5");
    expect(text).not.toMatch(/eyJ|sk_live|token=/);
    expect(text.length).toBeLessThanOrEqual(FIX_MESSAGE_MAX);
    expect((screen.getByRole("button", { name: "Sending..." }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ ok: true }));
    expect(pill()).toBeNull();
  });

  it("says why Fix can't run instead of doing nothing, and opens billing when out of credits", async () => {
    setPreviewErrorGate(null);
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    expect(screen.getByText(FIX_NO_BUILD)).toBeTruthy();

    const failedFix = vi.fn();
    setGate(gate({ failed: true, fix: failedFix }));
    fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    expect(screen.getByText(FIX_BUILD_FAILED)).toBeTruthy();
    expect(failedFix).not.toHaveBeenCalled();

    const openBilling = vi.fn();
    setGate(gate({ openBilling, fix: async () => ({ ok: false, message: "You're out of credits.", credit: true }) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    });
    expect(screen.getByText("You're out of credits.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy credits" }));
    expect(openBilling).toHaveBeenCalledTimes(1);
    expect(pill()).not.toBeNull();
  });

  it("tells its host when the error log opens and closes, so the preview never reloads under it", async () => {
    setGate(gate({ busy: false }));
    const onLogOpenChange = vi.fn();
    const frameRef = { current: document.createElement("iframe") };
    document.body.appendChild(frameRef.current);
    const contentWindow = { postMessage: () => {} };
    Object.defineProperty(frameRef.current, "contentWindow", { configurable: true, value: contentWindow });
    render(<PreviewErrorPill frameRef={frameRef} src={APP_URL} onLogOpenChange={onLogOpenChange} />);
    tick();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "zavi:preview-errors", errors: [{ stack: "", page: "/", count: 1, at: Date.now(), ...CRASH }] },
          origin: APP_URL,
          source: contentWindow as unknown as Window,
        }),
      );
    });
    expect(onLogOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    expect(onLogOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLogOpenChange).toHaveBeenLastCalledWith(false);
    frameRef.current.remove();
  });

  it("See log lists each error and Copy copies its page and trace", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    const log = screen.getByRole("dialog", { name: "Preview error log" });
    expect(within(log).getByText(/\/classes/)).toBeTruthy();
    expect(within(log).queryByText(/renderWithHooks/)).toBeNull();
    fireEvent.click(within(log).getByRole("button", { name: "Show details" }));
    expect(within(log).getByText(/renderWithHooks/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(log).getByRole("button", { name: "Copy error" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("On /classes: TypeError: Cannot read properties of undefined (reading 'map')");
    expect(copied).toContain("at Classes (https://5173-sbx.e2b.app/src/pages/Classes.tsx:12:5)");
  });

  it("one click that the page reports twice in the same burst counts once, and each later click adds one", () => {
    const app = mount();
    app.ready();
    app.errors([]);
    app.errors([{ ...CRASH, count: 2 }]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    const log = screen.getByRole("dialog", { name: "Preview error log" });
    expect(within(log).getByText(CRASH.message)).toBeTruthy();
    expect(log.textContent).not.toMatch(/times/);
    app.errors([{ ...CRASH, count: 4 }]);
    expect(log.textContent).toContain("2 times");
    app.errors([{ ...CRASH, count: 6 }]);
    expect(log.textContent).toContain("3 times");
    app.errors([{ ...CRASH, count: 6 }]);
    expect(log.textContent).toContain("3 times");
  });

  it("a fresh page that reloads starts the count again from its own report", () => {
    const app = mount();
    app.ready();
    app.errors([]);
    app.errors([{ ...CRASH, count: 2 }]);
    app.errors([{ ...CRASH, count: 4 }]);
    app.ready();
    app.errors([{ ...CRASH, count: 5 }]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    expect(screen.getByRole("dialog", { name: "Preview error log" }).textContent).toContain("5 times");
  });

  it("Escape closes the See log popover and leaves the pill", () => {
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    expect(screen.getByRole("dialog", { name: "Preview error log" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Preview error log" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Preview error log" })).toBeNull();
    expect(pill()).not.toBeNull();
    expect(screen.getByRole("button", { name: "See log" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("Copy says Copied even where the clipboard API is refused, by falling back to a selection copy", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let copiedText = "";
    const execCommand = vi.fn((command: string) => {
      const area = document.querySelector<HTMLTextAreaElement>("textarea[readonly]");
      copiedText = area?.value ?? "";
      return command === "copy";
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    const log = screen.getByRole("dialog", { name: "Preview error log" });
    await act(async () => {
      fireEvent.click(within(log).getByRole("button", { name: "Copy error" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copiedText).toContain("On /classes: TypeError");
    expect(within(log).getByRole("button", { name: "Copied" }).textContent).toContain("Copied");
    expect(document.querySelector("textarea[readonly]")).toBeNull();
  });

  it("Copy says it couldn't copy when no way to copy works", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "See log" }));
    const log = screen.getByRole("dialog", { name: "Preview error log" });
    await act(async () => {
      fireEvent.click(within(log).getByRole("button", { name: "Copy error" }));
    });
    expect(within(log).getByRole("button", { name: "Couldn't copy" })).toBeTruthy();
  });

  it("the dismiss button hides it until a new error happens", () => {
    const app = mount();
    app.errors([CRASH]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss preview errors" }));
    expect(pill()).toBeNull();
    app.errors([CRASH]);
    expect(pill()).toBeNull();
    app.errors([CRASH, REJECTION]);
    expect(label()).toBe("Something broke in your preview (1)");
  });
});

describe("the Build tab's fix gate", () => {
  it("publishes the build state, forwards Fix to the latest refine and clears on unmount", async () => {
    setPreviewErrorGate(null);
    const first = vi.fn(async (): Promise<PreviewFixOutcome> => ({ ok: true }));
    const second = vi.fn(async (): Promise<PreviewFixOutcome> => ({ ok: false, message: "out", credit: true }));
    const view = renderHook(
      (props: { busy: boolean; refine: typeof first }) => {
        usePreviewErrorFix({ active: true, busy: props.busy, failed: false, refine: props.refine });
        return usePreviewErrorGate();
      },
      { initialProps: { busy: true, refine: first } },
    );
    expect(view.result.current).toMatchObject({ active: true, busy: true, failed: false });
    view.rerender({ busy: false, refine: first });
    expect(view.result.current?.busy).toBe(false);
    view.rerender({ busy: false, refine: second });
    await expect(view.result.current!.fix("Fix this error")).resolves.toEqual({ ok: false, message: "out", credit: true });
    expect(second).toHaveBeenCalledWith("Fix this error");
    expect(first).not.toHaveBeenCalled();
    act(() => view.result.current!.openBilling());
    expect(shell.opened).toHaveLength(1);
    view.unmount();
    const after = renderHook(() => usePreviewErrorGate());
    expect(after.result.current).toBeNull();
  });
});

describe("two workspaces mounted at once", () => {
  function Registrar(props: { active: boolean; busy: boolean; refine: (message: string) => Promise<PreviewFixOutcome> }) {
    usePreviewErrorFix({ active: props.active, busy: props.busy, failed: false, refine: props.refine });
    return null;
  }

  it("the hidden Website workspace updating and unmounting never takes Fix error away from the Build preview", async () => {
    setPreviewErrorGate(null);
    const websiteRefine = vi.fn(async (_message: string): Promise<PreviewFixOutcome> => ({ ok: true }));
    const buildRefine = vi.fn(async (_message: string): Promise<PreviewFixOutcome> => ({ ok: true }));
    const website = render(<Registrar active={false} busy={false} refine={websiteRefine} />);
    const build = render(<Registrar active busy={false} refine={buildRefine} />);
    const app = mount();
    app.errors([CRASH]);

    website.rerender(<Registrar active={false} busy refine={websiteRefine} />);
    website.rerender(<Registrar active={false} busy={false} refine={websiteRefine} />);
    expect(pill()).not.toBeNull();
    website.unmount();
    expect(pill()).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    });
    expect(screen.queryByText(FIX_NO_BUILD)).toBeNull();
    expect(buildRefine).toHaveBeenCalledTimes(1);
    expect(buildRefine.mock.calls[0]![0]).toContain("Cannot read properties of undefined");
    expect(websiteRefine).not.toHaveBeenCalled();
    build.unmount();
  });

  it("a Website workspace mounted after the Build preview still yields to the active Build gate, and only its own unmount clears it", async () => {
    setPreviewErrorGate(null);
    const buildRefine = vi.fn(async (): Promise<PreviewFixOutcome> => ({ ok: true }));
    const websiteRefine = vi.fn(async (): Promise<PreviewFixOutcome> => ({ ok: true }));
    const build = render(<Registrar active busy={false} refine={buildRefine} />);
    const website = render(<Registrar active={false} busy refine={websiteRefine} />);
    const seen = renderHook(() => usePreviewErrorGate());
    expect(seen.result.current).toMatchObject({ active: true, busy: false });
    website.rerender(<Registrar active={false} busy={false} refine={websiteRefine} />);
    expect(seen.result.current).toMatchObject({ active: true, busy: false });
    await seen.result.current!.fix("Fix this");
    expect(buildRefine).toHaveBeenCalledWith("Fix this");
    expect(websiteRefine).not.toHaveBeenCalled();
    build.unmount();
    expect(seen.result.current).toMatchObject({ active: false, busy: false });
    website.unmount();
    expect(seen.result.current).toBeNull();
  });
});

describe("the fix message", () => {
  it("stays under the chat limit with many long errors and always keeps the first one", () => {
    const many: PreviewError[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "error",
      message: `Error: failure ${i} ${"y".repeat(450)}`,
      stack: Array.from({ length: 10 }, (_, j) => `at f${j} (https://x.e2b.app/src/a${i}.tsx:${j}:1)`).join("\n"),
      page: `/p${i}`,
      count: 1,
    }));
    const text = buildFixMessage(many);
    expect(text.length).toBeLessThanOrEqual(FIX_MESSAGE_MAX);
    expect(text.length).toBeGreaterThanOrEqual(8);
    expect(text).toContain("Fix these 20 errors in the preview:");
    expect(text).toContain("1. On /p0: Error: failure 0");
  });
});
