// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    calls.push(path);
    return { ok: true, json: async () => ({ files: [] }) };
  }),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
let canManageSetup = true;
let importFiles: { id: string; status: string }[] | null = null;
vi.mock("../setup/SetupProvider", () => ({
  useSetupOptional: () => ({ state: { enabled: true, docs: { status: "done" } }, canManageSetup, imports: { files: importFiles, refresh: vi.fn(async () => {}) }, refresh: vi.fn(async () => {}) }),
}));
vi.mock("../setup/ImportFlow", () => ({ ImportFlow: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>I am done</button> }));
import { ImportedKnowledgeSection } from "./ImportedKnowledgeSection";
afterEach(() => { cleanup(); calls.length = 0; canManageSetup = true; importFiles = null; });

describe("ImportedKnowledgeSection Add knowledge", () => {
  it("an owner with no imports yet sees the section with Add knowledge, and the list reloads after the window closes", async () => {
    render(<ImportedKnowledgeSection readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add knowledge/ }));
    expect(screen.getByRole("dialog", { name: "Add knowledge" })).toBeTruthy();
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "I am done" }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.at(-1)).toBe("/api/knowledge/imports");
  });
  it("a member never sees the button", async () => {
    canManageSetup = false;
    const { container } = render(<ImportedKnowledgeSection readOnly />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /Add knowledge/ })).toBeNull();
    expect(container.firstChild).toBeNull();
  });
  it("an upload that lands after the window closed still reloads the list", async () => {
    importFiles = [];
    const { rerender } = render(<ImportedKnowledgeSection readOnly={false} />);
    await screen.findByRole("button", { name: /Add knowledge/ });
    const before = calls.length;
    importFiles = [{ id: "f1", status: "reading" }];
    rerender(<ImportedKnowledgeSection readOnly={false} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.at(-1)).toBe("/api/knowledge/imports");
  });
  it("a file the shared list says is still reading is labelled Reading, not Not read", async () => {
    importFiles = [{ id: "f1", status: "reading" }];
    const api = await import("@/lib/api");
    vi.mocked(api.apiFetch).mockImplementation((async (path: string) => {
      calls.push(path);
      return { ok: true, json: async () => ({ files: [{ id: "f1", filename: "plan.pdf", size_bytes: 10, extraction: null, facts: [] }] }) };
    }) as never);
    render(<ImportedKnowledgeSection readOnly={false} />);
    expect(await screen.findByText(/Reading\.\.\./)).toBeTruthy();
    expect(screen.queryByText("Not read")).toBeNull();
  });
});
