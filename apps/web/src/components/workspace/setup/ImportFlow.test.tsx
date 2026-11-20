// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ImportReads } from "./importReads";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  lists: [] as unknown[][],
  imports: null as null | { files: unknown; refresh: () => Promise<void> },
  failImports: 0,
  afterRead: null as null | { files: string[]; untouched: unknown[] },
  setAfterRead: null as null | ((a: unknown) => void),
  state: null as null | { enabled: boolean; done: boolean; coding_prompt_tucked?: boolean; one_state?: boolean },
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    h.calls.push(path);
    if (path.startsWith("/api/personalization/documents?purpose=import"))
      return { ok: true, status: 201, json: async () => ({ document: { id: `doc-${h.calls.length}` } }) };
    if (path === "/api/knowledge/imports") {
      if (h.failImports > 0) {
        h.failImports -= 1;
        return { ok: false, status: 500, json: async () => ({}) };
      }
      const files = h.lists.length > 1 ? h.lists.shift()! : h.lists[0] ?? [];
      return { ok: true, status: 200, json: async () => ({ files, next_cursor: null }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("./SetupProvider", () => ({
  useSetupOptional: () => (h.imports ? { imports: h.imports, afterRead: h.afterRead, setAfterRead: h.setAfterRead, state: h.state } : null),
}));

import { ImportFlow } from "./ImportFlow";
import { IMPORT_POLL_MS, useImportReads } from "./importReads";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const readingFile = () => ({ id: "11111111-1111-1111-1111-111111111111", filename: "zavi-context.md", created_at: iso(2_000), extraction: { state: "reading", claim_id: "c" } });
const readFile = () => ({ id: "22222222-2222-2222-2222-222222222222", filename: "retro.md", created_at: iso(60_000), extraction: { state: "read", facts: 42, redactions: 2 } });
const importsCalls = () => h.calls.filter((c) => c === "/api/knowledge/imports").length;

beforeEach(() => {
  h.calls.length = 0;
  h.lists = [];
  h.imports = null;
  h.failImports = 0;
  h.afterRead = null;
  h.setAfterRead = null;
  h.state = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ImportFlow: drop and go", () => {
  it("step 1 finishes right after the upload: no read call, no waiting", async () => {
    const refresh = vi.fn(async () => {});
    h.imports = { files: [], refresh };
    const onUploaded = vi.fn();
    render(<ImportFlow onUploaded={onUploaded} onDone={vi.fn()} onSkip={vi.fn()} doneLabel="Continue" />);
    fireEvent.change(screen.getByTestId("import-input"), { target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(h.calls).toEqual(["/api/personalization/documents?purpose=import"]);
    expect(h.calls.some((c) => c.endsWith("/read"))).toBe(false);
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(onUploaded.mock.invocationCallOrder[0]);
  });

  it("a file the chooser refuses is never uploaded and the step stays open", async () => {
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    const onUploaded = vi.fn();
    render(<ImportFlow onUploaded={onUploaded} onDone={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByTestId("import-input"), { target: { files: [new File(["x"], "deck.pptx")] } });
    await screen.findByText("Couldn't read this one (save it as .pdf and drop it again)");
    expect(h.calls).toEqual([]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("a drop where one file stored and one failed keeps step 1 open with the reason and Continue", async () => {
    const refresh = vi.fn(async () => {});
    h.imports = { files: [readFile()].map((f) => ({ ...f, status: "done", facts: 42, redactions: 0, truncated: false, unclaimed: false })), refresh };
    const onUploaded = vi.fn();
    render(<ImportFlow onUploaded={onUploaded} onDone={vi.fn()} onSkip={vi.fn()} doneLabel="Continue" />);
    fireEvent.change(screen.getByTestId("import-input"), {
      target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" }), new File(["x"], "deck.pptx")] },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText("Couldn't read this one (save it as .pdf and drop it again)")).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("a mixed drop whose list refresh then fails still offers Continue (not Skip)", async () => {
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    render(<ImportFlow onUploaded={vi.fn()} onDone={vi.fn()} onSkip={vi.fn()} doneLabel="Continue" />);
    fireEvent.change(screen.getByTestId("import-input"), {
      target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" }), new File(["x"], "deck.pptx")] },
    });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip this step" })).toBeNull();
  });

  it("after setup, a new upload becomes the file the read note is about once the tracked ones settled", async () => {
    const setAfterRead = vi.fn();
    h.setAfterRead = setAfterRead;
    h.afterRead = { files: ["22222222-2222-2222-2222-222222222222"], untouched: [] };
    h.imports = { files: [readFile()].map((f) => ({ ...f, status: "done", facts: 42, redactions: 0, truncated: false, unclaimed: false })), refresh: vi.fn(async () => {}) };
    render(<ImportFlow onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId("import-input"), { target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(setAfterRead).toHaveBeenCalledWith({ files: ["doc-1"], untouched: [] }));
  });

  it("after setup finished with no read open, a new upload starts being tracked", async () => {
    const setAfterRead = vi.fn();
    h.setAfterRead = setAfterRead;
    h.afterRead = null;
    h.state = { enabled: true, done: true };
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    render(<ImportFlow onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId("import-input"), { target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(setAfterRead).toHaveBeenCalledWith({ files: ["doc-1"], untouched: [] }));
  });

  it("after setup, a new upload joins the tracked files while one is still reading", async () => {
    const setAfterRead = vi.fn();
    h.setAfterRead = setAfterRead;
    h.afterRead = { files: ["11111111-1111-1111-1111-111111111111"], untouched: [] };
    h.imports = { files: [readingFile()].map((f) => ({ ...f, status: "reading", facts: 0, redactions: 0, truncated: false, unclaimed: false })), refresh: vi.fn(async () => {}) };
    render(<ImportFlow onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId("import-input"), { target: { files: [new File(["# notes"], "notes.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(setAfterRead).toHaveBeenCalledWith({ files: ["11111111-1111-1111-1111-111111111111", "doc-1"], untouched: [] }));
  });

  it("Skip calls onSkip straight away, with no dialog", async () => {
    const { confirmAction } = await import("@/components/ui/ConfirmDialog");
    vi.mocked(confirmAction).mockClear();
    const onSkip = vi.fn();
    render(<ImportFlow onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(confirmAction).not.toHaveBeenCalled();
  });
  it("the Claude Code / Codex prompt is open by default with Copy, and can be hidden", () => {
    render(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId("bundle-help").textContent).toContain("zavi-context.md");
    expect(screen.getByRole("button", { name: "Copy prompt" }).className).toContain("whitespace-nowrap");
    expect(screen.getByText(/You are helping me brief Zavi/)).toBeTruthy();
    const hide = screen.getByRole("button", { name: /Hide the prompt/ });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(screen.queryByText(/You are helping me brief Zavi/)).toBeNull();
  });
});

describe("B11: a founder with no code project is never asked to run a coding-tool prompt", () => {
  const tuckedSetup = () => {
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    h.state = { enabled: true, done: false, coding_prompt_tucked: true };
  };
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("step 1 shows no Claude Code, Codex, CLAUDE.md or git log text, and nothing reaches the clipboard", () => {
    tuckedSetup();
    const { container } = render(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} doneLabel="Continue" />);
    const text = container.textContent ?? "";
    for (const bad of ["Claude Code", "Codex", "CLAUDE.md", "AGENTS.md", "git log", "You are helping me brief Zavi"]) expect(text).not.toContain(bad);
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
    expect(screen.queryByTestId("bundle-help")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a founder who does have a code project opens the fold and still gets the prompt and Copy", () => {
    tuckedSetup();
    render(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} />);
    const fold = screen.getByRole("button", { name: /Have a code project\? Get a prompt for your coding tool/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/You are helping me brief Zavi/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("You are helping me brief Zavi"));
    fireEvent.click(fold);
    expect(screen.queryByText(/You are helping me brief Zavi/)).toBeNull();
  });

  it("a setup status that lands after the first paint folds the prompt away", () => {
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    h.state = null;
    const { rerender } = render(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} />);
    h.state = { enabled: true, done: false, coding_prompt_tucked: true };
    rerender(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.queryByText(/You are helping me brief Zavi/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("with the key off (no flag on the status) the prompt shows open with Copy, exactly as before", () => {
    h.imports = { files: [], refresh: vi.fn(async () => {}) };
    h.state = { enabled: true, done: false };
    render(<ImportFlow onDone={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Have a code project/ })).toBeNull();
    expect(screen.getByText("Using Claude Code or Codex?")).toBeTruthy();
    expect(screen.getByText(/You are helping me brief Zavi/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy();
  });
});

function Harness({ onDone, enabled = true }: { onDone: () => void; enabled?: boolean }) {
  const imports: ImportReads = useImportReads(enabled);
  h.imports = imports;
  return <ImportFlow onDone={onDone} onSkip={vi.fn()} doneLabel="Continue" />;
}

describe("the server is the source of truth (a reload shows the same list)", () => {
  it("mount with one reading and one read file renders both without any upload, and polls only because one is reading", async () => {
    vi.useFakeTimers();
    h.lists = [[readingFile(), readFile()]];
    render(<Harness onDone={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("zavi-context.md")).toBeTruthy();
    expect(screen.getByText("retro.md")).toBeTruthy();
    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.getByText("42 facts")).toBeTruthy();
    expect(screen.getByText("I removed 2 things that looked like keys from retro.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(h.calls.some((c) => c.startsWith("/api/personalization/documents"))).toBe(false);
    expect(importsCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS); });
    expect(importsCalls()).toBe(2);
  });

  it("the poll stops once nothing is reading", async () => {
    vi.useFakeTimers();
    const landed = { ...readingFile(), extraction: { state: "read", facts: 7, redactions: 0 } };
    h.lists = [[readingFile()], [landed]];
    render(<Harness onDone={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Reading")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS); });
    expect(screen.getByText("7 facts")).toBeTruthy();
    const after = importsCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 5); });
    expect(importsCalls()).toBe(after);
  });

  it("nothing reading on mount: one fetch, no poll", async () => {
    vi.useFakeTimers();
    h.lists = [[readFile()]];
    render(<Harness onDone={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 5); });
    expect(importsCalls()).toBe(1);
  });

  it("a failed first fetch is retried every tick until the list arrives, then stops", async () => {
    vi.useFakeTimers();
    h.failImports = 2;
    h.lists = [[readFile()]];
    render(<Harness onDone={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(importsCalls()).toBe(1);
    expect(screen.queryByText("retro.md")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS); });
    expect(importsCalls()).toBe(3);
    expect(screen.getByText("retro.md")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 5); });
    expect(importsCalls()).toBe(3);
  });

  it("dismissed (enabled false): no first fetch and no retry", async () => {
    vi.useFakeTimers();
    h.failImports = 5;
    render(<Harness onDone={vi.fn()} enabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 5); });
    expect(importsCalls()).toBe(0);
  });

  it("dismissed: an Add knowledge upload's reading file still polls until it settles, then stops", async () => {
    vi.useFakeTimers();
    const landed = { ...readingFile(), extraction: { state: "read", facts: 7, redactions: 0 } };
    h.lists = [[readingFile()], [landed]];
    render(<Harness onDone={vi.fn()} enabled={false} />);
    await act(async () => { await h.imports!.refresh(); });
    expect(screen.getByText("Reading")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS); });
    expect(screen.getByText("7 facts")).toBeTruthy();
    const after = importsCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 5); });
    expect(importsCalls()).toBe(after);
  });
});
